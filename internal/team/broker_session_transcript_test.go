package team

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/provider"
)

func TestSessionTranscriptIsTheOwnersAndOnlyForASession(t *testing.T) {
	const id = "claude-code:1a2b3c4d-0000-4000-8000-000000000000"
	prev := sessionTranscriptFn
	t.Cleanup(func() { sessionTranscriptFn = prev })
	var asked string
	sessionTranscriptFn = func(gotID, tool string) ([]agentdetect.Turn, bool) {
		asked = gotID + "|" + tool
		return []agentdetect.Turn{{From: agentdetect.TurnHuman, Text: "Fix it"}, {From: agentdetect.TurnAgent, Text: "Fixed."}}, true
	}
	b := newTestBroker(t)
	b.token = "owner-token"
	b.mu.Lock()
	b.members = append(b.members,
		officeMember{Slug: "cc-1a2b3c4d", Name: "Fix it", Provider: provider.ProviderBinding{
			Kind: provider.KindLocalSession, Session: &provider.LocalSessionBinding{Tool: "claude-code", SessionID: id},
		}},
		officeMember{Slug: "eng", Name: "Engineer"},
	)
	b.memberIndex["cc-1a2b3c4d"] = len(b.members) - 2
	b.memberIndex["eng"] = len(b.members) - 1
	b.mu.Unlock()

	get := func(slug, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/agents/local/sessions/transcript?slug="+slug, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleSessionTranscript(rec, req)
		return rec
	}
	if rec := get("cc-1a2b3c4d", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("without the owner token: %d", rec.Code)
	}
	if rec := get("eng", "owner-token"); rec.Code != http.StatusNotFound {
		t.Fatalf("an office bot: %d", rec.Code)
	}
	rec := get("cc-1a2b3c4d", "owner-token")
	var body sessionTranscriptResponse
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &body) != nil || len(body.Turns) != 2 || body.Turns[1].Text != "Fixed." {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if asked != id+"|claude-code" {
		t.Fatalf("read %q", asked)
	}
}
