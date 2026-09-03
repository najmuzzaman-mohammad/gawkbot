package team

// broker_computer.go owns the broker side of "every bot gets a computer":
// one computerService per broker that resolves a bot's destination
// (sandbox on this machine, cloud box, or off), composes the ComputerStatus
// the web UI renders, applies lifecycle actions, fans `computer` events out
// over SSE, and hands turns their MCP mount (broker_computer_turn.go). The
// container mechanics live in internal/computer.

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nex-crm/wuphf/internal/computer"
	"github.com/nex-crm/wuphf/internal/computer/box"
	"github.com/nex-crm/wuphf/internal/config"
)

// Destination values stored on officeMember.Computer. Empty means auto.
const (
	computerOff     = "off"
	computerSandbox = "sandbox"
	computerCloud   = "cloud"
)

// computerEvent is the SSE `computer` payload (spec: wire contract).
type computerEvent struct {
	Slug       string  `json:"slug"`
	State      string  `json:"state"`
	Problem    string  `json:"problem,omitempty"`
	Message    string  `json:"message,omitempty"`
	Frame      string  `json:"frame,omitempty"`
	At         int64   `json:"at,omitempty"`
	Held       *bool   `json:"held,omitempty"`
	HelpReason *string `json:"help_reason,omitempty"`
}

// computerStatusPayload is GET /computer/{slug}.
type computerStatusPayload struct {
	Slug          string                `json:"slug"`
	Destination   string                `json:"destination"`
	CloudBackend  string                `json:"cloud_backend"`
	State         string                `json:"state"`
	Problem       *string               `json:"problem"`
	Busy          bool                  `json:"busy"`
	ViewerURL     *string               `json:"viewer_url"`
	Control       computerControlView   `json:"control"`
	LastFrame     *computerFramePayload `json:"last_frame"`
	ContainerName *string               `json:"container_name"`
	WorkspaceDir  *string               `json:"workspace_dir"`
	Box           *computerBoxView      `json:"box"`
}

type computerControlView struct {
	Held       bool    `json:"held"`
	HelpReason *string `json:"help_reason"`
}

type computerFramePayload struct {
	DataURL string `json:"data_url"`
	At      int64  `json:"at"`
}

type computerBoxView struct {
	BoxID string `json:"box_id"`
	State string `json:"state"`
}

// computerRuntimePayload is GET /computer/runtime.
type computerRuntimePayload struct {
	Available        bool    `json:"available"`
	Runtime          string  `json:"runtime"`
	DaemonUp         bool    `json:"daemon_up"`
	Image            bool    `json:"image"`
	ImageRef         string  `json:"image_ref"`
	DriverVersion    string  `json:"driver_version"`
	Building         bool    `json:"building"`
	InstallHint      string  `json:"install_hint"`
	RuntimeStartHint string  `json:"runtime_start_hint"`
	Problem          *string `json:"problem"`
}

// computerRuntimeAllowed gates every real container runtime call. Tests flip
// it off (worktree_guard_test.go, DisableRealTaskWorktreeForTests) so a
// turn under `go test` can never create a container on the developer's
// Docker; the 2026-09-02 fresh-office run found two containers left by the
// suite and refused the one whose name matched its own bot.
var computerRuntimeAllowed atomic.Bool

func init() { computerRuntimeAllowed.Store(true) }

var (
	computerRuntimeCacheTTL = 15 * time.Second
	computerIdleTimeout     = 10 * time.Minute
	computerLeaseTTL        = 90 * time.Second
	computerReadyWait       = 120 * time.Second
)

type computerService struct {
	b         *Broker
	platform  string
	runner    computer.Runner
	stream    computer.StreamRunner
	inspector *computer.Inspector
	manager   *computer.Manager
	control   *computer.Control
	leases    *computer.LeasePool
	signer    *computer.ViewerSigner
	root      string
	// allowRuntime is captured at construction; test brokers that inject a
	// scripted runner set it back to true.
	allowRuntime bool

	mu             sync.Mutex
	runtime        computer.RuntimeStatus
	runtimeAt      time.Time
	building       bool
	buildLines     []string
	frames         map[string]computer.Frame
	states         map[string]string
	viewerPorts    map[string]viewerPortCache
	idle           map[string]*computer.IdleTimer
	pollers        map[string]*screenPoller
	turnEnv        map[string]map[string]string
	subscribers    map[int]chan computerEvent
	nextSubID      int
	boxStatusFor   func(ctx context.Context, slug string) (*computerBoxView, string)
	boxMount       func(ctx context.Context, slug, turnID, taskID, controlURL, controlToken string) (*computerMount, error)
	boxAction      func(w http.ResponseWriter, r *http.Request, slug, action string)
	boxClientCache *box.Client
	boxViewers     map[string]boxViewerCache
}

// boxViewerCache remembers the provider's desktop link so status reads do
// not mint one per poll; a changed link would reload the iframe.
type boxViewerCache struct {
	boxID string
	url   string
	at    time.Time
}

// boxViewerMaxAge is how long a provider desktop link is reused.
var boxViewerMaxAge = 20 * time.Minute

// boxViewerURL returns the provider's live desktop page for a cloud box,
// shaped for viewing, minting it at most once per boxViewerMaxAge.
func (s *computerService) boxViewerURL(ctx context.Context, slug, boxID string) (string, error) {
	s.mu.Lock()
	cached, ok := s.boxViewers[slug]
	s.mu.Unlock()
	if ok && cached.boxID == boxID && time.Since(cached.at) < boxViewerMaxAge {
		return box.ViewerLink(cached.url, true), nil
	}
	c := s.boxClient()
	if c == nil {
		return "", nil
	}
	linkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	raw, err := c.DesktopURL(linkCtx, boxID, 8*time.Second)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if s.boxViewers == nil {
		s.boxViewers = map[string]boxViewerCache{}
	}
	s.boxViewers[slug] = boxViewerCache{boxID: boxID, url: raw, at: time.Now()}
	s.mu.Unlock()
	return box.ViewerLink(raw, true), nil
}

type viewerPortCache struct {
	port     int
	password string
	at       time.Time
}

func computersRoot() string {
	if root := strings.TrimSpace(os.Getenv("WUPHF_COMPUTERS_DIR")); root != "" {
		return root
	}
	if home := config.RuntimeHomeDir(); home != "" {
		return filepath.Join(home, config.RuntimeDirName, "computers")
	}
	return filepath.Join(config.RuntimeDirName, "computers")
}

// computers returns the broker's computer service, creating it on first use
// so the constructor stays untouched.
func (b *Broker) computers() *computerService {
	b.computerOnce.Do(func() {
		inspector := &computer.Inspector{Run: computer.ExecRunner, Platform: runtime.GOOS}
		s := &computerService{
			b:            b,
			platform:     runtime.GOOS,
			runner:       computer.ExecRunner,
			stream:       computer.ExecStreamRunner,
			inspector:    inspector,
			manager:      &computer.Manager{Run: computer.ExecRunner, Inspector: inspector, Platform: runtime.GOOS},
			control:      &computer.Control{},
			leases:       computer.NewLeasePool(computerLeaseTTL),
			signer:       computer.NewViewerSigner(),
			root:         computersRoot(),
			allowRuntime: computerRuntimeAllowed.Load(),
			frames:       map[string]computer.Frame{},
			states:       map[string]string{},
			viewerPorts:  map[string]viewerPortCache{},
			idle:         map[string]*computer.IdleTimer{},
			pollers:      map[string]*screenPoller{},
			turnEnv:      map[string]map[string]string{},
			subscribers:  map[int]chan computerEvent{},
		}
		s.control.OnChange = func(slug string, snap computer.Snapshot) {
			held := snap.Held
			s.publish(computerEvent{Slug: slug, State: s.lastState(slug), Held: &held, HelpReason: snap.HelpReason})
		}
		s.installBoxHooks()
		b.computerService = s
	})
	return b.computerService
}

// ── events ─────────────────────────────────────────────────────────────

func (s *computerService) subscribe(buffer int) (<-chan computerEvent, func()) {
	if buffer <= 0 {
		buffer = 1
	}
	ch := make(chan computerEvent, buffer)
	s.mu.Lock()
	id := s.nextSubID
	s.nextSubID++
	s.subscribers[id] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if existing, ok := s.subscribers[id]; ok {
			delete(s.subscribers, id)
			close(existing)
		}
		s.mu.Unlock()
	}
}

func (s *computerService) publish(evt computerEvent) {
	s.mu.Lock()
	if evt.Slug != "" && evt.State != "" {
		s.states[evt.Slug] = evt.State
	}
	subs := make([]chan computerEvent, 0, len(s.subscribers))
	for _, ch := range s.subscribers {
		subs = append(subs, ch)
	}
	s.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (s *computerService) lastState(slug string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.states[slug]
}

func (s *computerService) setState(slug, state, problem string) {
	if s.lastState(slug) == state && problem == "" {
		return
	}
	s.publish(computerEvent{Slug: slug, State: state, Problem: problem})
}

// ── runtime and image ──────────────────────────────────────────────────

func (s *computerService) runtimeStatus(ctx context.Context, fresh bool) computer.RuntimeStatus {
	if !s.allowRuntime {
		return computer.RuntimeStatus{Problem: "container runtimes are disabled in this process"}
	}
	s.mu.Lock()
	if !fresh && time.Since(s.runtimeAt) < computerRuntimeCacheTTL {
		rt := s.runtime
		s.mu.Unlock()
		return rt
	}
	s.mu.Unlock()
	rt := computer.DetectRuntime(ctx, s.runner, s.platform)
	s.mu.Lock()
	s.runtime, s.runtimeAt = rt, time.Now()
	s.mu.Unlock()
	return rt
}

func (s *computerService) imagePresent(ctx context.Context, rt computer.RuntimeStatus) bool {
	if !rt.DaemonUp {
		return false
	}
	st := s.inspector.Inspect(ctx, rt, computer.TargetFor("__probe__", s.root))
	return st.Image
}

func (s *computerService) runtimePayload(ctx context.Context) computerRuntimePayload {
	rt := s.runtimeStatus(ctx, false)
	s.mu.Lock()
	building := s.building
	s.mu.Unlock()
	p := computerRuntimePayload{
		Available:        rt.Available,
		Runtime:          string(rt.Runtime),
		DaemonUp:         rt.DaemonUp,
		ImageRef:         computer.Image,
		DriverVersion:    computer.CuaDriverVersion,
		Building:         building,
		InstallHint:      rt.InstallHint,
		RuntimeStartHint: rt.StartHint,
	}
	if rt.DaemonUp {
		p.Image = s.imagePresent(ctx, rt)
	}
	problem := rt.Problem
	if problem == "" && !p.Image && !building {
		problem = "Prepare the desktop image first"
	}
	if problem != "" {
		p.Problem = &problem
	}
	return p
}

// prepareImage builds the managed image in the background, streaming
// progress as `computer` events with an empty slug.
func (s *computerService) prepareImage(ctx context.Context) error {
	rt := s.runtimeStatus(ctx, true)
	if !rt.DaemonUp {
		return errors.New(firstNonEmpty(rt.Problem, "no container runtime is running"))
	}
	s.mu.Lock()
	if s.building {
		s.mu.Unlock()
		return errors.New("the desktop image is already being prepared")
	}
	s.building = true
	s.buildLines = nil
	s.mu.Unlock()
	s.publish(computerEvent{Slug: "", State: "building", Message: "Preparing the desktop image…"})
	go func() {
		bctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		err := computer.PrepareImage(bctx, rt.Runtime, s.stream, func(line string) {
			s.mu.Lock()
			s.buildLines = append(s.buildLines, line)
			if len(s.buildLines) > 200 {
				s.buildLines = s.buildLines[len(s.buildLines)-200:]
			}
			s.mu.Unlock()
			s.publish(computerEvent{Slug: "", State: "building", Message: line})
		})
		s.mu.Lock()
		s.building = false
		s.mu.Unlock()
		if err != nil {
			s.publish(computerEvent{Slug: "", State: "error", Problem: "Desktop image build failed: " + err.Error()})
			return
		}
		s.publish(computerEvent{Slug: "", State: "image_ready", Message: "Desktop image ready."})
	}()
	return nil
}

// ── member resolution ──────────────────────────────────────────────────

func (s *computerService) member(slug string) (officeMember, bool) {
	b := s.b
	b.mu.Lock()
	defer b.mu.Unlock()
	m := b.findMemberLocked(slug)
	if m == nil {
		return officeMember{}, false
	}
	return cloneOfficeMemberForRead(*m), true
}

func (s *computerService) botBusy(slug string) bool {
	b := s.b
	b.mu.Lock()
	defer b.mu.Unlock()
	snap, ok := b.activity[slug]
	return ok && strings.EqualFold(strings.TrimSpace(snap.Status), "active")
}

// destinationFor applies the default: an explicit setting wins; otherwise
// sandbox when a runtime daemon is up, else off.
func (s *computerService) destinationFor(ctx context.Context, m officeMember) string {
	switch strings.TrimSpace(m.Computer) {
	case computerOff, computerSandbox, computerCloud:
		return strings.TrimSpace(m.Computer)
	}
	if s.runtimeStatus(ctx, false).DaemonUp {
		return computerSandbox
	}
	return computerOff
}

func (s *computerService) target(slug string) computer.Target {
	return computer.TargetFor(slug, s.root)
}

// ── status ─────────────────────────────────────────────────────────────

func (s *computerService) statusFor(ctx context.Context, slug string) (computerStatusPayload, bool) {
	m, ok := s.member(slug)
	if !ok {
		return computerStatusPayload{}, false
	}
	dest := s.destinationFor(ctx, m)
	snap := s.control.Snapshot(slug)
	p := computerStatusPayload{
		Slug:         slug,
		Destination:  dest,
		CloudBackend: "box",
		Busy:         s.botBusy(slug),
		Control:      computerControlView{Held: snap.Held, HelpReason: snap.HelpReason},
	}
	s.mu.Lock()
	if f, ok := s.frames[slug]; ok {
		p.LastFrame = &computerFramePayload{DataURL: f.DataURL, At: f.At.UnixMilli()}
	}
	building := s.building
	s.mu.Unlock()
	setProblem := func(msg string) {
		if msg != "" {
			p.Problem = &msg
		}
	}
	switch dest {
	case computerOff:
		p.State = "off"
	case computerCloud:
		if s.boxStatusFor == nil {
			p.State = "unconfigured"
			setProblem("Cloud computers need an ascii.dev Box API key in Settings")
		} else {
			box, problem := s.boxStatusFor(ctx, slug)
			p.Box = box
			switch {
			case box == nil && problem != "":
				p.State = "unconfigured"
				setProblem(problem)
			case box == nil:
				p.State = "missing"
			case box.State == "archived" || box.State == "stopped":
				p.State = "asleep"
			case box.State == "idle" || box.State == "ready" || box.State == "running":
				p.State = "ready"
				// The panel shows the provider's own noVNC page live, at
				// the box's full resolution; frames stay for the stream
				// thumbnails and as the fallback when the link fails.
				if u, err := s.boxViewerURL(ctx, slug, box.BoxID); err != nil {
					setProblem("The box is up but its desktop link could not be created: " + err.Error())
				} else if u != "" {
					p.ViewerURL = &u
				}
				if frame, err := s.refreshBoxFrame(ctx, slug, box.BoxID); err != nil {
					setProblem("The box is up but could not take a screenshot yet: " + err.Error())
				} else if frame != nil {
					p.LastFrame = &computerFramePayload{DataURL: frame.DataURL, At: frame.At.UnixMilli()}
				}
			case box.State == "error":
				p.State = "error"
				setProblem(problem)
			default:
				p.State = "starting"
			}
		}
	default:
		rt := s.runtimeStatus(ctx, false)
		target := s.target(slug)
		name, dir := target.ContainerName, target.WorkspaceDir
		p.ContainerName, p.WorkspaceDir = &name, &dir
		switch {
		case !rt.DaemonUp:
			p.State = "runtime_missing"
			setProblem(rt.Problem)
		case building:
			p.State = "building"
		default:
			st := s.inspector.Inspect(ctx, rt, target)
			switch {
			case !st.Image:
				p.State = "image_missing"
				setProblem(st.Problem)
			case st.Container == computer.ContainerMissing:
				p.State = "missing"
			case st.Container == computer.ContainerStopped && st.Managed && st.ImageMatches && st.Security != "unsafe":
				p.State = "asleep"
			case st.Ready:
				p.State = "ready"
				s.rememberViewer(slug, st.ViewerPort, st.ViewerPassword)
				u := s.signer.ViewerURL(slug, computer.PolicyView, st.ViewerPassword, time.Now())
				p.ViewerURL = &u
			case st.Container == computer.ContainerRunning && strings.Contains(st.Problem, "not ready yet"):
				p.State = "starting"
				setProblem(st.Problem)
			default:
				p.State = "error"
				setProblem(st.Problem)
			}
		}
	}
	s.setState(slug, p.State, "")
	return p, true
}

// boxFrameMaxAge is how old a cached cloud frame may be before a status
// read takes a fresh one.
var boxFrameMaxAge = 20 * time.Second

// refreshBoxFrame returns a fresh frame for a cloud box when the cached one
// is missing or stale. It returns nil, nil when the cache is fresh enough.
func (s *computerService) refreshBoxFrame(ctx context.Context, slug, boxID string) (*computer.Frame, error) {
	s.mu.Lock()
	cached, ok := s.frames[slug]
	busyPoller := s.pollers[slug] != nil
	s.mu.Unlock()
	if busyPoller || (ok && time.Since(cached.At) < boxFrameMaxAge) {
		return nil, nil
	}
	c := s.boxClient()
	if c == nil {
		return nil, nil
	}
	shotCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	raw, err := c.Screenshot(shotCtx, boxID)
	if err != nil {
		return nil, err
	}
	frame, err := computer.EncodePreview(raw, time.Now())
	if err != nil {
		return nil, err
	}
	s.storeFrame(slug, frame, true)
	return &frame, nil
}

func (s *computerService) rememberViewer(slug string, port int, password string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.viewerPorts[slug] = viewerPortCache{port: port, password: password, at: time.Now()}
}

// resolveViewer answers the proxy: the loopback port of a running desktop.
func (s *computerService) resolveViewer(slug string) (int, bool) {
	s.mu.Lock()
	c, ok := s.viewerPorts[slug]
	s.mu.Unlock()
	if ok && time.Since(c.at) < 30*time.Second {
		return c.port, true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rt := s.runtimeStatus(ctx, false)
	if !rt.DaemonUp {
		return 0, false
	}
	st := s.inspector.Inspect(ctx, rt, s.target(slug))
	if st.Container != computer.ContainerRunning || st.ViewerPort == 0 {
		return 0, false
	}
	s.rememberViewer(slug, st.ViewerPort, st.ViewerPassword)
	return st.ViewerPort, true
}

func (s *computerService) viewerPassword(slug string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.viewerPorts[slug].password
}

// ── lifecycle ──────────────────────────────────────────────────────────

func (s *computerService) apply(ctx context.Context, slug string, action computer.Action) error {
	rt := s.runtimeStatus(ctx, true)
	target := s.target(slug)
	if action == computer.ActionStop || action == computer.ActionRemove {
		if cur := s.leases.For(target.Key).Current(s.botBusy, time.Now()); cur != nil {
			return &computer.LifecycleError{Status: 409, Message: "this bot is using its computer — stop the turn first"}
		}
	}
	switch action {
	case computer.ActionRun:
		s.setState(slug, "provisioning", "")
	case computer.ActionStart:
		s.setState(slug, "waking", "")
	}
	_, err := s.manager.Apply(ctx, rt, action, target)
	s.mu.Lock()
	delete(s.viewerPorts, slug)
	if action == computer.ActionRemove {
		delete(s.frames, slug)
	}
	s.mu.Unlock()
	if err != nil {
		var lerr *computer.LifecycleError
		if !errors.As(err, &lerr) {
			s.setState(slug, "error", err.Error())
		}
		return err
	}
	switch action {
	case computer.ActionRun, computer.ActionStart:
		s.idleFor(slug).Touch()
	case computer.ActionStop, computer.ActionRemove:
		s.idleFor(slug).Cancel()
	}
	s.statusFor(ctx, slug)
	return nil
}

// provision creates a missing computer or wakes an asleep one.
func (s *computerService) provision(ctx context.Context, slug string) error {
	rt := s.runtimeStatus(ctx, true)
	if !rt.DaemonUp {
		return &computer.LifecycleError{Status: 409, Message: firstNonEmpty(rt.Problem, "no container runtime is running")}
	}
	st := s.inspector.Inspect(ctx, rt, s.target(slug))
	switch {
	case !st.Image:
		return &computer.LifecycleError{Status: 409, Message: "Prepare the desktop image first"}
	case st.Container == computer.ContainerMissing:
		return s.apply(ctx, slug, computer.ActionRun)
	case st.Container == computer.ContainerStopped:
		return s.apply(ctx, slug, computer.ActionStart)
	}
	return nil
}

// waitReady polls until the desktop answers or the budget runs out.
func (s *computerService) waitReady(ctx context.Context, slug string, budget time.Duration) (computer.Status, error) {
	rt := s.runtimeStatus(ctx, false)
	target := s.target(slug)
	deadline := time.Now().Add(budget)
	var last computer.Status
	for {
		s.inspector.Forget(target)
		last = s.inspector.Inspect(ctx, rt, target)
		if last.Ready {
			s.rememberViewer(slug, last.ViewerPort, last.ViewerPassword)
			return last, nil
		}
		if last.Container != computer.ContainerRunning || (last.DesktopError != "" && !last.Booting()) || !last.Managed || last.Security == "unsafe" {
			return last, errors.New(firstNonEmpty(last.Problem, "the computer failed to start"))
		}
		if time.Now().After(deadline) {
			return last, errors.New("the desktop did not become ready in time")
		}
		select {
		case <-ctx.Done():
			return last, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func (s *computerService) idleFor(slug string) *computer.IdleTimer {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.idle[slug]
	if !ok {
		t = computer.NewIdleTimer(computerIdleTimeout, func() bool { return s.botBusy(slug) }, func() error {
			ctx, cancel := context.WithTimeout(context.Background(), computer.LifecycleTimeout+10*time.Second)
			defer cancel()
			err := s.apply(ctx, slug, computer.ActionStop)
			var lerr *computer.LifecycleError
			if errors.As(err, &lerr) {
				return nil
			}
			return err
		})
		s.idle[slug] = t
	}
	return t
}

func (s *computerService) screenshot(ctx context.Context, slug string) (computer.Frame, error) {
	rt := s.runtimeStatus(ctx, false)
	frame, err := computer.Screenshot(ctx, s.runner, rt.Runtime, s.target(slug))
	if err != nil {
		return frame, err
	}
	s.storeFrame(slug, frame, true)
	return frame, nil
}

func (s *computerService) storeFrame(slug string, frame computer.Frame, broadcast bool) {
	s.mu.Lock()
	s.frames[slug] = frame
	s.mu.Unlock()
	if broadcast {
		s.publish(computerEvent{Slug: slug, State: s.lastState(slug), Frame: frame.DataURL, At: frame.At.UnixMilli()})
	}
}

func (s *computerService) exec(ctx context.Context, slug, command string) (computer.ExecResult, error) {
	rt := s.runtimeStatus(ctx, false)
	s.idleFor(slug).Touch()
	return computer.ExecShell(ctx, s.runner, rt.Runtime, s.target(slug), command)
}

func (s *computerService) forget(slug string) {
	s.control.Forget(slug)
	s.mu.Lock()
	delete(s.frames, slug)
	delete(s.states, slug)
	delete(s.viewerPorts, slug)
	s.mu.Unlock()
}
