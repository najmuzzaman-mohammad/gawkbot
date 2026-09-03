package teammcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestTeamTaskAssignRoutesToReassign pins the verb mapping.
//
// The broker exposes two ways to move a task to a different owner and they are
// not equivalent: "assign" is a copy of "claim" (forces status to in_progress,
// notifies nobody), while "reassign" leaves a done/review task where it is and
// tells the previous owner they lost it. The tool-level verb "assign" means
// "hand this to someone else", so it must land on reassign. Before this
// mapping it landed on the worse twin, silently dropping the hand-off notice
// and resurrecting finished work.
func TestTeamTaskAssignRoutesToReassign(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WUPHF_AGENT_SLUG", "ceo")

	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"task": map[string]any{"id": "OFFICE-1"}})
	}))
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	if _, _, err := handleTeamTask(context.Background(), nil, TeamTaskArgs{
		Action: "assign", ID: "OFFICE-1", Owner: "designer", MySlug: "ceo",
	}); err != nil {
		t.Fatalf("assign returned a transport error: %v", err)
	}
	if a, _ := got["action"].(string); a != "reassign" {
		t.Errorf("action = %q, want reassign (assign must not hit the notify-nobody twin)", a)
	}
	if o, _ := got["owner"].(string); o != "designer" {
		t.Errorf("owner = %q, want designer", o)
	}
}

// TestTeamTaskClaimTakesItForMe is assign's counterpart: claim ignores the
// owner arg entirely and always names the calling bot, so the two verbs stay
// distinct concepts rather than two spellings of one.
func TestTeamTaskClaimTakesItForMe(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WUPHF_AGENT_SLUG", "designer")

	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"task": map[string]any{"id": "OFFICE-1"}})
	}))
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	if _, _, err := handleTeamTask(context.Background(), nil, TeamTaskArgs{
		Action: "claim", ID: "OFFICE-1", Owner: "someone-else", MySlug: "designer",
	}); err != nil {
		t.Fatalf("claim returned a transport error: %v", err)
	}
	if a, _ := got["action"].(string); a != "claim" {
		t.Errorf("action = %q, want claim", a)
	}
	if o, _ := got["owner"].(string); o != "designer" {
		t.Errorf("owner = %q, want the caller (claim must ignore the owner arg)", o)
	}
}
