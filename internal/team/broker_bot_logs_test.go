package team

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// newTestBroker returns a Broker whose state file is pinned under
// t.TempDir(). Use this for tests that don't care about the exact
// state path — only that the broker writes to an isolated location.
// For tests that also need the path itself (persistence, reload), call
// NewBrokerAt(filepath.Join(tmpDir, "broker-state.json")) directly so
// the tmpDir is in scope.
func newTestBroker(t *testing.T) *Broker {
	t.Helper()
	b := NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))
	seedTestTeamRoom(b)
	seedTestLegacyRoom(b)
	return b
}

// testTeamRoom is the shared room tests post to when the thing under test is
// NOT the DM model itself -- mention routing, message scoping, task plumbing.
//
// It used to be #general, which every test leaned on because it existed and
// held the whole roster. #general is retired, and a DM is the wrong
// substitute: a DM has exactly two members, so a bot posting into another
// bot's DM is correctly refused with "channel access denied". That refusal
// is the DM privacy model working, not a broken fixture.
//
// So tests that need a room where several bots can speak get a NAMED
// channel, which is still a real product surface. Tests that are about DMs
// use DMs.
const testTeamRoom = "team"

// newBrokerWithTeamRoom is NewBrokerAt plus the shared test room. Tests call
// this instead of NewBrokerAt directly so that every test broker has a room
// several bots can speak in, which is what #general used to provide for
// free. Idempotent.
func newBrokerWithTeamRoom(path string) *Broker {
	b := NewBrokerAt(path)
	seedTestTeamRoom(b)
	seedTestLegacyRoom(b)
	return b
}

// seedTestLegacyRoom gives the fixture a room literally named "general".
//
// About a thousand existing test literals name that room, and they are not
// testing #general -- they need somewhere for a bot to post while the test
// exercises task plumbing, message scoping, or routing. Sweeping all of them
// was tried and produced more churn than signal.
//
// So the FIXTURE provides the room; PRODUCTION does not. Nothing here goes
// through the create gate, and the seed paths that would have made #general in
// a real workspace are gated and tested separately -- see the tests that
// assert it is absent once the switch is off. A test that cares whether
// #general exists must not use this fixture.
// newRawTestBroker is the broker WITHOUT any fixture-supplied rooms: exactly
// what the product seeds and nothing more. Tests that assert what the product
// does or does not create -- the #general kill-switch guards above all -- must
// use this, or the fixture's convenience rooms silently satisfy the very
// assertion they exist to make.
func newRawTestBroker(t *testing.T) *Broker {
	t.Helper()
	return NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))
}

func seedTestLegacyRoom(b *Broker) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.findChannelLocked(GeneralChannelSlug) != nil {
		return
	}
	members := make([]string, 0, len(b.members)+1)
	members = append(members, "human")
	for _, m := range b.members {
		members = append(members, m.Slug)
	}
	b.channels = append(b.channels, teamChannel{
		Slug:        GeneralChannelSlug,
		Name:        GeneralChannelSlug,
		Type:        "channel",
		Description: "Legacy room provided by the test fixture only",
		Members:     members,
	})
}

func seedTestTeamRoom(b *Broker) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.findChannelLocked(testTeamRoom) != nil {
		return
	}
	members := make([]string, 0, len(b.members)+1)
	members = append(members, "human")
	for _, m := range b.members {
		members = append(members, m.Slug)
	}
	b.channels = append(b.channels, teamChannel{
		Slug:        testTeamRoom,
		Name:        testTeamRoom,
		Type:        "channel",
		Description: "Shared room for tests that are not about DMs",
		Members:     members,
	})
}

func TestHandleAgentLogs_ListsRecent(t *testing.T) {
	logRoot := t.TempDir()
	taskDir := filepath.Join(logRoot, "eng-12345")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "output.log"),
		[]byte(`{"tool_name":"grep_search","agent_slug":"eng","started_at":1700000000000}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	b := newTestBroker(t)
	b.SetBotLogRoot(logRoot)
	srv := httptest.NewServer(b.requireAuth(b.handleBotLogs))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d, body %s", resp.StatusCode, string(body))
	}

	var payload struct {
		Tasks []map[string]any `json:"tasks"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Tasks) != 1 {
		t.Fatalf("expected 1 task, got %d", len(payload.Tasks))
	}
	if payload.Tasks[0]["taskId"] != "eng-12345" {
		t.Fatalf("unexpected taskId: %v", payload.Tasks[0]["taskId"])
	}
}

func TestHandleAgentLogs_ReadsSingleTask(t *testing.T) {
	logRoot := t.TempDir()
	taskDir := filepath.Join(logRoot, "eng-12345")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "output.log"),
		[]byte(`{"tool_name":"grep_search","agent_slug":"eng"}`+"\n"+
			`{"tool_name":"write_file","agent_slug":"eng"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	b := newTestBroker(t)
	b.SetBotLogRoot(logRoot)
	srv := httptest.NewServer(b.requireAuth(b.handleBotLogs))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"?task=eng-12345", nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d, body %s", resp.StatusCode, string(body))
	}

	var payload struct {
		Entries []map[string]any `json:"entries"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(payload.Entries))
	}
}

func TestHandleAgentLogs_RejectsPathTraversal(t *testing.T) {
	b := newTestBroker(t)
	b.SetBotLogRoot(t.TempDir())
	srv := httptest.NewServer(b.requireAuth(b.handleBotLogs))
	defer srv.Close()

	for _, bad := range []string{"../etc/passwd", "eng/../../../etc/passwd", "a/b"} {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"?task="+bad, nil)
		req.Header.Set("Authorization", "Bearer "+b.Token())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request %q: %v", bad, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("task=%q: expected 400, got %d", bad, resp.StatusCode)
		}
	}
}
