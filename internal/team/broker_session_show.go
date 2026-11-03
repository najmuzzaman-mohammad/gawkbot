package team

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/termsend"
)

// POST /agents/local/sessions/show {"slug": "..."} — opens a terminal
// session where it runs, so the person can read it there in full: its
// Superset terminal, Terminal or iTerm2 tab, or tmux pane; its thread in the
// Codex app; or, for a Claude Code session whose window is gone, a new
// Terminal window resuming it. Owner-only. Nothing is typed into a session.

type sessionShowResponse struct {
	// Route says where it opened: superset, terminal, iterm, tmux, codex,
	// or resumed.
	Route string `json:"route"`
}

// Swapped by tests.
var (
	sessionShowFn = func(ctx context.Context, pid int, tool string) (string, error) {
		return termsend.New().Show(ctx, termsend.Target{PID: pid, Tool: tool})
	}
	sessionResumeFn = func(ctx context.Context, tool, id, cwd string) error {
		return termsend.New().ResumeInTerminal(ctx, tool, id, cwd)
	}
	sessionOpenLinkFn = func(ctx context.Context, link string) error {
		return exec.CommandContext(ctx, "open", link).Run()
	}
)

// sessionStillWriting is how recently a log written means the session is
// live whatever the registry says: resuming it then would fork it.
const sessionStillWriting = 2 * time.Minute

func (b *Broker) handleSessionShow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		Slug string `json:"slug"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	b.mu.Lock()
	m := b.findMemberLocked(strings.TrimSpace(req.Slug))
	var bind struct{ tool, id, native, cwd string }
	if m != nil && isSessionMember(*m) && m.Provider.Session != nil {
		s := m.Provider.Session
		bind.tool, bind.id, bind.native, bind.cwd = s.Tool, s.SessionID, firstNonEmpty(s.NativeID, sessionNativeID(s.SessionID)), s.Cwd
	}
	b.mu.Unlock()
	if bind.id == "" || bind.native == "" {
		http.Error(w, "not a terminal session", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	route, err := showSession(ctx, bind.tool, bind.id, bind.native, bind.cwd)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, sessionShowResponse{Route: route})
}

func showSession(ctx context.Context, tool, id, native, cwd string) (string, error) {
	if tool == termsend.ToolCodex {
		// The Codex app opens any of its threads, wherever it was started.
		if err := sessionOpenLinkFn(ctx, "codex://threads/"+native); err != nil {
			return "", errors.New("the Codex app did not open")
		}
		return "codex", nil
	}
	if tool != termsend.ToolClaudeCode {
		return "", errors.New("this session's tool cannot be opened from here")
	}
	open, known := sessionOpenNowFn(ctx)
	if !known {
		return "", errors.New("cannot tell whether its window is open right now; try again in a moment")
	}
	if entry, isOpen := open[id]; isOpen {
		if !entry.Interactive || entry.PID <= 1 {
			return "", errors.New("it runs in a background process, with no window to open")
		}
		route, err := sessionShowFn(ctx, entry.PID, tool)
		switch {
		case errors.Is(err, termsend.ErrNotPermitted):
			return "", errors.New("macOS has not let gawkbot control your terminal app; allow it in System Settings, Privacy & Security, Automation")
		case err != nil:
			return "", errors.New("could not find the window it runs in")
		}
		return route, nil
	}
	if last, found := sessionLogLastWriteFn(native); found && time.Since(last) < sessionStillWriting {
		return "", errors.New("it is still writing to its log, so it is open somewhere; it was not reopened")
	}
	if err := sessionResumeFn(ctx, tool, native, cwd); err != nil {
		return "", errors.New("could not open a Terminal window to resume it")
	}
	return "resumed", nil
}
