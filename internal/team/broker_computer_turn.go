package team

// broker_computer_turn.go: what happens to a bot's computer around one
// headless turn. Mount resolves the destination, makes sure the desktop is
// awake, claims the lease, starts the screen poller, and returns the MCP
// launch spec the runner writes into the bot's config. Release stops the
// poller, settles the final frame into the bot stream, and arms idle.

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/computer"
)

// computerToolPrefix is how a computer tool call is recognized in the
// runner's event stream (mcp__computer__click and friends).
const computerToolPrefix = "mcp__computer__"

var (
	screenPollInterval = 6 * time.Second
	screenPollMinGap   = 3 * time.Second
)

// computerMount is one turn's handle on its computer.
type computerMount struct {
	slug   string
	turnID string
	taskID string
	target computer.Target
	Launch computer.MCPLaunch
	poller *screenPoller
}

// Env is the environment the bridge process needs, keyed by name, so both
// runners can append it to the bot CLI's own env.
func (m *computerMount) Env() map[string]string {
	if m == nil {
		return nil
	}
	return m.Launch.Env
}

// mountForTurn prepares the bot's computer for a turn. It returns nil,
// nil when the bot has no computer; a non-nil error means the bot was
// promised a computer and it could not be delivered.
func (s *computerService) mountForTurn(ctx context.Context, slug, turnID, taskID, controlURL, controlToken string) (*computerMount, error) {
	m, ok := s.member(slug)
	if !ok {
		return nil, nil
	}
	dest := s.destinationFor(ctx, m)
	switch dest {
	case computerOff:
		return nil, nil
	case computerCloud:
		// Cloud mounts are wired by broker_computer_box.go; absent that,
		// the bot runs without a computer this turn.
		if s.boxMount == nil {
			s.setState(slug, "unconfigured", "Cloud computers need an ascii.dev Box API key in Settings")
			return nil, nil
		}
		return s.boxMount(ctx, slug, turnID, taskID, controlURL, controlToken)
	}
	rt := s.runtimeStatus(ctx, true)
	if !rt.DaemonUp {
		s.setState(slug, "runtime_missing", rt.Problem)
		return nil, nil
	}
	target := s.target(slug)
	st := s.inspector.Inspect(ctx, rt, target)
	if !st.Image {
		s.setState(slug, "image_missing", st.Problem)
		return nil, nil
	}
	lease := s.leases.For(target.Key)
	if !lease.Claim(turnID, slug, s.botBusy, time.Now()) {
		return nil, errLeaseHeld
	}
	if st.Container == computer.ContainerMissing || st.Container == computer.ContainerStopped {
		if err := s.provision(ctx, slug); err != nil {
			lease.Release(turnID)
			return nil, err
		}
		s.setState(slug, "starting", "")
		if _, err := s.waitReady(ctx, slug, computerReadyWait); err != nil {
			lease.Release(turnID)
			s.setState(slug, "error", err.Error())
			return nil, err
		}
	} else if !st.Ready {
		if _, err := s.waitReady(ctx, slug, computerReadyWait); err != nil {
			lease.Release(turnID)
			s.setState(slug, "error", err.Error())
			return nil, err
		}
	}
	s.idleFor(slug).Touch()
	binary, err := os.Executable()
	if err != nil {
		lease.Release(turnID)
		return nil, err
	}
	launch := computer.ContainerMCPLaunch(binary, rt.Runtime, target, computer.ControlEndpoint{URL: controlURL, Token: controlToken})
	mount := &computerMount{slug: slug, turnID: turnID, taskID: taskID, target: target, Launch: launch}
	mount.poller = s.startPoller(slug, func(ctx context.Context) (computer.Frame, error) {
		return computer.Screenshot(ctx, s.runner, rt.Runtime, target)
	}, func() { lease.Touch(turnID, time.Now()) })
	s.mu.Lock()
	s.turnEnv[slug] = launch.Env
	s.mu.Unlock()
	s.statusFor(ctx, slug)
	return mount, nil
}

var errLeaseHeld = &computer.LifecycleError{Status: 409, Message: "this bot's computer is already in use by another turn"}

// releaseTurn tears the mount down and settles the final frame.
func (s *computerService) releaseTurn(m *computerMount) {
	if m == nil {
		return
	}
	s.mu.Lock()
	delete(s.turnEnv, m.slug)
	s.mu.Unlock()
	frame := s.stopPoller(m.slug)
	s.leases.For(m.target.Key).Release(m.turnID)
	s.idleFor(m.slug).Touch()
	if frame != nil {
		s.storeFrame(m.slug, *frame, true)
		if stream := s.b.BotStream(m.slug); stream != nil {
			line, _ := json.Marshal(map[string]any{
				"kind":     "computer_frame",
				"slug":     m.slug,
				"data_url": frame.DataURL,
				"at":       frame.At.UnixMilli(),
				"final":    true,
			})
			stream.PushTask(m.taskID, string(line)+"\n")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s.statusFor(ctx, m.slug)
}

// poke asks the poller for a fresh frame now: the bot just acted.
func (s *computerService) poke(slug string) {
	s.mu.Lock()
	p := s.pollers[slug]
	s.mu.Unlock()
	if p != nil {
		p.poke()
	}
}

// isComputerTool reports whether a runner tool name is a computer action.
func isComputerTool(name string) bool {
	return strings.HasPrefix(strings.TrimSpace(name), computerToolPrefix)
}

// ── screen poller ───────────────────────────────────────────────────────

// screenPoller captures the bot's screen while a turn runs. A slow interval,
// a floor between captures, never two in flight, and no captures while the
// person holds the wheel (they may be typing a password).
type screenPoller struct {
	slug    string
	capture func(ctx context.Context) (computer.Frame, error)
	onFrame func(frame computer.Frame)
	held    func() bool
	touched func()

	mu       sync.Mutex
	last     *computer.Frame
	lastAt   time.Time
	inFlight bool
	usedShot bool
	stop     chan struct{}
	done     chan struct{}
}

func (s *computerService) startPoller(slug string, capture func(ctx context.Context) (computer.Frame, error), touch func()) *screenPoller {
	s.stopPoller(slug)
	p := &screenPoller{
		slug:    slug,
		capture: capture,
		onFrame: func(f computer.Frame) { s.storeFrame(slug, f, true) },
		held:    func() bool { return s.control.Snapshot(slug).Held },
		touched: touch,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	s.mu.Lock()
	s.pollers[slug] = p
	s.mu.Unlock()
	go p.run()
	return p
}

func (s *computerService) stopPoller(slug string) *computer.Frame {
	s.mu.Lock()
	p := s.pollers[slug]
	delete(s.pollers, slug)
	s.mu.Unlock()
	if p == nil {
		return nil
	}
	return p.finish()
}

func (p *screenPoller) run() {
	defer close(p.done)
	ticker := time.NewTicker(screenPollInterval)
	defer ticker.Stop()
	p.captureOnce(false)
	for {
		select {
		case <-p.stop:
			return
		case <-ticker.C:
			p.captureOnce(false)
		}
	}
}

// pokeDelay lets the action land before the frame is taken.
var pokeDelay = 1500 * time.Millisecond

func (p *screenPoller) poke() {
	p.mu.Lock()
	p.usedShot = true
	p.mu.Unlock()
	go func() {
		select {
		case <-p.stop:
			return
		case <-time.After(pokeDelay):
		}
		p.captureOnce(false)
	}()
}

func (p *screenPoller) captureOnce(force bool) {
	if p.held() {
		return
	}
	p.mu.Lock()
	if p.inFlight || (!force && time.Since(p.lastAt) < screenPollMinGap) {
		p.mu.Unlock()
		return
	}
	p.inFlight = true
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), computer.ScreenshotTimeout+5*time.Second)
	frame, err := p.capture(ctx)
	cancel()
	p.mu.Lock()
	p.inFlight = false
	p.lastAt = time.Now()
	if err == nil {
		f := frame
		p.last = &f
	}
	p.mu.Unlock()
	if err == nil {
		p.onFrame(frame)
		if p.touched != nil {
			p.touched()
		}
	}
}

// finish stops polling, takes one last settled frame when the turn touched
// the screen, and returns it.
func (p *screenPoller) finish() *computer.Frame {
	select {
	case <-p.stop:
	default:
		close(p.stop)
	}
	<-p.done
	p.mu.Lock()
	used := p.usedShot
	p.mu.Unlock()
	if !used {
		return nil
	}
	p.captureOnce(true)
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.last
}

// computerPromptHint is appended to the bot's system prompt when a
// computer is mounted for the turn.
func computerPromptHint(dest string) string {
	switch dest {
	case computerSandbox:
		return "\nYOUR COMPUTER: You have your own isolated Linux desktop in a container reserved for you, reached through the `computer` tools (mcp__computer__*). Only " + computer.WorkspaceGuest + " is durable; save downloads, repositories, working files, and browser logins there because everything else inside the machine is disposable. No host folder is mounted. Inspect the desktop state before acting, prefer accessibility targets over raw coordinates, take a screenshot after each meaningful step, and act carefully. If you need a person to log in, solve a CAPTCHA, or make a call, use computer_request_help and wait.\n"
	case computerCloud:
		return "\nYOUR COMPUTER: You have your own cloud Linux desktop, reached through the `computer` tools (mcp__computer__*). Its disk persists between sessions. Take a screenshot before acting, act carefully, and use computer_request_help when a person must step in.\n"
	}
	return ""
}
