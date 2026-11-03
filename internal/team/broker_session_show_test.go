package team

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/provider"
)

func TestSessionShowOpensItWhereItRuns(t *testing.T) {
	const claudeID = "claude-code:a0bb134f-ae9f-4809-8b8c-168a65098622"
	const codexNative = "01a12230-f471-7e60-aa99-b6ab59ee2ffa"
	var did []string
	prevShow, prevResume, prevLink, prevOpen, prevLog := sessionShowFn, sessionResumeFn, sessionOpenLinkFn, sessionOpenNowFn, sessionLogLastWriteFn
	t.Cleanup(func() {
		sessionShowFn, sessionResumeFn, sessionOpenLinkFn, sessionOpenNowFn, sessionLogLastWriteFn = prevShow, prevResume, prevLink, prevOpen, prevLog
	})
	sessionShowFn = func(_ context.Context, pid int, tool string) (string, error) {
		did = append(did, "show "+tool)
		return "superset", nil
	}
	sessionResumeFn = func(_ context.Context, tool, id, cwd string) error {
		did = append(did, "resume "+tool+" "+id+" "+cwd)
		return nil
	}
	sessionOpenLinkFn = func(_ context.Context, link string) error {
		did = append(did, "open "+link)
		return nil
	}
	open := map[string]agentdetect.OpenSession{claudeID: {PID: 8317, Interactive: true, Status: "shell"}}
	sessionOpenNowFn = func(context.Context) (map[string]agentdetect.OpenSession, bool) { return open, true }
	lastWrite := time.Now().Add(-time.Hour)
	sessionLogLastWriteFn = func(string) (time.Time, bool) { return lastWrite, true }

	b := newTestBroker(t)
	b.token = "owner-token"
	b.mu.Lock()
	b.members = append(b.members,
		officeMember{Slug: "cc-a0bb134f", Provider: provider.ProviderBinding{Kind: provider.KindLocalSession,
			Session: &provider.LocalSessionBinding{Tool: "claude-code", SessionID: claudeID, Cwd: "/Users/me/app"}}},
		officeMember{Slug: "cx-59ee2ffa", Provider: provider.ProviderBinding{Kind: provider.KindLocalSession,
			Session: &provider.LocalSessionBinding{Tool: "codex", SessionID: "codex:rollout-2026-10-09T21-43-16-" + codexNative, NativeID: codexNative}}},
		officeMember{Slug: "eng"},
	)
	for i, m := range b.members {
		b.memberIndex[m.Slug] = i
	}
	b.mu.Unlock()
	post := func(slug, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/agents/local/sessions/show", strings.NewReader(`{"slug":"`+slug+`"}`))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleSessionShow(rec, req)
		return rec
	}

	if rec := post("cc-a0bb134f", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("without the owner token: %d", rec.Code)
	}
	if rec := post("eng", "owner-token"); rec.Code != http.StatusNotFound {
		t.Fatalf("an office bot: %d", rec.Code)
	}
	// Open, even while it works: its window comes forward.
	if rec := post("cc-a0bb134f", "owner-token"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "superset") {
		t.Fatalf("open session: %d %s", rec.Code, rec.Body.String())
	}
	// The Codex app opens its thread.
	if rec := post("cx-59ee2ffa", "owner-token"); rec.Code != http.StatusOK {
		t.Fatalf("codex: %d %s", rec.Code, rec.Body.String())
	}
	// Closed, and quiet: resumed in a new Terminal window, in its folder.
	delete(open, claudeID)
	if rec := post("cc-a0bb134f", "owner-token"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "resumed") {
		t.Fatalf("closed session: %d %s", rec.Code, rec.Body.String())
	}
	// Closed by the registry's account but still writing: not resumed,
	// which would fork it.
	lastWrite = time.Now()
	if rec := post("cc-a0bb134f", "owner-token"); rec.Code != http.StatusConflict {
		t.Fatalf("still writing: %d %s", rec.Code, rec.Body.String())
	}
	want := []string{
		"show claude-code",
		"open codex://threads/" + codexNative,
		"resume claude-code a0bb134f-ae9f-4809-8b8c-168a65098622 /Users/me/app",
	}
	if strings.Join(did, "|") != strings.Join(want, "|") {
		t.Fatalf("did %q, want %q", did, want)
	}
}
