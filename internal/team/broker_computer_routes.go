package team

// broker_computer_routes.go: the HTTP surface from the wire contract in
// docs/specs/gawkbot-bot-computers.md. Every mutation requires a JSON
// content type so a hostile page cannot submit it as a simple form POST.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/computer"
)

func (b *Broker) registerComputerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/computer/runtime", b.requireAuth(b.handleComputerRuntime))
	mux.HandleFunc("/computer/runtime/prepare", b.requireAuth(b.handleComputerRuntimePrepare))
	mux.HandleFunc("/computer/box/signin/start", b.requireAuth(b.handleBoxSigninStart))
	mux.HandleFunc("/computer/box/signin/status", b.requireAuth(b.handleBoxSigninStatus))
	mux.HandleFunc("/computer/box/signin/cancel", b.requireAuth(b.handleBoxSigninCancel))
	mux.HandleFunc("/computer/box/signout", b.requireAuth(b.handleBoxSignout))
	mux.HandleFunc("/computer/box/account", b.requireAuth(b.handleBoxAccount))
	mux.HandleFunc("/computer/", b.requireAuth(b.handleComputerBot))
	mux.HandleFunc("/computer-control/", b.requireAuth(b.handleComputerControl))
}

func requireJSONBody(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "content-type must be application/json"})
		return false
	}
	return true
}

func writeComputerError(w http.ResponseWriter, err error) {
	var lerr *computer.LifecycleError
	if errors.As(err, &lerr) {
		writeJSON(w, lerr.Status, map[string]string{"error": lerr.Message})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func (b *Broker) handleComputerRuntime(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, b.computers().runtimePayload(ctx))
}

func (b *Broker) handleComputerRuntimePrepare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if !requireJSONBody(w, r) {
		return
	}
	if err := b.computers().prepareImage(r.Context()); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"building": true})
}

// handleComputerBot serves /computer/{slug} and /computer/{slug}/{action}.
func (b *Broker) handleComputerBot(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/computer/")
	slug, action, _ := strings.Cut(rest, "/")
	slug = strings.TrimSpace(slug)
	if slug == "" || slug == "runtime" || slug == "box" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such route"})
		return
	}
	svc := b.computers()
	if _, ok := svc.member(slug); !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such bot"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if action == "" {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		status, _ := svc.statusFor(ctx, slug)
		writeJSON(w, http.StatusOK, status)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if !requireJSONBody(w, r) {
		return
	}
	m, _ := svc.member(slug)
	dest := svc.destinationFor(ctx, m)
	if dest == computerCloud && svc.boxAction != nil {
		svc.boxAction(w, r, slug, action)
		return
	}
	if dest == computerOff && action != "control" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this bot's computer is off — choose Local VM or Cloud first"})
		return
	}
	switch action {
	case "provision":
		if err := svc.provision(ctx, slug); err != nil {
			writeComputerError(w, err)
			return
		}
	case "start":
		if err := svc.apply(ctx, slug, computer.ActionStart); err != nil {
			writeComputerError(w, err)
			return
		}
	case "sleep":
		if err := svc.apply(ctx, slug, computer.ActionStop); err != nil {
			writeComputerError(w, err)
			return
		}
	case "remove":
		if err := svc.apply(ctx, slug, computer.ActionRemove); err != nil {
			writeComputerError(w, err)
			return
		}
	case "screenshot":
		frame, err := svc.screenshot(ctx, slug)
		if err != nil {
			writeComputerError(w, err)
			return
		}
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
		res, err := svc.exec(ctx, slug, body.Command)
		if err != nil {
			writeComputerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	case "join":
		// Joining is the person taking the wheel: hold first, then mint a
		// control-policy viewer link.
		svc.control.Take(slug)
		if _, ok := svc.resolveViewer(slug); !ok {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "this computer is not running"})
			return
		}
		u := svc.signer.ViewerURL(slug, computer.PolicyControl, svc.viewerPassword(slug), time.Now())
		writeJSON(w, http.StatusOK, map[string]string{"viewer_url": u})
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
			snap = svc.control.Take(slug)
		case "release":
			snap = svc.control.Release(slug)
		case "dismiss-help":
			snap = svc.control.DismissHelp(slug)
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
	status, _ := svc.statusFor(ctx, slug)
	writeJSON(w, http.StatusOK, status)
}

// handleComputerControl is the bridge's loopback endpoint: GET reads who is
// driving, POST lets the bot open or expire its own help request. The bot
// has no verb to take or release.
func (b *Broker) handleComputerControl(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/computer-control/"))
	if slug == "" || strings.Contains(slug, "/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such route"})
		return
	}
	svc := b.computers()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, svc.control.Snapshot(slug))
	case http.MethodPost:
		var body struct {
			Action    string `json:"action"`
			Reason    string `json:"reason"`
			RequestID string `json:"request_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
			return
		}
		switch body.Action {
		case "request-help":
			id, snap := svc.control.RequestHelp(slug, truncate(body.Reason, 240))
			writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "held": snap.Held, "help_open": snap.HelpOpen})
		case "expire-help":
			snap := svc.control.ExpireHelp(slug, body.RequestID)
			writeJSON(w, http.StatusOK, snap)
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be request-help or expire-help"})
		}
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// viewerProxy is mounted on the web-UI port (no bearer, like artist files).
func (b *Broker) viewerProxy() http.Handler {
	svc := b.computers()
	return &computer.ViewerProxy{Signer: svc.signer, Resolve: svc.resolveViewer}
}
