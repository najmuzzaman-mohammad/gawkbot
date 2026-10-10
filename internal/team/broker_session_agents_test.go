package team

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/bot"
	"github.com/nex-crm/wuphf/internal/provider"
)

const (
	testClaudeSessionID = "claude-code:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	testCodexSessionID  = "codex:rollout-2026-10-10T09-15-00-0199f3aa-7bcd-7e21-9f00-aabbccddeeff"
)

func claudeTestSession(id, title string) agentdetect.Session {
	return agentdetect.Session{
		ID: id, Tool: "claude-code", ToolName: "Claude Code", Title: title,
		Project: "shop", Cwd: "/Users/me/shop", State: agentdetect.SessionWorking,
		UpdatedAt: "2026-10-10T09:00:00Z", Model: "claude-opus-5-5[1m]",
	}
}

// reconcileSessionsAged runs the registry twice: once to see the sessions,
// and again once they are old enough to become members.
func reconcileSessionsAged(t *testing.T, b *Broker, sessions []agentdetect.Session) time.Time {
	t.Helper()
	start := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	b.reconcileSessionMembers(t.Context(), sessions, start)
	later := start.Add(sessionMemberMinAge + time.Second)
	b.reconcileSessionMembers(t.Context(), sessions, later)
	return later
}

func sessionMemberSlugs(b *Broker) []string {
	var out []string
	for _, m := range b.OfficeMembers() {
		if isSessionMember(m) {
			out = append(out, m.Slug)
		}
	}
	return out
}

func mustSessionMember(t *testing.T, b *Broker, slug string) officeMember {
	t.Helper()
	for _, m := range b.OfficeMembers() {
		if m.Slug == slug {
			if !isSessionMember(m) {
				t.Fatalf("@%s is not a session member: %+v", slug, m)
			}
			return m
		}
	}
	t.Fatalf("no member @%s; session members = %v", slug, sessionMemberSlugs(b))
	return officeMember{}
}

func fetchOfficeMembers(t *testing.T, b *Broker, token string) []map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/office-members", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	b.handleOfficeMembers(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("office-members status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Members []map[string]any `json:"members"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode office-members: %v", err)
	}
	if len(resp.Members) == 0 {
		t.Fatal("office-members returned an empty roster; the assertions below would pass on nothing")
	}
	return resp.Members
}

func officeMemberEntry(t *testing.T, members []map[string]any, slug string) map[string]any {
	t.Helper()
	for _, m := range members {
		if m["slug"] == slug {
			return m
		}
	}
	t.Fatalf("no @%s in office-members", slug)
	return nil
}

func TestSessionSlugCandidates(t *testing.T) {
	cases := []struct {
		name string
		sess agentdetect.Session
		want []string
	}{
		{"claude code takes the first hex of its uuid", agentdetect.Session{ID: testClaudeSessionID, Tool: "claude-code"}, []string{"cc-1a2b3c4d", "cc-1a2b3c4d5e6f"}},
		{"codex takes the random tail of the last uuid, not its timestamp head", agentdetect.Session{ID: testCodexSessionID, Tool: "codex"}, []string{"cx-ccddeeff", "cx-aabbccddeeff"}},
		// The shape of real Codex ids: time-ordered, so the head is shared by
		// sessions started close together and only the tail tells them apart.
		{"a real-shaped codex id takes its tail", agentdetect.Session{ID: "codex:rollout-2026-10-09T22-41-07-01a12230-4c1e-7d53-b6a2-5f0e9c8d7b6a", Tool: "codex"}, []string{"cx-9c8d7b6a", "cx-5f0e9c8d7b6a"}},
		{"an upper-case uuid mints a lower-case slug", agentdetect.Session{ID: "claude-code:1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D", Tool: "claude-code"}, []string{"cc-1a2b3c4d", "cc-1a2b3c4d5e6f"}},
		{"an id with no uuid gets no slug", agentdetect.Session{ID: "claude-code:aaa", Tool: "claude-code"}, nil},
		{"a tool with no prefix gets no slug", agentdetect.Session{ID: "gemini:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", Tool: "gemini"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sessionSlugCandidates(tc.sess)
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("candidates = %v, want %v", got, tc.want)
			}
		})
	}
}

// A slug already held by someone else is never reused: the session takes
// the longer form, and stays out of the roster when that is taken too.
func TestPlanSessionMembersNeverReusesAnotherMembersSlug(t *testing.T) {
	now := time.Date(2026, 10, 10, 9, 0, 30, 0, time.UTC)
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	seen := map[string]time.Time{sess.ID: now.Add(-time.Minute)}
	other := "claude-code:1a2b3c4d-ffff-4fff-8fff-ffffffffffff"
	otherSession := officeMember{Slug: "cc-1a2b3c4d", Provider: provider.ProviderBinding{
		Kind: provider.KindLocalSession, Session: &provider.LocalSessionBinding{Tool: "claude-code", SessionID: other},
	}}

	free := planSessionMembers(nil, []agentdetect.Session{sess}, seen, nil, nil, nil, sessionOpenness{}, now)
	if len(free.Creates) != 1 || free.Creates[0].Slug != "cc-1a2b3c4d" {
		t.Fatalf("free slug: creates = %+v, want cc-1a2b3c4d", free.Creates)
	}
	// Held by a different session, and separately by a hand-made bot.
	for _, holder := range []officeMember{otherSession, {Slug: "cc-1a2b3c4d", Name: "Hand made"}} {
		plan := planSessionMembers([]officeMember{holder}, []agentdetect.Session{sess}, seen, nil, nil, nil, sessionOpenness{}, now)
		if len(plan.Creates) != 1 || plan.Creates[0].Slug != "cc-1a2b3c4d5e6f" {
			t.Fatalf("holder %+v: creates = %+v, want the 12-hex slug", holder, plan.Creates)
		}
		if len(plan.Updates) != 0 || len(plan.Live) != 0 {
			t.Fatalf("holder %+v was treated as this session's member: %+v", holder, plan)
		}
	}
	both := []officeMember{otherSession, {Slug: "cc-1a2b3c4d5e6f"}}
	blocked := planSessionMembers(both, []agentdetect.Session{sess}, seen, nil, nil, nil, sessionOpenness{}, now)
	if len(blocked.Creates) != 0 || len(blocked.NoSlug) != 1 || blocked.NoSlug[0] != sess.ID {
		t.Fatalf("both slugs taken: plan = %+v, want no create and one NoSlug", blocked)
	}
	// The same session, already a member: it is live, never created twice.
	own := officeMember{Slug: "cc-1a2b3c4d", Name: sess.Title, Role: sessionMemberRole(sess), Provider: provider.ProviderBinding{
		Kind: provider.KindLocalSession, Model: sess.Model,
		Session: &provider.LocalSessionBinding{Tool: "claude-code", SessionID: sess.ID, Cwd: sess.Cwd, Title: sess.Title},
	}}
	again := planSessionMembers([]officeMember{own}, []agentdetect.Session{sess}, seen, nil, nil, nil, sessionOpenness{}, now)
	if len(again.Creates) != 0 || len(again.Updates) != 0 || again.Live["cc-1a2b3c4d"].ID != sess.ID {
		t.Fatalf("existing member: plan = %+v, want live and nothing else", again)
	}
}

func TestSessionBecomesAMemberOnlyWhenTitledAndTwentySecondsOld(t *testing.T) {
	b := newTestBroker(t)
	titled := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	// The scanner names an untitled session after its folder.
	untitled := claudeTestSession("claude-code:22222222-0000-4000-8000-000000000002", "shop")
	sessions := []agentdetect.Session{titled, untitled}
	start := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)

	b.reconcileSessionMembers(t.Context(), sessions, start)
	b.reconcileSessionMembers(t.Context(), sessions, start.Add(sessionMemberMinAge-time.Second))
	if got := sessionMemberSlugs(b); len(got) != 0 {
		t.Fatalf("a session under %s old became a member: %v", sessionMemberMinAge, got)
	}
	b.reconcileSessionMembers(t.Context(), sessions, start.Add(sessionMemberMinAge))
	if got := sessionMemberSlugs(b); len(got) != 1 || got[0] != "cc-1a2b3c4d" {
		t.Fatalf("session members = %v, want only the titled session as cc-1a2b3c4d", got)
	}
	// Any later look changes nothing: one member per session, for good.
	b.reconcileSessionMembers(t.Context(), sessions, start.Add(time.Hour))
	if got := sessionMemberSlugs(b); len(got) != 1 {
		t.Fatalf("session members after a later look = %v, want still one", got)
	}
}

func TestSessionMemberIsCreatedWithItsOwnDMAndNoSharedChannel(t *testing.T) {
	b := newTestBroker(t)
	changes, unsubscribe := b.SubscribeOfficeChanges(64)
	defer unsubscribe()
	before := len(b.AllMessages())
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")

	reconcileSessionsAged(t, b, []agentdetect.Session{sess})

	m := mustSessionMember(t, b, "cc-1a2b3c4d")
	if m.Name != "Fix the flaky checkout test" || m.Role != "Claude Code session in shop" || m.Origin != OriginSession {
		t.Fatalf("member = name %q role %q origin %q", m.Name, m.Role, m.Origin)
	}
	bind := m.Provider
	if bind.Kind != provider.KindLocalSession || bind.Model != "claude-opus-5-5[1m]" || bind.Session == nil ||
		bind.Session.Tool != "claude-code" || bind.Session.SessionID != sess.ID || bind.Session.NativeID != "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" || bind.Session.Cwd != "/Users/me/shop" {
		t.Fatalf("binding = %+v session = %+v", bind, bind.Session)
	}

	b.mu.Lock()
	shared, dm := 0, false
	for _, ch := range b.channels {
		if ch.isDM() {
			if ch.Slug == DMSlugFor("cc-1a2b3c4d") && containsString(ch.Members, "cc-1a2b3c4d") {
				dm = true
			}
			continue
		}
		shared++
		if containsString(ch.Members, "cc-1a2b3c4d") {
			b.mu.Unlock()
			t.Fatalf("session member joined shared channel #%s: %v", ch.Slug, ch.Members)
		}
	}
	b.mu.Unlock()
	if shared == 0 {
		t.Fatal("the test office has no shared channel, so 'joined none' proves nothing")
	}
	if !dm {
		t.Fatalf("no DM %q between the human and the session member", DMSlugFor("cc-1a2b3c4d"))
	}

	created := false
drain:
	for {
		select {
		case evt := <-changes:
			if evt.Kind == "member_created" && evt.Slug == "cc-1a2b3c4d" {
				created = true
			}
			if evt.Kind == "channel_updated" {
				t.Fatalf("creating a session member changed a shared channel: %+v", evt)
			}
		default:
			break drain
		}
	}
	if !created {
		t.Fatal("no member_created event for the session member")
	}
	if after := len(b.AllMessages()); after != before {
		t.Fatalf("creating a session member posted %d message(s); it must announce nothing", after-before)
	}
}

func TestSessionMemberCapStopsNewMembers(t *testing.T) {
	b := newTestBroker(t)
	var sessions []agentdetect.Session
	for i := 0; i < sessionMemberCap+2; i++ {
		id := fmt.Sprintf("claude-code:%08x-0000-4000-8000-000000000000", 0xa0000000+i)
		sessions = append(sessions, claudeTestSession(id, fmt.Sprintf("Piece of work %d", i)))
	}
	later := reconcileSessionsAged(t, b, sessions)
	if got := len(sessionMemberSlugs(b)); got != sessionMemberCap {
		t.Fatalf("session members = %d, want the cap of %d", got, sessionMemberCap)
	}
	b.mu.Lock()
	logged := b.sessionAgents.logged["cap"]
	b.mu.Unlock()
	if !logged {
		t.Fatal("sessions were held back by the cap without a log line")
	}
	// Removing one makes room for exactly one more.
	removeSessionMember(t, b, sessionMemberSlugs(b)[0])
	b.reconcileSessionMembers(t.Context(), sessions, later.Add(time.Second))
	if got := len(sessionMemberSlugs(b)); got != sessionMemberCap {
		t.Fatalf("after freeing a slot: session members = %d, want %d", got, sessionMemberCap)
	}
}

func removeSessionMember(t *testing.T, b *Broker, slug string) {
	t.Helper()
	body := fmt.Sprintf(`{"action":"remove","slug":%q}`, slug)
	rec := httptest.NewRecorder()
	b.handleOfficeMembers(rec, httptest.NewRequest(http.MethodPost, "/office-members", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("remove @%s: status %d body=%s", slug, rec.Code, rec.Body.String())
	}
}

func TestSessionMemberFollowsItsTitleAndModelInPlace(t *testing.T) {
	b := newTestBroker(t)
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})
	changes, unsubscribe := b.SubscribeOfficeChanges(16)
	defer unsubscribe()

	sess.Title, sess.Model = "Ship the checkout fix", "claude-sonnet-5-5"
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(5*time.Second))

	if got := sessionMemberSlugs(b); len(got) != 1 || got[0] != "cc-1a2b3c4d" {
		t.Fatalf("session members = %v; a rename must keep the one member and its slug", got)
	}
	m := mustSessionMember(t, b, "cc-1a2b3c4d")
	if m.Name != "Ship the checkout fix" || m.Provider.Model != "claude-sonnet-5-5" {
		t.Fatalf("member = name %q model %q, want the new title and model", m.Name, m.Provider.Model)
	}
	select {
	case evt := <-changes:
		if evt.Kind != "member_updated" || evt.Slug != "cc-1a2b3c4d" {
			t.Fatalf("event = %+v, want member_updated for cc-1a2b3c4d", evt)
		}
	default:
		t.Fatal("no member_updated event after the title changed")
	}

	// A log that names no model yet, or a title that fell back to the folder,
	// never blanks what the member already says.
	sess.Title, sess.Model = "shop", ""
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(10*time.Second))
	m = mustSessionMember(t, b, "cc-1a2b3c4d")
	if m.Name != "Ship the checkout fix" || m.Provider.Model != "claude-sonnet-5-5" {
		t.Fatalf("member = name %q model %q after an empty read, want them kept", m.Name, m.Provider.Model)
	}
	select {
	case evt := <-changes:
		t.Fatalf("an unchanged session published %+v", evt)
	default:
	}
}

func TestSessionMemberStatusFollowsItsSessionAndRestsWhenItEnds(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})

	entry := officeMemberEntry(t, fetchOfficeMembers(t, b, "owner-token"), "cc-1a2b3c4d")
	if entry["status"] != "active" || entry["detail"] != "Working" {
		t.Fatalf("working session: status=%v detail=%v", entry["status"], entry["detail"])
	}

	sess.State, sess.LastSaid = agentdetect.SessionYourTurn, "Shall I run it on staging?"
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(5*time.Second))
	entry = officeMemberEntry(t, fetchOfficeMembers(t, b, "owner-token"), "cc-1a2b3c4d")
	if entry["status"] != "idle" || entry["detail"] != "Your turn" {
		t.Fatalf("waiting session: status=%v detail=%v", entry["status"], entry["detail"])
	}

	sess.State = agentdetect.SessionQuiet
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(10*time.Second))
	entry = officeMemberEntry(t, fetchOfficeMembers(t, b, "owner-token"), "cc-1a2b3c4d")
	if entry["status"] != "idle" || entry["detail"] != nil {
		t.Fatalf("quiet session: status=%v detail=%v", entry["status"], entry["detail"])
	}

	// Its window closes: the member stays on the roster, idle, and says so.
	sess.State = agentdetect.SessionWorking
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(15*time.Second))
	b.reconcileSessionMembers(t.Context(), nil, later.Add(20*time.Second))
	entry = officeMemberEntry(t, fetchOfficeMembers(t, b, "owner-token"), "cc-1a2b3c4d")
	if entry["status"] != "idle" || entry["detail"] != nil {
		t.Fatalf("ended session: status=%v detail=%v, want idle", entry["status"], entry["detail"])
	}
	session, _ := entry["session"].(map[string]any)
	if session == nil || session["live"] != false || session["state"] != nil || session["last_said"] != "Shall I run it on staging?" {
		t.Fatalf("ended session object = %v, want live:false, no state, and what it last said", session)
	}
}

// The stuck-activity reaper must not call a session stuck, or reset it,
// while the registry keeps confirming it is working.
func TestWorkingSessionMemberIsNotReapedAsStuck(t *testing.T) {
	b := newTestBroker(t)
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})

	// Ten minutes of looks, five seconds apart, with the reaper running
	// after each one as if its minute tick landed there.
	for elapsed := 5 * time.Second; elapsed <= 10*time.Minute; elapsed += sessionReconcileEvery {
		now := later.Add(elapsed)
		b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, now)
		b.mu.Lock()
		reaped := b.reapStaleActivityLocked(now.Add(4 * time.Second))
		snap := b.activity["cc-1a2b3c4d"]
		b.mu.Unlock()
		if len(reaped) != 0 || snap.Status != "active" || snap.Kind == "stuck" {
			t.Fatalf("after %s: reaped=%+v snapshot=%+v", elapsed, reaped, snap)
		}
	}
	// And the reaper still does its job if the registry stops looking.
	b.mu.Lock()
	reaped := b.reapStaleActivityLocked(later.Add(10*time.Minute + staleActivityThreshold + time.Second))
	b.mu.Unlock()
	if len(reaped) != 1 || reaped[0].Status != "idle" {
		t.Fatalf("with the registry stopped, reaped = %+v, want the one stale snapshot reset", reaped)
	}
}

func TestSessionMemberWireShape(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	sess.LastSaid = "Running the suite now."
	reconcileSessionsAged(t, b, []agentdetect.Session{sess})

	entry := officeMemberEntry(t, fetchOfficeMembers(t, b, "owner-token"), "cc-1a2b3c4d")
	if entry["origin"] != "session" || entry["runs_on"] != "this_machine" || entry["runs_on_detail"] != "Claude Code on this machine" {
		t.Fatalf("origin=%v runs_on=%v runs_on_detail=%v", entry["origin"], entry["runs_on"], entry["runs_on_detail"])
	}
	runtime, _ := entry["runtime"].(map[string]any)
	if runtime["harness"] != "claude-code" || runtime["harness_name"] != "Claude Code" ||
		runtime["model"] != "claude-opus-5-5[1m]" || runtime["model_label"] != "Opus 5.5" || runtime["source"] != "observed" {
		t.Fatalf("runtime = %v, want the session's own tool and observed model, never local-session", runtime)
	}
	want := map[string]any{
		"tool": "claude-code", "project": "shop", "cwd": "/Users/me/shop", "state": "working",
		"updated_at": "2026-10-10T09:00:00Z", "last_said": "Running the suite now.", "live": true,
		// Messaging a session is off unless it is switched on.
		"can_message": false, "message_block": "unknown",
	}
	session, _ := entry["session"].(map[string]any)
	if len(session) != len(want) {
		t.Fatalf("session object = %v, want exactly %v", session, want)
	}
	for k, v := range want {
		if session[k] != v {
			t.Fatalf("session[%q] = %v, want %v (whole object %v)", k, session[k], v, session)
		}
	}
	// An ordinary bot carries no session object.
	if lead := officeMemberEntry(t, fetchOfficeMembers(t, b, "owner-token"), b.OfficeLeadSlug()); lead["session"] != nil {
		t.Fatalf("the lead has a session object: %v", lead["session"])
	}
}

// Sessions describe the host machine. Only the owner's token sees their
// members; a joined human and a tokenless caller see the office bots alone.
func TestSessionMembersAreServedToTheOwnerOnly(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	reconcileSessionsAged(t, b, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	invite, _, err := b.createHumanInvite()
	if err != nil {
		t.Fatalf("create invite: %v", err)
	}
	sessionToken, _, err := b.acceptHumanInvite(invite, "Mira", "browser")
	if err != nil {
		t.Fatalf("accept invite: %v", err)
	}

	roster := func(decorate func(*http.Request)) (slugs []string, raw string) {
		req := httptest.NewRequest(http.MethodGet, "/office-members", nil)
		decorate(req)
		rec := httptest.NewRecorder()
		b.withAuth(b.handleOfficeMembers)(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("office-members status = %d body=%s", rec.Code, rec.Body.String())
		}
		var resp struct {
			Members []struct {
				Slug string `json:"slug"`
			} `json:"members"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		for _, m := range resp.Members {
			slugs = append(slugs, m.Slug)
		}
		return slugs, rec.Body.String()
	}

	owner, _ := roster(func(r *http.Request) { r.Header.Set("Authorization", "Bearer owner-token") })
	if !containsString(owner, "cc-1a2b3c4d") {
		t.Fatalf("the owner's roster = %v, want it to include the session member", owner)
	}
	joined, raw := roster(func(r *http.Request) { r.AddCookie(&http.Cookie{Name: humanSessionCookie, Value: sessionToken}) })
	if len(joined) == 0 {
		t.Fatal("the joined human got an empty roster; they must still see the office bots")
	}
	if len(joined) != len(owner)-1 {
		t.Fatalf("joined roster = %v, owner roster = %v; want the same minus the session member", joined, owner)
	}
	for _, leak := range []string{"cc-1a2b3c4d", "/Users/me/shop", testClaudeSessionID, "Fix the flaky checkout test"} {
		if strings.Contains(raw, leak) {
			t.Fatalf("a joined human's roster contains %q: %s", leak, raw)
		}
	}
	// Called without any credential (never reachable through withAuth, but
	// the handler must fail closed on its own).
	for _, m := range fetchOfficeMembers(t, b, "") {
		if m["slug"] == "cc-1a2b3c4d" {
			t.Fatal("a caller without the owner token saw the session member")
		}
	}
}

func TestNotchListsASessionOnceUnderItsMembersSlug(t *testing.T) {
	now := time.Now().UTC()
	withMember := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	withMember.UpdatedAt = now.Format(time.RFC3339)
	// Too new to be a member, and one whose id can never mint a slug.
	fresh := claudeTestSession("claude-code:33333333-0000-4000-8000-000000000003", "Draft the release notes")
	fresh.UpdatedAt = now.Format(time.RFC3339)
	legacy := agentdetect.Session{ID: "codex:bbb", Tool: "codex", ToolName: "Codex CLI", Title: "Tidy the migration scripts", Project: "api", State: agentdetect.SessionYourTurn, UpdatedAt: now.Add(-2 * time.Hour).Format(time.RFC3339)}

	b := newTestBroker(t)
	b.token = "owner-token"
	reconcileSessionsAged(t, b, []agentdetect.Session{withMember})
	stubLocalSessions(t, []agentdetect.Session{withMember, fresh, legacy})

	req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
	req.Header.Set("Authorization", "Bearer owner-token")
	rec := httptest.NewRecorder()
	b.handleNotchState(rec, req)
	var state notchState
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}

	seen := map[string]int{}
	for _, a := range state.Agents {
		seen[a.Slug]++
	}
	for slug, n := range seen {
		if n != 1 {
			t.Fatalf("@%s is listed %d times: %+v", slug, n, state.Agents)
		}
	}
	if seen[notchSessionSlug(withMember.ID)] != 0 {
		t.Fatalf("the session with a member is also listed as a bare session row: %+v", state.Agents)
	}
	row := notchAgentBySlug(t, state, "cc-1a2b3c4d")
	if row.Kind != notchAgentSession || row.Name != "Fix the flaky checkout test" || row.Origin != OriginSession ||
		row.Tool != "claude-code" || row.Project != "shop" || row.State != agentdetect.SessionWorking ||
		row.Mood != MoodWorking || row.Detail != "Working in shop" {
		t.Fatalf("member row = %+v, want the member's slug with the session's kind and fields", row)
	}
	if r := row.Runtime; r == nil || r.Harness != "claude-code" || r.ModelLabel != "Opus 5.5" {
		t.Fatalf("member row runtime = %+v", r)
	}
	// Sessions with no member keep today's rows.
	if a := notchAgentBySlug(t, state, notchSessionSlug(fresh.ID)); a.Kind != notchAgentSession || a.Origin != "" {
		t.Fatalf("fresh session row = %+v", a)
	}
	if a := notchAgentBySlug(t, state, "session.codex.bbb"); a.Kind != notchAgentSession {
		t.Fatalf("legacy session row = %+v", a)
	}
	if len(state.Agents) != len(b.OfficeMembers())+2 {
		t.Fatalf("agents = %d, want every member once plus the two memberless sessions", len(state.Agents))
	}
}

// Adoption is a different object (a worker the office runs). It must keep
// working, and keep its own slug, while a session of the same tool is a member.
func TestAdoptingClaudeCodeStillWorksBesideASessionMember(t *testing.T) {
	stubLocalAgentScan(t, detectionFor(t, "claude-code", true, 4242), detectionFor(t, "codex", true))
	b := newTestBroker(t)
	reconcileSessionsAged(t, b, []agentdetect.Session{
		claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test"),
		{ID: testCodexSessionID, Tool: "codex", ToolName: "Codex CLI", Title: "Tidy the migration scripts", Project: "api", Cwd: "/Users/me/api", State: agentdetect.SessionYourTurn},
	})
	mustSessionMember(t, b, "cc-1a2b3c4d")
	mustSessionMember(t, b, "cx-ccddeeff")

	for _, a := range listLocalAgents(t, b).Agents {
		if a.AdoptedAs != "" {
			t.Fatalf("%s reads as adopted (@%s) because a session member exists", a.ID, a.AdoptedAs)
		}
	}
	resp := adoptLocalAgents(t, b, `{"ids":["claude-code","codex"]}`)
	if len(resp.Adopted) != 2 {
		t.Fatalf("adopted = %+v skipped = %+v, want both tools adopted", resp.Adopted, resp.Skipped)
	}
	for _, id := range []string{"claude-code", "codex"} {
		b.mu.Lock()
		m := b.findMemberLocked(id)
		b.mu.Unlock()
		if m == nil || m.Origin != OriginAdopted || m.AdoptedFrom != id || isSessionMember(*m) {
			t.Fatalf("adopted @%s = %+v", id, m)
		}
	}
	for _, a := range listLocalAgents(t, b).Agents {
		if (a.ID == "claude-code" || a.ID == "codex") && a.AdoptedAs != a.ID {
			t.Fatalf("%s adopted_as = %q, want %q", a.ID, a.AdoptedAs, a.ID)
		}
	}
	if got := sessionMemberSlugs(b); len(got) != 2 {
		t.Fatalf("session members after adoption = %v, want the same two", got)
	}
}

// A message to a session member starts no process, whatever a task says its
// provider is, and gets one plain answer saying why.
func TestMessagingASessionMemberSpawnsNothingAndExplains(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WUPHF_RUNTIME_HOME", tmpHome)
	spawned := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		t.Errorf("a message to a session member started %s %v", name, args)
		return exec.CommandContext(ctx, "true")
	}
	prevClaude, prevCodex, prevCLI := headlessClaudeCommandContext, headlessCodexCommandContext, headlessCLIAgentCommandContext
	headlessClaudeCommandContext, headlessCodexCommandContext, headlessCLIAgentCommandContext = spawned, spawned, spawned
	t.Cleanup(func() {
		headlessClaudeCommandContext, headlessCodexCommandContext, headlessCLIAgentCommandContext = prevClaude, prevCodex, prevCLI
	})

	b := newTestBroker(t)
	reconcileSessionsAged(t, b, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	l := &Launcher{pack: bot.GetPack("founding-team"), cwd: t.TempDir(), broker: b, headless: headlessWorkerPool{ctx: t.Context()}}
	dm := DMSlugFor("cc-1a2b3c4d")

	if _, err := b.PostMessage("you", dm, "Can you also bump the version?", nil, ""); err != nil {
		t.Fatalf("human message into the DM: %v", err)
	}
	if err := defaultHeadlessCodexRunTurn(l, t.Context(), "cc-1a2b3c4d", "Can you also bump the version?", dm); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	replies := func() int {
		n := 0
		for _, msg := range b.ChannelMessages(dm) {
			if msg.From == "cc-1a2b3c4d" && msg.Content == sessionNotMessageableReply {
				n++
			}
		}
		return n
	}
	if replies() != 1 {
		t.Fatalf("explanations in the DM = %d, want 1; messages = %+v", replies(), b.ChannelMessages(dm))
	}
	// Dispatched again with nothing new said: no second copy.
	if err := defaultHeadlessCodexRunTurn(l, t.Context(), "cc-1a2b3c4d", "Can you also bump the version?", dm); err != nil {
		t.Fatalf("second dispatch: %v", err)
	}
	if replies() != 1 {
		t.Fatalf("explanations after a repeat dispatch = %d, want still 1", replies())
	}
	// Addressed from a shared channel it is not in: it answers in its DM.
	if _, err := b.PostMessage("you", dm, "Hello again?", nil, ""); err != nil {
		t.Fatalf("human message into the DM: %v", err)
	}
	if err := defaultHeadlessCodexRunTurn(l, t.Context(), "cc-1a2b3c4d", "Hello again?", testTeamRoom); err != nil {
		t.Fatalf("dispatch from a shared channel: %v", err)
	}
	if replies() != 2 {
		t.Fatalf("explanations after a new human message = %d, want 2", replies())
	}
	for _, msg := range b.ChannelMessages(testTeamRoom) {
		if msg.From == "cc-1a2b3c4d" {
			t.Fatalf("the session member posted in a shared channel: %+v", msg)
		}
	}
}

func TestLocalSessionKindCannotBeChosenOverHTTP(t *testing.T) {
	b := newTestBroker(t)
	reconcileSessionsAged(t, b, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	post := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		b.handleOfficeMembers(rec, httptest.NewRequest(http.MethodPost, "/office-members", strings.NewReader(body)))
		return rec
	}
	cases := map[string]string{
		"create a bot as a session":       `{"action":"create","slug":"sneaky","name":"Sneaky","provider":{"kind":"local-session"}}`,
		"switch a bot to a session":       `{"action":"update","slug":"cos","provider":{"kind":"local-session"}}`,
		"switch a session to a real tool": `{"action":"update","slug":"cc-1a2b3c4d","provider":{"kind":"claude-code"}}`,
	}
	for name, body := range cases {
		if rec := post(body); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), errSessionRuntimeNotSelectable) {
			t.Fatalf("%s: status %d body=%s, want 400 with the reason", name, rec.Code, rec.Body.String())
		}
	}
	b.mu.Lock()
	sneaky := b.findMemberLocked("sneaky")
	b.mu.Unlock()
	if sneaky != nil {
		t.Fatalf("a refused create left a member behind: %+v", sneaky)
	}
	if m := mustSessionMember(t, b, "cc-1a2b3c4d"); m.Provider.Session == nil {
		t.Fatalf("a refused switch changed the session member: %+v", m)
	}
}

// Removing a session's member removes only the member, and it stays removed
// while the window is open and across a restart.
func TestRemovedSessionMemberStaysRemoved(t *testing.T) {
	b := newTestBroker(t)
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	other := claudeTestSession("claude-code:44444444-0000-4000-8000-000000000004", "Write the changelog")
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess, other})

	removeSessionMember(t, b, "cc-1a2b3c4d")
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess, other}, later.Add(time.Minute))
	if got := sessionMemberSlugs(b); len(got) != 1 || got[0] != "cc-44444444" {
		t.Fatalf("session members after a removal = %v, want only the other session", got)
	}

	reloaded := reloadedBroker(t, b)
	reconcileSessionsAged(t, reloaded, []agentdetect.Session{sess, other})
	if got := sessionMemberSlugs(reloaded); len(got) != 1 || got[0] != "cc-44444444" {
		t.Fatalf("session members after a restart = %v, want the removed one still gone", got)
	}
	m := mustSessionMember(t, reloaded, "cc-44444444")
	if m.Provider.Session == nil || m.Provider.Session.SessionID != other.ID || m.Origin != OriginSession {
		t.Fatalf("the surviving member did not round-trip through the state file: %+v", m)
	}
}

// A restart must not sweep session members into the general channel the way
// it re-fills it with office bots.
func TestSessionMemberStaysOutOfGeneralAcrossARestart(t *testing.T) {
	b := newTestBroker(t)
	// A general channel holding fewer members than the roster is what makes
	// the load pass re-fill it, so pin it to the lead alone.
	b.mu.Lock()
	if b.findChannelLocked("general") == nil {
		b.channels = append(b.channels, teamChannel{Slug: "general", Name: "general"})
		b.rebuildChannelIndexLocked()
	}
	b.findChannelLocked("general").Members = []string{"cos"}
	b.mu.Unlock()
	reconcileSessionsAged(t, b, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	mustSessionMember(t, b, "cc-1a2b3c4d")

	reloaded := reloadedBroker(t, b)
	mustSessionMember(t, reloaded, "cc-1a2b3c4d")
	reloaded.mu.Lock()
	defer reloaded.mu.Unlock()
	// The pass NewBrokerAt runs over state it has just loaded.
	reloaded.normalizeLoadedStateLocked()
	general := reloaded.findChannelLocked("general")
	if general == nil {
		t.Fatal("the general channel did not survive the reload, so this proves nothing")
	}
	if containsString(general.Members, "cc-1a2b3c4d") {
		t.Fatalf("the session member was added to #general on load: %v", general.Members)
	}
	// The re-fill itself still runs for the office's own bots: a second bot
	// missing from general is put back by the same pass.
	reloaded.members = append(reloaded.members, officeMember{Slug: "tess", Name: "Tess"})
	reloaded.rebuildMemberIndexLocked()
	reloaded.normalizeLoadedStateLocked()
	general = reloaded.findChannelLocked("general")
	if !containsString(general.Members, "tess") || containsString(general.Members, "cc-1a2b3c4d") {
		t.Fatalf("after adding an office bot, #general = %v, want it to gain @tess and still not the session member", general.Members)
	}
}

func TestSessionMemberLoopReconcilesAndStopsWithItsContext(t *testing.T) {
	stubLocalSessions(t, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	b := newTestBroker(t)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.runSessionMembers(ctx, 5*time.Millisecond)
	}()

	deadline := time.After(10 * time.Second)
	for {
		b.mu.Lock()
		_, seen := b.sessionAgents.firstSeen[testClaudeSessionID]
		b.mu.Unlock()
		if seen {
			break
		}
		select {
		case <-deadline:
			cancel()
			t.Fatal("the loop never looked at the machine's sessions")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the loop did not stop when its context was cancelled")
	}
}

// A session member's live status names the folder its owner is working in.
// It reaches the owner's event stream and never a joined human's.
func TestSessionMemberActivityIsStreamedToTheOwnerOnly(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	later := reconcileSessionsAged(t, b, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	invite, _, err := b.createHumanInvite()
	if err != nil {
		t.Fatalf("create invite: %v", err)
	}
	sessionToken, _, err := b.acceptHumanInvite(invite, "Mira", "browser")
	if err != nil {
		t.Fatalf("accept invite: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(b.handleEvents))
	t.Cleanup(srv.Close)

	// streamUntilSentinel opens an event stream, makes the session member's
	// status change, then an office bot's, and returns everything read up to
	// the office bot's event. Both travel the same ordered channel, so the
	// session's event, if it is sent at all, is in what comes back.
	streamUntilSentinel := func(name string, state string, decorate func(*http.Request)) string {
		req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
		if err != nil {
			t.Fatalf("%s: build events request: %v", name, err)
		}
		decorate(req)
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatalf("%s: events request: %v", name, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: events status = %d", name, resp.StatusCode)
		}
		reader := bufio.NewReader(resp.Body)
		read := func(until string) string {
			var out strings.Builder
			for {
				line, err := reader.ReadString('\n')
				if err != nil {
					t.Fatalf("%s: read event stream waiting for %q: %v; so far %q", name, until, err, out.String())
				}
				out.WriteString(line)
				if strings.Contains(line, until) {
					return out.String()
				}
			}
		}
		read("event: ready")
		sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
		sess.State = state
		b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(time.Minute))
		sentinel := "sentinel for " + name
		b.UpdateBotActivity(botActivitySnapshot{Slug: b.OfficeLeadSlug(), Status: "active", Activity: "thinking", Detail: sentinel})
		return read(sentinel)
	}

	// Each stream sees one real status change: working to waiting, then back.
	joined := streamUntilSentinel("joined human", agentdetect.SessionYourTurn, func(r *http.Request) {
		r.AddCookie(&http.Cookie{Name: humanSessionCookie, Value: sessionToken})
	})
	if strings.Contains(joined, "cc-1a2b3c4d") || strings.Contains(joined, "Your turn") {
		t.Fatalf("a joined human's stream carried the session member's status: %s", joined)
	}
	owner := streamUntilSentinel("owner", agentdetect.SessionWorking, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer owner-token")
	})
	if !strings.Contains(owner, `"slug":"cc-1a2b3c4d"`) || !strings.Contains(owner, `"detail":"Working"`) {
		t.Fatalf("the owner's stream is missing the session member's status: %s", owner)
	}
}

// Two Codex sessions started in the same minute share the head of their
// time-ordered ids. Their slugs must still differ without the collision path.
func TestCodexSessionsStartedTogetherGetDifferentSlugs(t *testing.T) {
	a := sessionSlugCandidates(agentdetect.Session{Tool: "codex", ID: "codex:rollout-2026-10-10T09-15-00-0199f3aa-7bcd-7e21-9f00-aabbccddeeff"})
	b := sessionSlugCandidates(agentdetect.Session{Tool: "codex", ID: "codex:rollout-2026-10-10T09-15-20-0199f3aa-7bce-7a10-8e11-112233445566"})
	if len(a) != 2 || len(b) != 2 {
		t.Fatalf("candidates = %v and %v, want two each", a, b)
	}
	if a[0] == b[0] || a[0] != "cx-ccddeeff" || b[0] != "cx-33445566" {
		t.Fatalf("first slugs = %q and %q, want the two random tails", a[0], b[0])
	}
}

// Sessions describe the host machine. With a session member on the roster,
// running or ended, a caller without the owner token sees no trace of it on
// either route; the owner sees it once, as a session row, on both.
func TestSessionMemberIsOwnerOnlyOnEveryRouteLiveAndEnded(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	sess.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})

	notch := func(token string) (notchState, string) {
		req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchState(rec, req)
		var s notchState
		if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
			t.Fatal(err)
		}
		if len(s.Agents) == 0 {
			t.Fatal("notch state has no agents at all; the checks below would pass on nothing")
		}
		return s, rec.Body.String()
	}
	roster := func(token string) string {
		req := httptest.NewRequest(http.MethodGet, "/office-members", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleOfficeMembers(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"slug":"cos"`) {
			t.Fatalf("office-members status=%d body=%s", rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}
	leaks := []string{"cc-1a2b3c4d", "Fix the flaky checkout test", "/Users/me/shop", testClaudeSessionID, `"session"`}

	check := func(phase string, live bool) {
		for route, raw := range map[string]string{"/office-members": roster("")} {
			for _, leak := range leaks {
				if strings.Contains(raw, leak) {
					t.Fatalf("%s: %s without the owner token contains %q: %s", phase, route, leak, raw)
				}
			}
		}
		_, rawNotch := notch("")
		for _, leak := range leaks {
			if strings.Contains(rawNotch, leak) {
				t.Fatalf("%s: /notch/state without the owner token contains %q: %s", phase, leak, rawNotch)
			}
		}

		if raw := roster("owner-token"); !strings.Contains(raw, `"slug":"cc-1a2b3c4d"`) || !strings.Contains(raw, fmt.Sprintf(`"live":%t`, live)) {
			t.Fatalf("%s: the owner's roster lacks the session member with live=%t: %s", phase, live, raw)
		}
		state, _ := notch("owner-token")
		rows := 0
		for _, a := range state.Agents {
			if a.Slug == "cc-1a2b3c4d" || a.Name == "Fix the flaky checkout test" {
				rows++
			}
		}
		if rows != 1 {
			t.Fatalf("%s: the owner's notch lists the session %d times: %+v", phase, rows, state.Agents)
		}
		row := notchAgentBySlug(t, state, "cc-1a2b3c4d")
		if row.Kind != notchAgentSession || row.Tool != "claude-code" || row.ToolName != "Claude Code" || row.Project != "shop" {
			t.Fatalf("%s: owner's row = %+v, want kind session with its tool and folder", phase, row)
		}
		if live {
			if row.State != agentdetect.SessionWorking || row.Mood != MoodWorking || row.UpdatedAt == "" {
				t.Fatalf("%s: live row = %+v", phase, row)
			}
			return
		}
		// Ended: a resting member row, with nothing that claims it is running.
		if row.State != "" || row.UpdatedAt != "" || row.LastSaid != "" || row.Mood != MoodIdle {
			t.Fatalf("%s: ended row = %+v, want no live fields and an idle mood", phase, row)
		}
		if r := row.Runtime; r == nil || r.Harness != "claude-code" || r.HarnessName != "Claude Code" {
			t.Fatalf("%s: ended row runtime = %+v", phase, r)
		}
	}

	stubLocalSessions(t, []agentdetect.Session{sess})
	check("live", true)

	// The window closes: the scan lists nothing, and the registry notices.
	stubLocalSessions(t, nil)
	b.reconcileSessionMembers(t.Context(), nil, later.Add(5*time.Second))
	check("ended", false)
}

// At the cap a new session takes the place of the oldest ended session
// member nobody ever wrote to. Running sessions and members the human has
// engaged with are never removed.
func TestSessionMemberCapEvictsOnlyEndedUnengagedMembers(t *testing.T) {
	titled := func(i int) agentdetect.Session {
		return claudeTestSession(fmt.Sprintf("claude-code:%08x-0000-4000-8000-000000000000", 0xb0000000+i), fmt.Sprintf("Piece of work %d", i))
	}
	slugOf := func(i int) string { return fmt.Sprintf("cc-%08x", 0xb0000000+i) }
	// fill makes sessionMemberCap session members, created in order (member 0
	// is the oldest), and returns the sessions and the time of the last look.
	fill := func(t *testing.T, b *Broker) ([]agentdetect.Session, time.Time) {
		t.Helper()
		var all []agentdetect.Session
		for i := 0; i < sessionMemberCap; i++ {
			all = append(all, titled(i))
		}
		later := reconcileSessionsAged(t, b, all)
		b.mu.Lock()
		for i := 0; i < sessionMemberCap; i++ {
			m := b.findMemberLocked(slugOf(i))
			if m == nil {
				b.mu.Unlock()
				t.Fatalf("setup: no member %s", slugOf(i))
			}
			m.CreatedAt = time.Date(2026, 10, 1, 0, i, 0, 0, time.UTC).Format(time.RFC3339)
		}
		b.mu.Unlock()
		if got := len(sessionMemberSlugs(b)); got != sessionMemberCap {
			t.Fatalf("setup: session members = %d, want %d", got, sessionMemberCap)
		}
		return all, later
	}
	newcomer := claudeTestSession("claude-code:cafe0001-0000-4000-8000-000000000000", "A brand new piece of work")
	// arrive shows the newcomer beside the given still-running sessions, long
	// enough for it to earn a member.
	arrive := func(b *Broker, running []agentdetect.Session, later time.Time) {
		sessions := append(append([]agentdetect.Session{}, running...), newcomer)
		b.reconcileSessionMembers(t.Context(), sessions, later.Add(time.Minute))
		b.reconcileSessionMembers(t.Context(), sessions, later.Add(time.Minute+sessionMemberMinAge+time.Second))
	}
	has := func(b *Broker, slug string) bool { return containsString(sessionMemberSlugs(b), slug) }

	t.Run("the oldest ended member that was never written to makes room", func(t *testing.T) {
		b := newTestBroker(t)
		all, later := fill(t, b)
		// Members 0, 1 and 2 have ended. The human wrote to 0 and gave 1 a task.
		if _, err := b.PostMessage("you", DMSlugFor(slugOf(0)), "Where did you leave this?", nil, ""); err != nil {
			t.Fatalf("write to member 0: %v", err)
		}
		b.mu.Lock()
		b.tasks = append(b.tasks, teamTask{ID: "task-keep", Title: "Keep me", Owner: slugOf(1)})
		b.mu.Unlock()

		arrive(b, all[3:], later)

		if !has(b, "cc-cafe0001") {
			t.Fatalf("the new session did not become a member: %v", sessionMemberSlugs(b))
		}
		if has(b, slugOf(2)) {
			t.Fatalf("member 2 (ended, never written to) was not the one removed: %v", sessionMemberSlugs(b))
		}
		for _, keep := range []int{0, 1, 3, sessionMemberCap - 1} {
			if !has(b, slugOf(keep)) {
				t.Fatalf("member %d was removed; only the ended, unengaged one may go: %v", keep, sessionMemberSlugs(b))
			}
		}
		if got := len(sessionMemberSlugs(b)); got != sessionMemberCap {
			t.Fatalf("session members = %d, want exactly the cap", got)
		}
		// The evicted session does not come back if its window reappears.
		back := append(append([]agentdetect.Session{}, all[2:]...), newcomer)
		b.reconcileSessionMembers(t.Context(), back, later.Add(time.Hour))
		b.reconcileSessionMembers(t.Context(), back, later.Add(2*time.Hour))
		if has(b, slugOf(2)) {
			t.Fatalf("the evicted session's member came back: %v", sessionMemberSlugs(b))
		}
	})

	t.Run("of several ended members the oldest goes first", func(t *testing.T) {
		b := newTestBroker(t)
		all, later := fill(t, b)
		arrive(b, all[5:], later) // 0 to 4 ended, none engaged
		if has(b, slugOf(0)) || !has(b, slugOf(1)) || !has(b, slugOf(4)) || !has(b, "cc-cafe0001") {
			t.Fatalf("want only member 0 (the oldest) removed: %v", sessionMemberSlugs(b))
		}
	})

	t.Run("every ended member was written to: nothing is removed", func(t *testing.T) {
		b := newTestBroker(t)
		all, later := fill(t, b)
		for _, i := range []int{0, 1} {
			if _, err := b.PostMessage("you", DMSlugFor(slugOf(i)), "Still need this one.", nil, ""); err != nil {
				t.Fatalf("write to member %d: %v", i, err)
			}
		}
		arrive(b, all[2:], later)
		if has(b, "cc-cafe0001") || !has(b, slugOf(0)) || !has(b, slugOf(1)) || len(sessionMemberSlugs(b)) != sessionMemberCap {
			t.Fatalf("want the roster unchanged and the newcomer left out: %v", sessionMemberSlugs(b))
		}
		b.mu.Lock()
		logged := b.sessionAgents.logged["cap"]
		b.mu.Unlock()
		if !logged {
			t.Fatal("the newcomer was held back without a log line")
		}
	})

	t.Run("all members are live: nothing is removed", func(t *testing.T) {
		b := newTestBroker(t)
		all, later := fill(t, b)
		arrive(b, all, later)
		if has(b, "cc-cafe0001") || len(sessionMemberSlugs(b)) != sessionMemberCap {
			t.Fatalf("a live session's member was removed to make room: %v", sessionMemberSlugs(b))
		}
		for i := 0; i < sessionMemberCap; i++ {
			if !has(b, slugOf(i)) {
				t.Fatalf("live member %d is gone", i)
			}
		}
	})

	t.Run("a bot's own reply in the DM is not the human writing to it", func(t *testing.T) {
		b := newTestBroker(t)
		all, later := fill(t, b)
		if _, err := b.PostMessage(slugOf(0), DMSlugFor(slugOf(0)), sessionNotMessageableReply, nil, ""); err != nil {
			t.Fatalf("member 0 posts in its own DM: %v", err)
		}
		arrive(b, all[1:], later)
		if has(b, slugOf(0)) || !has(b, "cc-cafe0001") {
			t.Fatalf("member 0 has only its own message in its DM and should have made room: %v", sessionMemberSlugs(b))
		}
	})
}

// The member's name follows the session's title until a person renames it.
// After that their name stays, whatever the session calls itself.
func TestSessionMemberManualRenameSticks(t *testing.T) {
	rename := func(t *testing.T, b *Broker, name string) {
		t.Helper()
		body := fmt.Sprintf(`{"action":"update","slug":"cc-1a2b3c4d","name":%q}`, name)
		rec := httptest.NewRecorder()
		b.handleOfficeMembers(rec, httptest.NewRequest(http.MethodPost, "/office-members", strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("rename: status %d body=%s", rec.Code, rec.Body.String())
		}
	}
	b := newTestBroker(t)
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})

	// Not renamed: the title leads.
	sess.Title = "Ship the checkout fix"
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(5*time.Second))
	if m := mustSessionMember(t, b, "cc-1a2b3c4d"); m.Name != "Ship the checkout fix" {
		t.Fatalf("before any rename the name is %q, want it to follow the title", m.Name)
	}

	// Renamed by a person: later titles no longer rename it, but the model
	// still follows the log.
	rename(t, b, "Checkout buddy")
	sess.Title, sess.Model = "Something else entirely", "claude-sonnet-5-5"
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(10*time.Second))
	sess.Title = "And again"
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(15*time.Second))
	m := mustSessionMember(t, b, "cc-1a2b3c4d")
	if m.Name != "Checkout buddy" {
		t.Fatalf("a manual rename was overwritten: name = %q", m.Name)
	}
	if m.Provider.Model != "claude-sonnet-5-5" || m.Provider.Session.Title != "And again" {
		t.Fatalf("model %q / tracked title %q, want the log still followed", m.Provider.Model, m.Provider.Session.Title)
	}

	// Renamed back to the session's own title: it follows again.
	rename(t, b, "And again")
	sess.Title = "Final title"
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{sess}, later.Add(20*time.Second))
	if m := mustSessionMember(t, b, "cc-1a2b3c4d"); m.Name != "Final title" {
		t.Fatalf("after renaming back to the title the name is %q, want it to follow again", m.Name)
	}
}

func TestSessionMemberLoopCanBeSwitchedOff(t *testing.T) {
	stubLocalSessions(t, nil)
	b := newTestBroker(t)
	for _, off := range []string{"1", "true", "on"} {
		t.Setenv(sessionMembersDisabledEnv, off)
		if b.startSessionMemberLoop(t.Context()) {
			t.Fatalf("%s=%s: the loop started", sessionMembersDisabledEnv, off)
		}
	}
	// Default on for a real install: unset, empty, or anything not truthy.
	for _, on := range []string{"", "0", "false"} {
		t.Setenv(sessionMembersDisabledEnv, on)
		ctx, cancel := context.WithCancel(t.Context())
		started := b.startSessionMemberLoop(ctx)
		cancel()
		if !started {
			t.Fatalf("%s=%q: the loop did not start", sessionMembersDisabledEnv, on)
		}
	}
}

// With one running and one ended session member, the owner's notch shows
// both as session rows; a caller without the token sees neither, and their
// headline and mood are those of an office with no sessions at all.
func TestNotchWithLiveAndEndedSessionMembers(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	live := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	live.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	ended := agentdetect.Session{ID: testCodexSessionID, Tool: "codex", ToolName: "Codex CLI", Title: "Tidy the migration scripts", Project: "api", Cwd: "/Users/me/api", State: agentdetect.SessionWorking, UpdatedAt: live.UpdatedAt, LastSaid: "Running them now."}
	later := reconcileSessionsAged(t, b, []agentdetect.Session{live, ended})
	b.reconcileSessionMembers(t.Context(), []agentdetect.Session{live}, later.Add(5*time.Second))
	stubLocalSessions(t, []agentdetect.Session{live})

	fetch := func(token string) notchState {
		req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchState(rec, req)
		var s notchState
		if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
			t.Fatal(err)
		}
		return s
	}

	owner := fetch("owner-token")
	a := notchAgentBySlug(t, owner, "cc-1a2b3c4d")
	if a.Kind != notchAgentSession || a.Tool != "claude-code" || a.State != agentdetect.SessionWorking || a.Mood != MoodWorking || a.UpdatedAt == "" {
		t.Fatalf("live row = %+v", a)
	}
	e := notchAgentBySlug(t, owner, "cx-ccddeeff")
	if e.Kind != notchAgentSession || e.Tool != "codex" || e.ToolName != "Codex CLI" || e.Name != "Tidy the migration scripts" {
		t.Fatalf("ended row = %+v, want kind session with tool and tool name from its binding", e)
	}
	if e.State != "" || e.UpdatedAt != "" || e.LastSaid != "" || e.Mood != MoodIdle || e.Detail != "" {
		t.Fatalf("ended row carries live fields: %+v", e)
	}

	plain := fetch("")
	if len(plain.Agents) == 0 {
		t.Fatal("a caller without the token got no agents at all; they must still see the office bots")
	}
	for _, agent := range plain.Agents {
		if strings.HasPrefix(agent.Slug, "cc-") || strings.HasPrefix(agent.Slug, "cx-") || strings.HasPrefix(agent.Slug, "session.") || agent.Kind == notchAgentSession || agent.Origin == OriginSession {
			t.Fatalf("a caller without the owner token saw %+v", agent)
		}
	}
	if len(plain.Agents) != len(owner.Agents)-2 {
		t.Fatalf("agents without the token = %d, with it = %d; want exactly the two session members fewer", len(plain.Agents), len(owner.Agents))
	}
	// A session is working, yet for this caller the office is simply quiet.
	if plain.Mood != MoodIdle || plain.Headline != "All quiet. Nothing needs you." || len(plain.Attention) != 0 {
		t.Fatalf("without the token: mood=%q headline=%q attention=%d; session members leaked into the summary", plain.Mood, plain.Headline, len(plain.Attention))
	}
	if owner.Mood != MoodWorking {
		t.Fatalf("the owner's mood = %q, want working: the test must have a working session to hide", owner.Mood)
	}
}

// The active-bot count on /office/stats is readable by a joined human, so a
// working session member counts for the owner alone.
func TestOfficeStatsCountsSessionMembersForTheOwnerOnly(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	reconcileSessionsAged(t, b, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	invite, _, err := b.createHumanInvite()
	if err != nil {
		t.Fatalf("create invite: %v", err)
	}
	sessionToken, _, err := b.acceptHumanInvite(invite, "Mira", "browser")
	if err != nil {
		t.Fatalf("accept invite: %v", err)
	}
	active := func(decorate func(*http.Request)) int {
		req := httptest.NewRequest(http.MethodGet, "/office/stats", nil)
		decorate(req)
		rec := httptest.NewRecorder()
		b.withAuth(b.handleOfficeStats)(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("office/stats status = %d body=%s", rec.Code, rec.Body.String())
		}
		var stats OfficeStats
		if err := json.Unmarshal(rec.Body.Bytes(), &stats); err != nil {
			t.Fatal(err)
		}
		return stats.BotsActive
	}
	if got := active(func(r *http.Request) { r.Header.Set("Authorization", "Bearer owner-token") }); got != 1 {
		t.Fatalf("the owner's agents_active = %d, want the one working session", got)
	}
	if got := active(func(r *http.Request) { r.AddCookie(&http.Cookie{Name: humanSessionCookie, Value: sessionToken}) }); got != 0 {
		t.Fatalf("a joined human's agents_active = %d, want 0", got)
	}
}

// Where a member's runtime is written in prose, a session is named by its
// tool, never by the office's own "local-session" kind.
func TestSessionMemberRuntimeIsWrittenAsItsTool(t *testing.T) {
	b := newTestBroker(t)
	reconcileSessionsAged(t, b, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	m := mustSessionMember(t, b, "cc-1a2b3c4d")
	if got := memberRuntimeText(m); got != "Claude Code" {
		t.Fatalf("memberRuntimeText = %q, want Claude Code", got)
	}
	identity := renderBotIdentity(m)
	if !strings.Contains(identity, "- Runtime: Claude Code / claude-opus-5-5[1m]") || strings.Contains(identity, provider.KindLocalSession) {
		t.Fatalf("identity file = %q", identity)
	}
	if got := memberRuntimeText(officeMember{Provider: provider.ProviderBinding{Kind: provider.KindCodex}}); got != provider.KindCodex {
		t.Fatalf("an ordinary bot's runtime text = %q, want its kind unchanged", got)
	}
}

// The binding keeps the bare id each tool takes to address the session:
// for Codex the uuid alone, not the log name with its timestamp.
func TestSessionBindingStoresTheToolsOwnSessionID(t *testing.T) {
	b := newTestBroker(t)
	reconcileSessionsAged(t, b, []agentdetect.Session{
		{ID: testCodexSessionID, Tool: "codex", ToolName: "Codex CLI", Title: "Tidy the migration scripts", Project: "api", Cwd: "/Users/me/api"},
	})
	got := mustSessionMember(t, b, "cx-ccddeeff").Provider.Session
	if got.NativeID != "0199f3aa-7bcd-7e21-9f00-aabbccddeeff" || got.SessionID != testCodexSessionID {
		t.Fatalf("binding = %+v, want the bare uuid beside the scanner id", got)
	}
}

// The roster is ordered before the live moods are known. A session that the
// scan says is working, while its activity snapshot still says idle, must
// still sort above the idle bots, as every other working row does.
func TestNotchKeepsWorkingSessionMembersAboveIdleBots(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	sess.State = agentdetect.SessionQuiet
	sess.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	reconcileSessionsAged(t, b, []agentdetect.Session{sess})
	// Two idle office bots, one either side of the session member.
	b.mu.Lock()
	b.members = append([]officeMember{b.members[0], {Slug: "ava", Name: "Ava"}}, append(b.members[1:], officeMember{Slug: "tess", Name: "Tess"})...)
	b.rebuildMemberIndexLocked()
	if b.activity["cc-1a2b3c4d"].Status != "idle" {
		b.mu.Unlock()
		t.Fatalf("setup: the snapshot must still say idle, got %+v", b.activity["cc-1a2b3c4d"])
	}
	b.mu.Unlock()
	// The scan has moved on: the session is working now.
	sess.State = agentdetect.SessionWorking
	stubLocalSessions(t, []agentdetect.Session{sess})

	req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
	req.Header.Set("Authorization", "Bearer owner-token")
	rec := httptest.NewRecorder()
	b.handleNotchState(rec, req)
	var state notchState
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, a := range state.Agents {
		order = append(order, a.Slug)
	}
	if strings.Join(order, ",") != "cos,cc-1a2b3c4d,ava,tess" {
		t.Fatalf("order = %v, want the lead, then the working session, then the idle bots in roster order", order)
	}
	if notchAgentBySlug(t, state, "cc-1a2b3c4d").Mood != MoodWorking {
		t.Fatalf("the session row is not working: %+v", state.Agents)
	}
}

// evictionFixture is a broker at the cap: sessionMemberCap session members
// named by index (member 0 the oldest), and helpers to drive the registry.
type evictionFixture struct {
	t        *testing.T
	b        *Broker
	all      []agentdetect.Session
	now      time.Time
	newcomer agentdetect.Session
}

func newEvictionFixture(t *testing.T) *evictionFixture {
	t.Helper()
	f := &evictionFixture{t: t, b: newTestBroker(t)}
	for i := 0; i < sessionMemberCap; i++ {
		f.all = append(f.all, claudeTestSession(fmt.Sprintf("claude-code:%08x-0000-4000-8000-000000000000", 0xc0000000+i), fmt.Sprintf("Piece of work %d", i)))
	}
	f.newcomer = claudeTestSession("claude-code:cafe0002-0000-4000-8000-000000000000", "A brand new piece of work")
	f.now = reconcileSessionsAged(t, f.b, f.all)
	f.b.mu.Lock()
	for i := range f.all {
		f.b.findMemberLocked(f.slug(i)).CreatedAt = time.Date(2026, 10, 1, 0, i, 0, 0, time.UTC).Format(time.RFC3339)
	}
	f.b.mu.Unlock()
	if got := len(sessionMemberSlugs(f.b)); got != sessionMemberCap {
		t.Fatalf("setup: session members = %d, want %d", got, sessionMemberCap)
	}
	return f
}

func (f *evictionFixture) slug(i int) string { return fmt.Sprintf("cc-%08x", 0xc0000000+i) }

func (f *evictionFixture) has(slug string) bool {
	return containsString(sessionMemberSlugs(f.b), slug)
}

// tick runs one look at the given sessions, a registry interval later.
func (f *evictionFixture) tick(sessions []agentdetect.Session) {
	f.now = f.now.Add(sessionReconcileEvery)
	f.b.reconcileSessionMembers(f.t.Context(), sessions, f.now)
}

// ticks runs many looks, enough to pass the minimum age several times over.
func (f *evictionFixture) ticks(n int, sessions []agentdetect.Session) {
	for i := 0; i < n; i++ {
		f.tick(sessions)
	}
}

func (f *evictionFixture) with(running []agentdetect.Session, more ...agentdetect.Session) []agentdetect.Session {
	return append(append([]agentdetect.Session{}, running...), more...)
}

// countChanges drains the office change stream and counts members made and
// removed since the last call.
func countMemberChanges(changes <-chan officeChangeEvent) (created, removed int) {
	for {
		select {
		case evt := <-changes:
			switch evt.Kind {
			case "member_created":
				created++
			case "member_removed":
				removed++
			}
		default:
			return created, removed
		}
	}
}

// An eviction at the cap is not final the way a person's removal is. The
// evicted session stays out while its log is silent, comes back under the
// same slug (so the same avatar and DM) once it writes again, and a session
// a person removed never comes back.
func TestEvictedSessionReturnsOnlyWhenItWritesAgain(t *testing.T) {
	f := newEvictionFixture(t)
	b := f.b
	// Something in member 0's DM that is not the human writing to it.
	if _, err := b.PostMessage(f.slug(0), DMSlugFor(f.slug(0)), "Left a note for later.", nil, ""); err != nil {
		t.Fatalf("member 0 posts in its DM: %v", err)
	}

	// Session 0 ends; a newcomer arrives; member 0 is evicted for it.
	f.ticks(8, f.with(f.all[1:], f.newcomer))
	if f.has(f.slug(0)) || !f.has("cc-cafe0002") {
		t.Fatalf("setup: want member 0 evicted for the newcomer: %v", sessionMemberSlugs(b))
	}
	b.mu.Lock()
	persistedAsDismissed := containsString(b.sessionAgents.dismissed, f.all[0].ID)
	b.mu.Unlock()
	if persistedAsDismissed {
		t.Fatal("an eviction was written to the persisted dismissal list; only a person's removal belongs there")
	}
	// A person removes members 5 and 6. That leaves room for two, so the cap
	// is never the reason a session below stays out.
	removeSessionMember(t, b, f.slug(5))
	removeSessionMember(t, b, f.slug(6))

	// Both sessions sit in the scanner's window again, logs untouched, for a
	// long time. There is room, yet neither becomes a member.
	listed := f.with(f.all, f.newcomer)
	f.ticks(60, listed)
	if f.has(f.slug(0)) {
		t.Fatalf("an evicted session whose log did not change was made a member again: %v", sessionMemberSlugs(b))
	}
	if f.has(f.slug(5)) || f.has(f.slug(6)) {
		t.Fatalf("a session a person removed was made a member again: %v", sessionMemberSlugs(b))
	}
	if got := len(sessionMemberSlugs(b)); got != sessionMemberCap-2 {
		t.Fatalf("session members = %d, want two free slots", got)
	}

	// All three write again.
	for _, i := range []int{0, 5, 6} {
		listed[i].UpdatedAt = "2026-10-10T11:30:00Z"
	}
	f.ticks(8, listed)
	if !f.has(f.slug(0)) {
		t.Fatalf("the evicted session wrote again and did not return under its old slug %s: %v", f.slug(0), sessionMemberSlugs(b))
	}
	if f.has(f.slug(5)) || f.has(f.slug(6)) {
		t.Fatalf("a session a person removed came back after writing again: %v", sessionMemberSlugs(b))
	}
	if got := len(sessionMemberSlugs(b)); got != sessionMemberCap-1 {
		t.Fatalf("session members = %d, want one slot still free: the removed sessions stayed out with room to spare", got)
	}
	back := mustSessionMember(t, b, f.slug(0))
	if back.Provider.Session == nil || back.Provider.Session.SessionID != f.all[0].ID {
		t.Fatalf("the returned member is bound to %+v, want session 0", back.Provider.Session)
	}
	// Same slug, so the same DM: what was in it before the eviction is there.
	kept := false
	for _, msg := range b.ChannelMessages(DMSlugFor(f.slug(0))) {
		if msg.Content == "Left a note for later." {
			kept = true
		}
	}
	if !kept {
		t.Fatal("the DM history from before the eviction is gone after the return")
	}
}

// Two ended, unengaged members and one newcomer at the cap: exactly one
// member is removed and one made, and then nothing more happens however
// long the ended sessions sit in the scanner's window.
func TestEvictionAtTheCapDoesNotFlap(t *testing.T) {
	f := newEvictionFixture(t)
	changes, unsubscribe := f.b.SubscribeOfficeChanges(4096)
	defer unsubscribe()

	// Sessions 0 and 1 end as the newcomer arrives.
	f.ticks(8, f.with(f.all[2:], f.newcomer))
	created, removed := countMemberChanges(changes)
	if created != 1 || removed != 1 || f.has(f.slug(0)) || !f.has(f.slug(1)) || !f.has("cc-cafe0002") {
		t.Fatalf("created=%d removed=%d members=%v; want member 0 swapped for the newcomer and nothing else", created, removed, sessionMemberSlugs(f.b))
	}
	// Then the two ended sessions drift in and out of the scanner's window,
	// logs untouched. Whenever session 0 (no member) is listed while session 1
	// (ended, unengaged, has a member) is not, it could take that member's
	// place, and the reverse on the next change: that is the flapping.
	rest := f.with(f.all[2:], f.newcomer)
	for _, listed := range [][]agentdetect.Session{
		f.with(rest, f.all[0]), f.with(rest, f.all[1]), f.with(rest, f.all[0]), rest,
		f.with(rest, f.all[0], f.all[1]), f.with(rest, f.all[0]), f.with(rest, f.all[1]),
	} {
		f.ticks(40, listed)
		if created, removed := countMemberChanges(changes); created != 0 || removed != 0 {
			t.Fatalf("after settling: created=%d removed=%d; the cap is flapping", created, removed)
		}
	}
	if got := len(sessionMemberSlugs(f.b)); got != sessionMemberCap {
		t.Fatalf("session members = %d, want the cap", got)
	}
}

// What was evicted is remembered in memory only. After a restart at the cap,
// with evicted sessions still in the scanner's window and no member, each
// takes the place of one ended, unengaged member, once, and then it is quiet.
func TestEvictionSettlesAfterARestartAtTheCap(t *testing.T) {
	f := newEvictionFixture(t)
	// Before the restart: sessions 0 and 1 are put out for two newcomers.
	second := claudeTestSession("claude-code:cafe0003-0000-4000-8000-000000000000", "Another new piece of work")
	f.ticks(8, f.with(f.all[2:], f.newcomer, second))
	if f.has(f.slug(0)) || f.has(f.slug(1)) || !f.has("cc-cafe0002") || !f.has("cc-cafe0003") {
		t.Fatalf("setup: want members 0 and 1 evicted for the two newcomers: %v", sessionMemberSlugs(f.b))
	}

	// Restart: the roster comes back from disk, the eviction memory does not.
	f.b = reloadedBroker(t, f.b)
	f.b.mu.Lock()
	remembered := len(f.b.sessionAgents.evicted)
	f.b.mu.Unlock()
	if remembered != 0 || len(sessionMemberSlugs(f.b)) != sessionMemberCap {
		t.Fatalf("setup: after the restart evicted=%d members=%d; want none remembered and a full roster", remembered, len(sessionMemberSlugs(f.b)))
	}
	changes, unsubscribe := f.b.SubscribeOfficeChanges(4096)
	defer unsubscribe()

	// Sessions 0 and 1 are in the window with no member. Sessions 2, 3, 4 and
	// 5 have ended, so their members may be put out.
	listed := f.with(f.all[:2], append(append([]agentdetect.Session{}, f.all[6:]...), f.newcomer, second)...)
	f.ticks(12, listed)
	created, removed := countMemberChanges(changes)
	if created != 2 || removed != 2 {
		t.Fatalf("settling after the restart: created=%d removed=%d, want one swap for each of the two memberless sessions", created, removed)
	}
	if !f.has(f.slug(0)) || !f.has(f.slug(1)) || f.has(f.slug(2)) || f.has(f.slug(3)) || !f.has(f.slug(4)) || !f.has(f.slug(5)) {
		t.Fatalf("want the two oldest ended members (2 and 3) swapped out and 4 and 5 kept: %v", sessionMemberSlugs(f.b))
	}
	// And then nothing: no churn on later looks.
	f.ticks(120, listed)
	if created, removed := countMemberChanges(changes); created != 0 || removed != 0 {
		t.Fatalf("after settling: created=%d removed=%d over 120 looks; the roster is churning", created, removed)
	}
	if got := len(sessionMemberSlugs(f.b)); got != sessionMemberCap {
		t.Fatalf("session members = %d, want the cap", got)
	}
}

func openness(ids ...string) sessionOpenness {
	o := sessionOpenness{known: true, open: map[string]agentdetect.OpenSession{}}
	for i, id := range ids {
		o.open[id] = agentdetect.OpenSession{PID: 100 + i}
	}
	return o
}

func sessionEntry(t *testing.T, b *Broker, slug string) (entry, session map[string]any) {
	t.Helper()
	entry = officeMemberEntry(t, fetchOfficeMembers(t, b, b.token), slug)
	session, _ = entry["session"].(map[string]any)
	if session == nil {
		t.Fatalf("@%s has no session object: %v", slug, entry)
	}
	return entry, session
}

// The scanner lists only the newest few logs. A Claude Code session that is
// still open but has dropped out of that list is running, not ended: its
// member stays live and keeps the last thing known about it.
func TestOpenSessionOutsideTheScannerWindowStaysLive(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	sess.State, sess.LastSaid = agentdetect.SessionYourTurn, "Shall I run it on staging?"
	open := openness(sess.ID)
	start := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{sess}, open, start)
	now := start.Add(sessionMemberMinAge + time.Second)
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{sess}, open, now)
	mustSessionMember(t, b, "cc-1a2b3c4d")

	// Many looks in which the scanner no longer lists it, but it is open.
	for i := 0; i < 30; i++ {
		now = now.Add(sessionReconcileEvery)
		b.reconcileSessionMembersWith(t.Context(), nil, open, now)
	}
	entry, session := sessionEntry(t, b, "cc-1a2b3c4d")
	if session["live"] != true || session["state"] != "your_turn" || session["last_said"] != "Shall I run it on staging?" {
		t.Fatalf("open but unlisted: session = %v, want live with its last known state", session)
	}
	if entry["status"] != "idle" || entry["detail"] != "Your turn" {
		t.Fatalf("open but unlisted: status=%v detail=%v", entry["status"], entry["detail"])
	}

	// It closes: the registry no longer has it, and it is still unlisted.
	b.reconcileSessionMembersWith(t.Context(), nil, openness(), now.Add(sessionReconcileEvery))
	if _, session := sessionEntry(t, b, "cc-1a2b3c4d"); session["live"] != false || session["state"] != nil {
		t.Fatalf("closed: session = %v, want live:false and no state", session)
	}
}

// "Working" means the log was written moments ago. With the session out of
// the scanner's list that cannot be confirmed, so it rests as quiet and is
// not shown as busy for as long as its window stays open.
func TestOpenUnlistedSessionIsNotShownAsWorking(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test") // working
	open := openness(sess.ID)
	start := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{sess}, open, start)
	now := start.Add(sessionMemberMinAge + time.Second)
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{sess}, open, now)
	if entry, _ := sessionEntry(t, b, "cc-1a2b3c4d"); entry["status"] != "active" {
		t.Fatalf("setup: listed and working, status = %v", entry["status"])
	}
	b.reconcileSessionMembersWith(t.Context(), nil, open, now.Add(sessionReconcileEvery))
	entry, session := sessionEntry(t, b, "cc-1a2b3c4d")
	if session["live"] != true || session["state"] != "quiet" || entry["status"] != "idle" {
		t.Fatalf("open but unlisted after working: status=%v session=%v, want live and quiet", entry["status"], session)
	}
}

// When the tool says which sessions are open, that decides for Claude Code:
// a session whose log is recent but whose window is gone is closed, while
// Codex, which has no such list, is still judged by the scanner.
func TestKnownOpennessDecidesForClaudeCodeOnly(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	claude := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	codex := agentdetect.Session{ID: testCodexSessionID, Tool: "codex", ToolName: "Codex CLI", Title: "Tidy the migration scripts", Project: "api", Cwd: "/Users/me/api", State: agentdetect.SessionWorking}
	both := []agentdetect.Session{claude, codex}
	start := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	b.reconcileSessionMembersWith(t.Context(), both, openness(claude.ID), start)
	now := start.Add(sessionMemberMinAge + time.Second)
	b.reconcileSessionMembersWith(t.Context(), both, openness(claude.ID), now)

	// Both still listed; the registry is readable and no longer has the
	// Claude Code session. Its title changed in the meantime.
	claude.Title = "Ship the checkout fix"
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{claude, codex}, openness(), now.Add(5*time.Second))
	entry, session := sessionEntry(t, b, "cc-1a2b3c4d")
	if session["live"] != false || entry["status"] != "idle" {
		t.Fatalf("listed but not open: status=%v session=%v, want closed", entry["status"], session)
	}
	if entry["name"] != "Ship the checkout fix" {
		t.Fatalf("a closed but listed session's title is still read: name = %v", entry["name"])
	}
	if entry, session := sessionEntry(t, b, "cx-ccddeeff"); session["live"] != true || entry["status"] != "active" {
		t.Fatalf("codex, listed: status=%v session=%v, want live whatever the Claude Code registry says", entry["status"], session)
	}

	// The registry becomes unreadable (an upgrade moved it): back to the
	// scanner's word, so the listed Claude Code session is live again.
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{claude, codex}, sessionOpenness{}, now.Add(10*time.Second))
	if _, session := sessionEntry(t, b, "cc-1a2b3c4d"); session["live"] != true {
		t.Fatalf("openness unknown: session = %v, want live because the scanner lists it", session)
	}
	// And a Codex session the scanner drops is ended even if some id of its
	// were in the Claude Code list.
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{claude}, openness(claude.ID, codex.ID), now.Add(15*time.Second))
	if _, session := sessionEntry(t, b, "cx-ccddeeff"); session["live"] != false {
		t.Fatalf("codex, unlisted: session = %v, want ended", session)
	}
}

// After a restart nothing has been read of an open session that the scanner
// does not list. It is still live, described by its binding alone.
func TestOpenUnlistedSessionIsLiveAfterARestart(t *testing.T) {
	b := newTestBroker(t)
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})
	b = reloadedBroker(t, b)
	b.token = "owner-token"

	b.reconcileSessionMembersWith(t.Context(), nil, openness(sess.ID), later.Add(time.Minute))
	entry, session := sessionEntry(t, b, "cc-1a2b3c4d")
	if session["live"] != true || session["state"] != "quiet" || session["tool"] != "claude-code" || session["project"] != "shop" || entry["status"] != "idle" {
		t.Fatalf("after a restart: status=%v session=%v, want live, quiet, and its tool and folder from the binding", entry["status"], session)
	}
}

// An open session is never put out at the cap, however old its member and
// whether or not the scanner still lists it.
func TestOpenSessionIsNeverEvicted(t *testing.T) {
	f := newEvictionFixture(t)
	// Sessions 0 and 1 drop out of the scanner's list. Session 0 (the oldest
	// member) is still open; session 1 has really closed.
	open := openness(f.all[0].ID)
	for _, s := range f.all[2:] {
		open.open[s.ID] = agentdetect.OpenSession{PID: 1}
	}
	open.open[f.newcomer.ID] = agentdetect.OpenSession{PID: 2}
	listed := f.with(f.all[2:], f.newcomer)
	for i := 0; i < 8; i++ {
		f.now = f.now.Add(sessionReconcileEvery)
		f.b.reconcileSessionMembersWith(t.Context(), listed, open, f.now)
	}
	if !f.has(f.slug(0)) {
		t.Fatalf("the oldest member was evicted although its session is open: %v", sessionMemberSlugs(f.b))
	}
	if f.has(f.slug(1)) || !f.has("cc-cafe0002") {
		t.Fatalf("want member 1 (closed) put out for the newcomer: %v", sessionMemberSlugs(f.b))
	}
}

// The loop reads what is open from the same cached scan as the sessions.
func TestCachedLocalOpenSessionsFollowsTheScan(t *testing.T) {
	stubLocalSessions(t, []agentdetect.Session{claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")})
	// A stubbed scan with nothing said about openness: unknown.
	cachedLocalSessions(t.Context())
	if got := cachedLocalOpenSessions(); got.known || got.open != nil {
		t.Fatalf("openness = %+v, want unknown", got)
	}
	prev := localOpenSessionsFn
	localOpenSessionsFn = func(context.Context) (map[string]agentdetect.OpenSession, bool) {
		return map[string]agentdetect.OpenSession{testClaudeSessionID: {PID: 4242}}, true
	}
	t.Cleanup(func() { localOpenSessionsFn = prev })
	localSessions.mu.Lock()
	localSessions.list = nil
	localSessions.mu.Unlock()
	cachedLocalSessions(t.Context())
	got := cachedLocalOpenSessions()
	if !got.known || got.open[testClaudeSessionID].PID != 4242 {
		t.Fatalf("openness = %+v, want the stubbed open session", got)
	}
}

// The notch agrees with the roster: a session with a member whose window the
// tool says is gone is one ended row, not a working one, though its log is
// recent enough to be listed.
func TestNotchShowsAListedButClosedSessionAsEnded(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	sess.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})
	closed := sess
	closed.OpenKnown, closed.Open = true, false
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{closed}, openness(), later.Add(5*time.Second))
	stubLocalSessions(t, []agentdetect.Session{closed})

	req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
	req.Header.Set("Authorization", "Bearer owner-token")
	rec := httptest.NewRecorder()
	b.handleNotchState(rec, req)
	var state notchState
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	rows := 0
	for _, a := range state.Agents {
		if a.Name == "Fix the flaky checkout test" {
			rows++
		}
	}
	row := notchAgentBySlug(t, state, "cc-1a2b3c4d")
	if rows != 1 || row.Kind != notchAgentSession || row.State != "" || row.Mood != MoodIdle || row.UpdatedAt != "" {
		t.Fatalf("rows=%d row=%+v, want one ended session row with no live fields", rows, row)
	}
}

// The notch row says whether a session is open: true, false, or nothing at
// all when the tool keeps no list to ask. That holds for a member's row and
// for a session that has no member yet, and a caller without the owner
// token gets no session rows to carry it.
func TestNotchRowsCarryOpenAsATriState(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	mk := func(id, title string) agentdetect.Session {
		s := claudeTestSession(id, title)
		s.UpdatedAt = now
		return s
	}
	// Three sessions with members, three without.
	mOpen := mk("claude-code:aaaa0001-0000-4000-8000-000000000000", "Member, open")
	mClosed := mk("claude-code:aaaa0002-0000-4000-8000-000000000000", "Member, closed")
	mUnlisted := mk("claude-code:aaaa0003-0000-4000-8000-000000000000", "Member, open, not listed")
	codex := agentdetect.Session{ID: testCodexSessionID, Tool: "codex", ToolName: "Codex CLI", Title: "Member, codex", Project: "api", Cwd: "/Users/me/api", State: agentdetect.SessionYourTurn, UpdatedAt: now}
	fOpen := mk("claude-code:bbbb0001-0000-4000-8000-000000000000", "Fresh, open")
	fClosed := mk("claude-code:bbbb0002-0000-4000-8000-000000000000", "Fresh, closed")
	fUnknown := agentdetect.Session{ID: "codex:rollout-2026-10-10T09-15-00-0199f3aa-7bcd-7e21-9f00-000000000009", Tool: "codex", ToolName: "Codex CLI", Title: "Fresh, codex", Project: "api", State: agentdetect.SessionQuiet, UpdatedAt: now}

	b := newTestBroker(t)
	b.token = "owner-token"
	later := reconcileSessionsAged(t, b, []agentdetect.Session{mOpen, mClosed, mUnlisted, codex})
	reg := openness(mOpen.ID, mUnlisted.ID, fOpen.ID)
	stamp := func(s agentdetect.Session) agentdetect.Session {
		if s.Tool == "claude-code" {
			_, s.Open = reg.open[s.ID]
			s.OpenKnown = true
		}
		return s
	}
	listed := []agentdetect.Session{stamp(mOpen), stamp(mClosed), codex, stamp(fOpen), stamp(fClosed), fUnknown}
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{stamp(mOpen), stamp(mClosed), codex}, reg, later.Add(time.Second))
	stubLocalSessions(t, listed)

	fetch := func(token string) (notchState, map[string]map[string]any) {
		req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchState(rec, req)
		var state notchState
		var raw struct {
			Agents []map[string]any `json:"agents"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatal(err)
		}
		byName := map[string]map[string]any{}
		for _, a := range raw.Agents {
			byName[fmt.Sprint(a["name"])] = a
		}
		return state, byName
	}

	_, rows := fetch("owner-token")
	// name -> the "open" key on the wire: true, false, or absent (nil).
	want := map[string]any{
		"Member, open":             true,
		"Member, closed":           false,
		"Member, open, not listed": true,
		"Member, codex":            nil,
		"Fresh, open":              true,
		"Fresh, closed":            false,
		"Fresh, codex":             nil,
	}
	for name, open := range want {
		row, ok := rows[name]
		if !ok {
			t.Fatalf("no row named %q; rows = %v", name, rows)
		}
		if row["kind"] != notchAgentSession {
			t.Fatalf("%q is not a session row: %v", name, row)
		}
		got, present := row["open"]
		if open == nil && present {
			t.Fatalf("%q: open = %v, want the key absent (unknown)", name, got)
		}
		if open != nil && got != open {
			t.Fatalf("%q: open = %v (present=%v), want %v", name, got, present, open)
		}
	}
	// An office bot has no such key.
	if _, present := rows["Chief of Staff"]["open"]; present {
		t.Fatalf("the lead's row carries open: %v", rows["Chief of Staff"])
	}

	// No registry to ask: every session row leaves the key out.
	unknown := []agentdetect.Session{mOpen, mClosed, codex, fOpen, fClosed, fUnknown}
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{mOpen, mClosed, codex}, sessionOpenness{}, later.Add(2*time.Second))
	stubLocalSessions(t, unknown)
	_, rows = fetch("owner-token")
	sessions := 0
	for name, row := range rows {
		if row["kind"] != notchAgentSession {
			continue
		}
		sessions++
		if got, present := row["open"]; present {
			t.Fatalf("registry unknown, yet %q has open = %v", name, got)
		}
	}
	if sessions != 7 {
		t.Fatalf("session rows with the registry unknown = %d, want all 7", sessions)
	}

	// Without the owner token: no session rows, so nothing to carry open.
	state, rows := fetch("")
	if len(state.Agents) == 0 {
		t.Fatal("a caller without the token got no agents at all")
	}
	for name, row := range rows {
		if _, present := row["open"]; present || row["kind"] == notchAgentSession {
			t.Fatalf("without the owner token: row %q = %v", name, row)
		}
	}
}

// The notch reads a scan that can be a few seconds newer than the registry's
// last look. When that scan says a member's session has just closed, the row
// says so at once.
func TestNotchOpenFollowsTheNewerScan(t *testing.T) {
	b := newTestBroker(t)
	b.token = "owner-token"
	sess := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	sess.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	later := reconcileSessionsAged(t, b, []agentdetect.Session{sess})
	// The registry's last look: open.
	b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{sess}, openness(sess.ID), later.Add(time.Second))
	// The scan the notch reads: closed since.
	closed := sess
	closed.OpenKnown, closed.Open = true, false
	stubLocalSessions(t, []agentdetect.Session{closed})

	req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
	req.Header.Set("Authorization", "Bearer owner-token")
	rec := httptest.NewRecorder()
	b.handleNotchState(rec, req)
	var state notchState
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	row := notchAgentBySlug(t, state, "cc-1a2b3c4d")
	if row.Open == nil || *row.Open || row.State != "" {
		t.Fatalf("row = %+v (open=%v), want open false and no live fields", row, row.Open)
	}
}

// Only a session that is open, or whose openness cannot be known, becomes a
// member. One the tool says is closed does not, however recent its log; a
// member whose session closes later stays.
func TestKnownClosedSessionIsNotMadeAMember(t *testing.T) {
	claude := claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	codex := agentdetect.Session{ID: testCodexSessionID, Tool: "codex", ToolName: "Codex CLI", Title: "Tidy the migration scripts", Project: "api", Cwd: "/Users/me/api", State: agentdetect.SessionYourTurn}
	listed := []agentdetect.Session{claude, codex}
	// run looks at the listed sessions for long enough to pass every create rule.
	run := func(b *Broker, open sessionOpenness) time.Time {
		now := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
		for i := 0; i < 12; i++ {
			now = now.Add(sessionReconcileEvery)
			b.reconcileSessionMembersWith(t.Context(), listed, open, now)
		}
		return now
	}

	t.Run("known closed: no member, while Codex beside it still joins", func(t *testing.T) {
		b := newTestBroker(t)
		run(b, openness())
		if got := sessionMemberSlugs(b); len(got) != 1 || got[0] != "cx-ccddeeff" {
			t.Fatalf("session members = %v, want only the Codex session: the Claude Code one is known to be closed", got)
		}
	})
	t.Run("known open: member, and it stays when the session closes", func(t *testing.T) {
		b := newTestBroker(t)
		b.token = "owner-token"
		now := run(b, openness(claude.ID))
		mustSessionMember(t, b, "cc-1a2b3c4d")
		for i := 0; i < 12; i++ {
			now = now.Add(sessionReconcileEvery)
			b.reconcileSessionMembersWith(t.Context(), listed, openness(), now)
		}
		mustSessionMember(t, b, "cc-1a2b3c4d")
		if _, session := sessionEntry(t, b, "cc-1a2b3c4d"); session["live"] != false {
			t.Fatalf("after closing: session = %v, want the member kept and closed", session)
		}
	})
	t.Run("openness unknown: member, as before", func(t *testing.T) {
		b := newTestBroker(t)
		run(b, sessionOpenness{})
		if got := sessionMemberSlugs(b); len(got) != 2 {
			t.Fatalf("session members = %v, want both", got)
		}
	})
	t.Run("closed, then opened again: it becomes a member", func(t *testing.T) {
		b := newTestBroker(t)
		now := run(b, openness())
		for i := 0; i < 12; i++ {
			now = now.Add(sessionReconcileEvery)
			b.reconcileSessionMembersWith(t.Context(), listed, openness(claude.ID), now)
		}
		mustSessionMember(t, b, "cc-1a2b3c4d")
	})
}

// A session put out at the cap comes back when it writes again, but not if
// the tool says it is closed: a late write to a closed session's log does
// not make it a session the person has open.
func TestEvictedSessionThatIsKnownClosedIsNotReCreated(t *testing.T) {
	f := newEvictionFixture(t)
	// Session 0 ends, the newcomer takes its place, then a person frees a slot.
	f.ticks(8, f.with(f.all[1:], f.newcomer))
	removeSessionMember(t, f.b, f.slug(5))
	if f.has(f.slug(0)) || len(sessionMemberSlugs(f.b)) != sessionMemberCap-1 {
		t.Fatalf("setup: want member 0 evicted and one slot free: %v", sessionMemberSlugs(f.b))
	}
	// Session 0 is listed again and its log has moved on.
	listed := f.with(f.all, f.newcomer)
	listed[0].UpdatedAt = "2026-10-10T11:30:00Z"
	everythingButZero := openness()
	for _, s := range listed[1:] {
		everythingButZero.open[s.ID] = agentdetect.OpenSession{PID: 1}
	}
	look := func(open sessionOpenness) {
		for i := 0; i < 12; i++ {
			f.now = f.now.Add(sessionReconcileEvery)
			f.b.reconcileSessionMembersWith(t.Context(), listed, open, f.now)
		}
	}
	look(everythingButZero)
	if f.has(f.slug(0)) {
		t.Fatalf("an evicted session that wrote again while known closed was made a member: %v", sessionMemberSlugs(f.b))
	}
	// The same write with the session open does bring it back: the rule above
	// is what kept it out, not the eviction.
	everythingButZero.open[listed[0].ID] = agentdetect.OpenSession{PID: 7}
	look(everythingButZero)
	if !f.has(f.slug(0)) {
		t.Fatalf("the evicted session is open and wrote again, yet did not return: %v", sessionMemberSlugs(f.b))
	}
}

// The restart case again, with a readable registry: the memberless sessions
// in the scanner's window are known to be closed, so none of them takes a
// member's place. No swaps at all, on the first look or any later one.
func TestRestartAtTheCapCausesNoSwapsForKnownClosedSessions(t *testing.T) {
	f := newEvictionFixture(t)
	second := claudeTestSession("claude-code:cafe0003-0000-4000-8000-000000000000", "Another new piece of work")
	f.ticks(8, f.with(f.all[2:], f.newcomer, second))
	if f.has(f.slug(0)) || f.has(f.slug(1)) {
		t.Fatalf("setup: want members 0 and 1 evicted: %v", sessionMemberSlugs(f.b))
	}
	f.b = reloadedBroker(t, f.b)
	changes, unsubscribe := f.b.SubscribeOfficeChanges(4096)
	defer unsubscribe()
	before := strings.Join(sessionMemberSlugs(f.b), ",")

	// Same window as the unknown-registry test: sessions 0 and 1 listed with
	// no member, 2 to 5 ended. Here the registry says what is open: the
	// sessions that still have members and are listed, and not 0 or 1.
	listed := f.with(f.all[:2], append(append([]agentdetect.Session{}, f.all[6:]...), f.newcomer, second)...)
	open := openness()
	for _, s := range listed[2:] {
		open.open[s.ID] = agentdetect.OpenSession{PID: 1}
	}
	for i := 0; i < 120; i++ {
		f.now = f.now.Add(sessionReconcileEvery)
		f.b.reconcileSessionMembersWith(t.Context(), listed, open, f.now)
	}
	if created, removed := countMemberChanges(changes); created != 0 || removed != 0 {
		t.Fatalf("created=%d removed=%d over 120 looks; known-closed sessions must cause no swaps", created, removed)
	}
	if after := strings.Join(sessionMemberSlugs(f.b), ","); after != before {
		t.Fatalf("the roster changed:\n before %s\n after  %s", before, after)
	}
}
