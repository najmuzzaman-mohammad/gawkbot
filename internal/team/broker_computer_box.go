package team

// broker_computer_box.go plugs the ascii.dev Box backend into the computer
// service: status for the panel, the per-turn mount, and the lifecycle
// actions. A missing key leaves every hook nil, and the sandbox path is
// untouched.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/computer"
	"github.com/nex-crm/wuphf/internal/computer/box"
	"github.com/nex-crm/wuphf/internal/config"
)

// boxAPIBase is the provider endpoint, overridable for tests and stubs.
func boxAPIBase() string {
	if api := strings.TrimSpace(os.Getenv("WUPHF_BOX_API")); api != "" {
		return api
	}
	return box.DefaultAPI
}

// boxClient returns a client for the configured key, or nil.
func (s *computerService) boxClient() *box.Client {
	token := config.ResolveBoxAPIKey()
	if token == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.boxClientCache != nil && s.boxClientCache.Token == token {
		return s.boxClientCache
	}
	c := box.NewClient(token)
	c.API = boxAPIBase()
	s.boxClientCache = c
	return c
}

func (s *computerService) installBoxHooks() {
	s.boxStatusFor = func(ctx context.Context, slug string) (*computerBoxView, string) {
		c := s.boxClient()
		if c == nil {
			return nil, "Cloud computers need an ascii.dev Box API key in Settings"
		}
		b, err := c.Find(ctx, slug)
		if err != nil {
			return nil, err.Error()
		}
		if b == nil {
			return nil, ""
		}
		return &computerBoxView{BoxID: b.ID, State: b.State}, ""
	}
	s.boxMount = s.mountBoxForTurn
	s.boxAction = s.boxActionHandler
}

func (s *computerService) mountBoxForTurn(ctx context.Context, slug, turnID, taskID, controlURL, controlToken string) (*computerMount, error) {
	c := s.boxClient()
	if c == nil {
		s.setState(slug, "unconfigured", "Cloud computers need an ascii.dev Box API key in Settings")
		return nil, nil
	}
	m, _ := s.member(slug)
	b, err := c.Find(ctx, slug)
	if err != nil {
		return nil, err
	}
	if b == nil {
		s.setState(slug, "provisioning", "")
		if _, err := c.Provision(ctx, slug, firstNonEmpty(m.Name, slug)); err != nil {
			s.setState(slug, "error", err.Error())
			return nil, err
		}
		b, err = c.Find(ctx, slug)
		if err != nil || b == nil {
			return nil, firstError(err, errBoxVanished)
		}
	}
	if !b.Ready() {
		s.setState(slug, "waking", "")
		if _, err := c.WaitReady(ctx, b.ID, 90*time.Second); err != nil {
			s.setState(slug, "error", err.Error())
			return nil, err
		}
		_, _ = c.Run(ctx, b.ID, box.EnsureCuaCommand(), 15*time.Second)
	}
	binary, err := os.Executable()
	if err != nil {
		return nil, err
	}
	launch := box.MCPLaunch(binary, b.ID, c.Token, computer.ControlEndpoint{URL: controlURL, Token: controlToken})
	mount := &computerMount{slug: slug, turnID: turnID, taskID: taskID, Launch: launch, target: computer.Target{Key: "box:" + b.ID}}
	boxID := b.ID
	mount.poller = s.startPoller(slug, func(ctx context.Context) (computer.Frame, error) {
		raw, err := c.Screenshot(ctx, boxID)
		if err != nil {
			return computer.Frame{}, err
		}
		return computer.EncodePreview(raw, time.Now())
	}, nil)
	s.setState(slug, "ready", "")
	return mount, nil
}

var errBoxVanished = &computer.LifecycleError{Status: http.StatusBadGateway, Message: "the box disappeared right after it was created"}

func firstError(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

func (s *computerService) boxActionHandler(w http.ResponseWriter, r *http.Request, slug, action string) {
	c := s.boxClient()
	if c == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Cloud computers need an ascii.dev Box API key in Settings"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Minute)
	defer cancel()
	m, _ := s.member(slug)
	switch action {
	case "provision", "start":
		s.setState(slug, "provisioning", "")
		if _, err := c.Provision(ctx, slug, firstNonEmpty(m.Name, slug)); err != nil {
			s.setState(slug, "error", err.Error())
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
	case "sleep":
		if s.botBusy(slug) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "the computer is being used by this bot — interrupt the turn first"})
			return
		}
		if err := c.Sleep(ctx, slug); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
	case "remove":
		writeJSON(w, http.StatusConflict, map[string]string{"error": "the cloud box has no container to remove — use sleep instead"})
		return
	case "screenshot":
		b, err := c.Find(ctx, slug)
		if err != nil || b == nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "no computer for this bot yet"})
			return
		}
		raw, err := c.Screenshot(ctx, b.ID)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		frame, err := computer.EncodePreview(raw, time.Now())
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		s.storeFrame(slug, frame, true)
		writeJSON(w, http.StatusOK, map[string]string{"image": frame.DataURL})
		return
	case "exec":
		var body struct {
			Command string `json:"command"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
			return
		}
		res, err := c.Exec(ctx, slug, body.Command)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		code := 0
		if res.ExitCode != nil {
			code = *res.ExitCode
		}
		writeJSON(w, http.StatusOK, computer.ExecResult{ExitCode: code, Stdout: res.Stdout, Stderr: res.Stderr})
		return
	case "join":
		s.control.Take(slug)
		u, _, err := c.Join(ctx, slug)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"viewer_url": box.ViewerLink(u, false)})
		return
	case "control":
		var body struct {
			Action string `json:"action"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
			return
		}
		var snap computer.Snapshot
		switch body.Action {
		case "take":
			snap = s.control.Take(slug)
		case "release":
			snap = s.control.Release(slug)
		case "dismiss-help":
			snap = s.control.DismissHelp(slug)
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be take, release, or dismiss-help"})
			return
		}
		writeJSON(w, http.StatusOK, computerControlView{Held: snap.Held, HelpReason: snap.HelpReason})
		return
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such computer action"})
		return
	}
	status, _ := s.statusFor(ctx, slug)
	writeJSON(w, http.StatusOK, status)
}
