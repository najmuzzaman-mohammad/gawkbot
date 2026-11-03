package team

// broker_notch_dock.go: the Stop button on a working bot's card at the top
// right of the screen (web/src/notch/NotchDock.tsx). POST /notch/stop
// {slug} ends that one bot's running turns and nothing else: unlike the
// governor's stop it does not pause the office, so the other bots keep
// working and the stopped one takes its next message as usual. Owner only.

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

type notchStopRequest struct {
	Slug string `json:"slug"`
}

func (b *Broker) handleNotchStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner may stop a bot"})
		return
	}
	var req notchStopRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	slug := strings.TrimSpace(req.Slug)
	if slug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "which bot?"})
		return
	}
	var ctl headlessDispatchController
	if b.governor != nil {
		ctl = b.governor.controller()
	}
	if ctl == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "nothing is running turns"})
		return
	}
	ctl.CancelHeadlessTurns(slug)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "slug": slug})
}
