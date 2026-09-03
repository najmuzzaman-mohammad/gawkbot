package teammcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestRequireTeamChannelApprovalBypassesWhenUnsafe pins the one escape hatch:
// an operator who launched with --unsafe (WUPHF_UNSAFE=1) has opted out of
// every approval gate, so channel creation proceeds without a card.
func TestRequireTeamChannelApprovalBypassesWhenUnsafe(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WUPHF_UNSAFE", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := requireTeamChannelApproval(ctx, "ceo", TeamChannelArgs{
		Channel: "growth", Name: "Growth", Description: "growth experiments",
	}); err != nil {
		t.Fatalf("WUPHF_UNSAFE=1 must bypass the channel-approval gate, got err=%v", err)
	}
}

// TestRequireTeamChannelApprovalProceedsOnApprove is the happy path: the gate
// raises a blocking approval, polls, and returns nil once the human approves —
// letting handleTeamChannel go on to create the channel. It also pins the card
// payload, because the card is the whole point of the gate: it must name the
// channel and carry a dedupe key so a retry loop cannot stack duplicates.
func TestRequireTeamChannelApprovalProceedsOnApprove(t *testing.T) {
	if testing.Short() {
		t.Skip("relies on the 1.5s poll tick; skip under -short")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WUPHF_UNSAFE", "")

	var sawRequest atomic.Bool
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/requests":
			sawRequest.Store(true)
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "req-channel-approve"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/interview/answer"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "answered",
				"answered": map[string]any{
					"choice_id":   "approve",
					"answered_at": "2026-08-22T12:00:00Z",
				},
			})
		default:
			http.Error(w, "stub: unhandled "+r.Method+" "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := requireTeamChannelApproval(ctx, "ceo", TeamChannelArgs{
		Channel: "growth", Name: "Growth", Description: "growth experiments",
		Members: []string{"gtm-lead"},
	}); err != nil {
		t.Fatalf("approved request must return nil, got err=%v", err)
	}
	if !sawRequest.Load() {
		t.Fatal("expected the gate to POST an approval request to /requests")
	}
	if got, _ := gotBody["blocking"].(bool); !got {
		t.Errorf("card must be blocking, got %v", gotBody["blocking"])
	}
	if got, _ := gotBody["dedupe_key"].(string); got != "channel-create:growth" {
		t.Errorf("dedupe_key = %q, want channel-create:growth (retries must collapse onto one card)", got)
	}
	if title, _ := gotBody["title"].(string); !strings.Contains(title, "#growth") {
		t.Errorf("title %q must name the channel", title)
	}
	if c, _ := gotBody["context"].(string); !strings.Contains(c, "growth experiments") {
		t.Errorf("context %q must carry the description the human decides on", c)
	}
}

// TestRequireTeamChannelApprovalBlocksOnReject is the hard gate: when the human
// declines, the gate returns an error naming the channel, so the CEO posts in an
// existing channel instead of creating one.
func TestRequireTeamChannelApprovalBlocksOnReject(t *testing.T) {
	if testing.Short() {
		t.Skip("relies on the 1.5s poll tick; skip under -short")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WUPHF_UNSAFE", "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/requests":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "req-channel-reject"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/interview/answer"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "answered",
				"answered": map[string]any{
					"choice_id":   "reject",
					"custom_text": "we already have #gtm",
					"answered_at": "2026-08-22T12:00:00Z",
				},
			})
		default:
			http.Error(w, "stub: unhandled "+r.Method+" "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := requireTeamChannelApproval(ctx, "ceo", TeamChannelArgs{Channel: "growth"})
	if err == nil {
		t.Fatal("a declined request must return an error so the channel is NOT created")
	}
	if !strings.Contains(err.Error(), "#growth") {
		t.Errorf("error %q must name the declined channel", err)
	}
	if !strings.Contains(err.Error(), "existing channel") {
		t.Errorf("error %q must route the bot to an existing channel", err)
	}
	if !strings.Contains(err.Error(), "we already have #gtm") {
		t.Errorf("error %q must carry the human's reason", err)
	}
}

// TestHandleTeamChannelGatesOnlyCreate pins the scope of the gate: create is
// blocked on approval, while remove and the conversational default path are
// not. Without this, a future refactor could quietly gate (or ungate) the wrong
// action. The stub broker answers "reject", so a gated call fails fast and an
// ungated one reaches /channels.
func TestHandleTeamChannelGatesOnlyCreate(t *testing.T) {
	if testing.Short() {
		t.Skip("relies on the 1.5s poll tick; skip under -short")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("WUPHF_UNSAFE", "")
	t.Setenv("WUPHF_AGENT_SLUG", "ceo")

	var channelWrites atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/channels":
			channelWrites.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		case r.Method == http.MethodPost && r.URL.Path == "/requests":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "req-scope"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/interview/answer"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":   "answered",
				"answered": map[string]any{"choice_id": "reject", "answered_at": "2026-08-22T12:00:00Z"},
			})
		default:
			http.Error(w, "stub: unhandled "+r.Method+" "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer srv.Close()
	withBrokerURL(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// create: gated, human declined -> no write to /channels.
	res, _, err := handleTeamChannel(ctx, nil, TeamChannelArgs{Action: "create", Channel: "growth", MySlug: "ceo"})
	if err != nil {
		t.Fatalf("handler returned a transport error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatal("a declined create must surface as a tool error")
	}
	if n := channelWrites.Load(); n != 0 {
		t.Fatalf("declined create must NOT write the channel, saw %d POST /channels", n)
	}

	// remove: not gated -> reaches the broker.
	if _, _, err := handleTeamChannel(ctx, nil, TeamChannelArgs{Action: "remove", Channel: "growth", MySlug: "ceo"}); err != nil {
		t.Fatalf("remove returned a transport error: %v", err)
	}
	if n := channelWrites.Load(); n != 1 {
		t.Fatalf("remove must not be gated: want 1 POST /channels, saw %d", n)
	}
}
