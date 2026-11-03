package team

import (
	"net/http"
	"strings"

	"github.com/nex-crm/wuphf/internal/agentdetect"
)

// GET /agents/local/sessions/transcript?slug=<member> — a terminal session's
// own conversation, read from its log, so its page in gawkbot shows what
// was said in its terminal and not only what was sent from gawkbot.
// Owner-only, and checked here as well as by the allowlist: it is the
// owner's own work on their own machine.

type sessionTranscriptResponse struct {
	Turns []agentdetect.Turn `json:"turns"`
}

// sessionTranscriptFn reads the conversation of the session with this
// scanner id. Swapped by tests.
var sessionTranscriptFn = func(id, tool string) ([]agentdetect.Turn, bool) {
	path, ok := agentdetect.NewScanner().SessionLogFile(id)
	if !ok {
		return nil, false
	}
	turns, err := agentdetect.ReadTranscript(path, tool)
	return turns, err == nil
}

func (b *Broker) handleSessionTranscript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	slug := strings.TrimSpace(r.URL.Query().Get("slug"))
	b.mu.Lock()
	m := b.findMemberLocked(slug)
	id, tool := "", ""
	if m != nil && isSessionMember(*m) && m.Provider.Session != nil {
		id = m.Provider.Session.SessionID
		tool, _, _, _ = sessionBindingFields(*m)
	}
	b.mu.Unlock()
	if id == "" {
		http.Error(w, "not a terminal session", http.StatusNotFound)
		return
	}
	turns, ok := sessionTranscriptFn(id, tool)
	if !ok {
		// Its log is gone (deleted, or the tool cleaned it up): nothing to show.
		turns = []agentdetect.Turn{}
	}
	writeJSON(w, http.StatusOK, sessionTranscriptResponse{Turns: turns})
}
