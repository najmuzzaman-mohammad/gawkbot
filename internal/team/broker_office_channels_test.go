package team

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
)

// TestHandleGenerateMember_RejectsNonPostAndUnauth verifies the method
// gate and the auth gate on /office/generate-member: writes to broker
// state must not be reachable via GET, and unauthenticated callers must
// be rejected when wrapped in b.requireAuth.
func TestHandleGenerateMember_RejectsNonPostAndUnauth(t *testing.T) {
	b := newTestBroker(t)
	srv := httptest.NewServer(b.requireAuth(b.handleGenerateMember))
	defer srv.Close()

	// Method gate: GET hits the wrapped handler (auth passes for empty
	// header path? — auth requires token; we pass it). Use POST without
	// auth to confirm 401, and GET with auth to confirm 405.
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader("{}"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post no-auth: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("POST no auth: expected 401, got %d", resp.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get with auth: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET with auth: expected 405, got %d", resp.StatusCode)
	}
}

func TestHandleGenerateChannelPropagatesRequestCancellation(t *testing.T) {
	b := newTestBroker(t)
	seenErr := make(chan error, 1)
	b.SetGenerateChannelFn(func(ctx context.Context, prompt string) (generatedChannelTemplate, error) {
		<-ctx.Done()
		seenErr <- ctx.Err()
		return generatedChannelTemplate{}, ctx.Err()
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(
		http.MethodPost,
		"/channels/generate",
		strings.NewReader(`{"prompt":"design review room"}`),
	).WithContext(ctx)
	rec := httptest.NewRecorder()

	b.handleGenerateChannel(rec, req)

	select {
	case err := <-seenErr:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("generate channel provider err = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for generate channel provider to receive cancellation")
	}
	if rec.Code != http.StatusRequestTimeout {
		t.Fatalf("expected 408 for cancelled generation, got %d", rec.Code)
	}
}

// TestHandleCreateDM_RequiresPOST locks the method gate. The handler
// mutates broker state (creates a channel) so drift to allow GET would
// open it to log-tailing tools and CSRF. Wrap with b.requireAuth so
// the auth gate is also pinned — a regression that drops requireAuth
// from the route registration would otherwise be invisible.
func TestHandleCreateDM_RequiresPOST(t *testing.T) {
	b := newTestBroker(t)
	srv := httptest.NewServer(b.requireAuth(b.handleCreateDM))
	defer srv.Close()

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		req, _ := http.NewRequest(method, srv.URL, nil)
		req.Header.Set("Authorization", "Bearer "+b.Token())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s: expected 405, got %d", method, resp.StatusCode)
		}
	}

	// Auth gate: unauthenticated POST must 401, not 4xx-from-handler.
	resp, err := http.Post(srv.URL, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("unauth post: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("unauth POST: expected 401, got %d", resp.StatusCode)
	}
}

func TestNewBrokerSeedsDefaultOfficeRosterOnFreshState(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // isolate from ~/.wuphf company.json (e.g. RevOps pack)
	b := newRawTestBroker(t)
	members := b.OfficeMembers()
	// This used to demand two or more members, back when the default roster
	// was the lead plus an App Builder, a Librarian, and a planner/executor/
	// reviewer trio. Those five are retired as defaults, so the size assertion
	// is now owned by broker_default_roster_test.go ("exactly [ceo]"). What
	// this test still owns is the pair of properties below: the lead exists,
	// and nobody on the roster is stranded without a way to be reached.
	if len(members) == 0 {
		t.Fatalf("expected a default office roster on fresh state, got 0 members")
	}
	b.mu.Lock()
	ceo := b.findMemberLocked("ceo")
	b.mu.Unlock()
	if ceo == nil {
		t.Fatalf("expected ceo to be present in default office roster, got %+v", members)
	}
	// This used to assert that #general existed and held the whole roster.
	// With #general retired the equivalent property is that every bot on
	// the roster is REACHABLE -- which now means a DM each, not one shared
	// room. The point of the old assertion was "nobody is stranded off the
	// only conversation", and that is what is checked here.
	b.mu.Lock()
	defer b.mu.Unlock()
	if !generalChannelEnabled() && b.findChannelLocked(GeneralChannelSlug) != nil {
		t.Error("#general is retired and must not be seeded")
	}
	for _, m := range members {
		if isHumanMessageSender(m.Slug) {
			continue
		}
		if b.findChannelLocked(channel.DirectSlug("human", m.Slug)) == nil {
			t.Errorf("bot %q has no DM: it is on the roster and unreachable", m.Slug)
		}
	}
}

func TestNewBrokerSeedsBlueprintBackedOfficeRosterOnFreshState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Pair HOME with WUPHF_RUNTIME_HOME so config.RuntimeHomeDir (which
	// prefers the env override) resolves to this test's tmpdir. Without
	// it the process-level leaked runtime-home from worktree_guard_test
	// wins and the manifest below is invisible to the blueprint loader.
	t.Setenv("WUPHF_RUNTIME_HOME", home)
	manifestPath := filepath.Join(home, ".wuphf", "company.json")
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o700); err != nil {
		t.Fatalf("mkdir manifest dir: %v", err)
	}
	raw := `{
  "name": "Blueprint Office",
  "description": "Refs only manifest",
  "blueprint_refs": [
    {"kind":"operation","id":"youtube-factory","source":"test"}
  ]
}`
	if err := os.WriteFile(manifestPath, []byte(raw), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	b := newTestBroker(t)
	members := b.OfficeMembers()
	if len(members) < 2 {
		t.Fatalf("expected blueprint-backed default office roster, got %d members", len(members))
	}
	var foundResearch bool
	for _, member := range members {
		if member.Slug == "research-lead" {
			foundResearch = true
			break
		}
	}
	if !foundResearch {
		t.Fatalf("expected blueprint-backed office roster to include youtube starter members, got %+v", members)
	}
}

func TestOfficeMemberLifecycle(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	b.members = append(b.members, officeMember{
		Slug:      "growthops",
		Name:      "Growth Ops",
		Role:      "Growth Ops",
		CreatedBy: "you",
	})
	if err := b.saveLocked(); err != nil {
		b.mu.Unlock()
		t.Fatalf("saveLocked failed: %v", err)
	}
	b.mu.Unlock()

	reloaded := reloadedBroker(t, b)
	if reloaded.findMemberLocked("growthops") == nil {
		t.Fatal("expected custom office member to persist")
	}
}

func TestChannelMembersRejectUnknownOfficeMember(t *testing.T) {
	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("failed to start broker: %v", err)
	}
	defer b.Stop()

	base := fmt.Sprintf("http://%s", b.Addr())
	body, _ := json.Marshal(map[string]any{
		"action":  "add",
		"channel": "general",
		"slug":    "ghost",
	})
	req, _ := http.NewRequest(http.MethodPost, base+"/channel-members", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+b.Token())
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown member, got %d", resp.StatusCode)
	}
}

// TestChannelMembersRejectDisableOrRemoveOfLead verifies that /channel-members
// refuses to disable or remove a BuiltIn member (lead bot) from any
// channel. Before this guard was generalized, only the hardcoded "ceo"
// slug was protected — blueprint teams whose lead is something else (e.g.
// niche-crm uses "operator") could silently lose their lead from #general.
func TestChannelMembersRejectDisableOrRemoveOfLead(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	now := time.Now().UTC().Format(time.RFC3339)
	b.members = []officeMember{
		{Slug: "operator", Name: "Operator", Role: "Operator", BuiltIn: true, CreatedBy: "wuphf", CreatedAt: now},
		{Slug: "builder", Name: "Builder", Role: "Builder", CreatedBy: "wuphf", CreatedAt: now},
	}
	b.channels = []teamChannel{
		{Slug: "general", Name: "general", Members: []string{"operator", "builder"}, CreatedBy: "wuphf", CreatedAt: now, UpdatedAt: now},
	}
	b.mu.Unlock()
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("failed to start broker: %v", err)
	}
	defer b.Stop()

	base := fmt.Sprintf("http://%s", b.Addr())
	for _, action := range []string{"disable", "remove"} {
		body, _ := json.Marshal(map[string]any{
			"action":  action,
			"channel": "general",
			"slug":    "operator",
		})
		req, _ := http.NewRequest(http.MethodPost, base+"/channel-members", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+b.Token())
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request failed: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("action=%s: expected 400 (cannot remove/disable lead), got %d", action, resp.StatusCode)
		}
	}

	// After the rejected attempts, operator must still be a member of #general.
	b.mu.Lock()
	var found bool
	for _, ch := range b.channels {
		if ch.Slug == "general" {
			for _, m := range ch.Members {
				if m == "operator" {
					found = true
					break
				}
			}
			break
		}
	}
	b.mu.Unlock()
	if !found {
		t.Fatalf("expected operator to remain in #general after rejected disable/remove")
	}
}

// TestBrokerOnboardingRoutesRequireAuth verifies the CSO auth wrapping — a
// caller that can reach the broker port but does not hold the token must
// NOT be able to POST /onboarding/complete (which seeds the team and fires
// the first CEO turn) or read /onboarding/state.
func TestBrokerOnboardingRoutesRequireAuth(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()

	base := "http://" + b.Addr()
	client := &http.Client{Timeout: 2 * time.Second}

	// Every onboarding route must 401 without a token.
	for _, path := range []string{
		"/onboarding/state",
		"/onboarding/prereqs",
		"/onboarding/templates",
		"/onboarding/blueprints",
	} {
		resp, err := client.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("GET %s without auth: status=%d, want 401", path, resp.StatusCode)
		}
	}

	// /onboarding/complete is the big one — seeds the team + posts the first
	// task. Must reject unauthenticated POSTs before decoding the body.
	resp, err := client.Post(base+"/onboarding/complete", "application/json",
		strings.NewReader(`{"task":"pwn","skip_task":false}`))
	if err != nil {
		t.Fatalf("POST /onboarding/complete: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("POST /onboarding/complete without auth: status=%d, want 401", resp.StatusCode)
	}

	// With the token, /onboarding/state returns 200 (sanity check the wrapping
	// hasn't broken the happy path).
	req, _ := http.NewRequest(http.MethodGet, base+"/onboarding/state", nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /onboarding/state with auth: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /onboarding/state with auth: status=%d, want 200", resp.StatusCode)
	}
}

func TestNormalizeChannelSlugStripsLeadingHash(t *testing.T) {
	if got := normalizeChannelSlug("#youtube-factory"); got != "youtube-factory" {
		t.Fatalf("expected leading hash to be stripped, got %q", got)
	}
	if got := normalizeChannelSlug("  #General  "); got != "general" {
		t.Fatalf("expected spaced channel mention to normalize, got %q", got)
	}
}

func TestChannelDescriptionsAreVisibleButContentStaysRestricted(t *testing.T) {
	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("failed to start broker: %v", err)
	}
	defer b.Stop()

	base := fmt.Sprintf("http://%s", b.Addr())
	createOfficeMemberForTest(t, base, b.Token(), "pm", "Product Manager", "Product Manager")
	createOfficeMemberForTest(t, base, b.Token(), "fe", "Frontend Engineer", "Frontend Engineer")
	createOfficeMemberForTest(t, base, b.Token(), "cmo", "CMO", "CMO")

	// The room is a BRIDGED channel minted through createChannelLocked, not an
	// ordinary named room posted to /channels.
	//
	// Two gates moved under this test. Named-channel create answers 409 at the
	// HTTP boundary, and GET /channels withholds ordinary named rooms from the
	// listing entirely. Bridged rooms are exempt from both — a Slack channel is
	// how external messages arrive, so hiding it would strand every message
	// that came in through it — which makes a bridged room the surviving
	// surface where "description public, content private" still has to hold.
	// That property is what this test is about, and it is unchanged.
	b.mu.Lock()
	_, cerr := b.createChannelLocked(channelCreateInput{
		Slug:        "launch",
		Name:        "launch",
		Description: "Launch planning and launch-readiness work.",
		Members:     []string{"pm", "fe"},
		CreatedBy:   "ceo",
		Surface:     &channelSurface{Provider: "slack", RemoteID: "C0LAUNCH", RemoteTitle: "launch"},
	})
	b.mu.Unlock()
	if cerr != nil {
		t.Fatalf("create channel failed: %d %s", cerr.Code, cerr.Msg)
	}

	req, _ := http.NewRequest(http.MethodGet, base+"/channels", nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get channels failed: %v", err)
	}
	defer resp.Body.Close()
	var channelList struct {
		Channels []teamChannel `json:"channels"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&channelList); err != nil {
		t.Fatalf("decode channels: %v", err)
	}
	var launch *teamChannel
	for i := range channelList.Channels {
		if channelList.Channels[i].Slug == "launch" {
			launch = &channelList.Channels[i]
			break
		}
	}
	if launch == nil {
		t.Fatal("expected launch channel in channel list")
	}
	if launch.Description != "Launch planning and launch-readiness work." {
		t.Fatalf("unexpected launch description: %q", launch.Description)
	}
	if !containsString(launch.Members, "ceo") || !containsString(launch.Members, "pm") || !containsString(launch.Members, "fe") {
		t.Fatalf("expected create payload members plus CEO in new channel, got %+v", launch.Members)
	}

	req, _ = http.NewRequest(http.MethodGet, base+"/messages?channel=launch&my_slug=cmo", nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get messages as non-member failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for non-member channel messages, got %d", resp.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, base+"/messages?channel=launch&my_slug=ceo", nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get messages as ceo failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for CEO channel messages, got %d", resp.StatusCode)
	}
}

// TestChannelCreateRejectsReservedSlugs guards against a privilege-escalation
// shape: canAccessChannelLocked treats a small set of slugs ("system", "nex",
// "you", "human") as universally trusted senders. A user-created channel
// sharing one of those slugs would let every trusted-sender slug read + post
// in it without an explicit Members entry. "ceo", the Librarian and the App
// Builder are reserved for a second reason — a channel that shadows a bot
// slug breaks DM slug resolution and @-mention routing.
//
// This used to drive POST /channels. Named channels are retired, so that
// handler now answers 409 before it ever reaches the guard, and the test
// passed 409-for-400 without exercising anything. The guard itself did not
// move: it lives in createChannelLocked, which is still reached by the Slack
// bridge, the Telegram bridge, and the app-<id> edit thread. Those callers are
// exactly who can still mint a channel, so they are who this now tests.
func TestChannelCreateRejectsReservedSlugs(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, reserved := range []string{"system", "nex", "you", "human", "ceo", LibrarianSlug, appBuilderSlug} {
		ch, cerr := b.createChannelLocked(channelCreateInput{
			Slug:      reserved,
			Name:      reserved,
			CreatedBy: "ceo",
		})
		if cerr == nil {
			t.Fatalf("create %q: expected a refusal, got channel %+v", reserved, ch)
		}
		if cerr.Code != http.StatusBadRequest {
			t.Fatalf("create %q: expected 400, got %d (%s)", reserved, cerr.Code, cerr.Msg)
		}
	}

	// Sanity: an ordinary slug still creates. Without this the loop above
	// would pass just as well if every create were broken.
	ch, cerr := b.createChannelLocked(channelCreateInput{
		Slug:      "feature-launch",
		Name:      "Feature Launch",
		CreatedBy: "ceo",
	})
	if cerr != nil {
		t.Fatalf("create feature-launch: unexpected refusal %d (%s)", cerr.Code, cerr.Msg)
	}
	if ch == nil || ch.Slug != "feature-launch" {
		t.Fatalf("create feature-launch: got %+v", ch)
	}
}

// Regression for "empty slug normalized to general, falls through to
// 'channel already exists' instead of 'slug required'". The fix validates
// the raw slug before normalizeChannelSlug rewrites whitespace to "general".
//
// Driven through createChannelLocked for the same reason as the reserved-slug
// test above: POST /channels now 409s on the named-channel retirement before
// the validation runs, and the ordering bug this pins lives in the helper.
func TestChannelCreateRejectsEmptySlug(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, raw := range []string{"", "   ", "\t"} {
		ch, cerr := b.createChannelLocked(channelCreateInput{
			Slug:      raw,
			Name:      "anything",
			CreatedBy: "ceo",
		})
		if cerr == nil {
			t.Fatalf("create empty slug %q: expected a refusal, got channel %+v", raw, ch)
		}
		if cerr.Code != http.StatusBadRequest {
			t.Fatalf("create empty slug %q: expected 400, got %d (%s)", raw, cerr.Code, cerr.Msg)
		}
		// The message must name the missing field. "channel already exists"
		// (what the pre-fix code said, because "" normalized to "general")
		// sent people looking for a duplicate that was not there.
		if !strings.Contains(strings.ToLower(cerr.Msg), "slug") {
			t.Fatalf("create empty slug %q: expected the error to mention 'slug', got %q", raw, cerr.Msg)
		}
	}
}

func TestChannelUpdateMutatesDescriptionAndMembers(t *testing.T) {
	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("failed to start broker: %v", err)
	}
	defer b.Stop()

	base := fmt.Sprintf("http://%s", b.Addr())
	createOfficeMemberForTest(t, base, b.Token(), "research-lead", "Research Lead", "Research")
	createOfficeMemberForTest(t, base, b.Token(), "scriptwriter", "Scriptwriter", "Scripts")
	createOfficeMemberForTest(t, base, b.Token(), "growth-ops", "Growth Ops", "Growth")

	// Seed room via createChannelLocked: named-channel CREATE is retired at the
	// HTTP boundary, but UPDATE — the subject of this test — is not gated, and
	// the rooms that still exist (bridge channels, app threads, anything on
	// disk from before the retirement) must stay editable.
	b.mu.Lock()
	_, cerr := b.createChannelLocked(channelCreateInput{
		Slug:        "yt-research",
		Name:        "yt-research",
		Description: "Old description",
		Members:     []string{"research-lead"},
		CreatedBy:   "ceo",
	})
	if cerr == nil {
		if ch := b.findChannelLocked("yt-research"); ch != nil {
			ch.Disabled = []string{"scriptwriter"}
		}
	}
	b.mu.Unlock()
	if cerr != nil {
		t.Fatalf("create seed channel failed: %d %s", cerr.Code, cerr.Msg)
	}

	updateBody, _ := json.Marshal(map[string]any{
		"action":      "update",
		"slug":        "yt-research",
		"name":        "yt-research",
		"description": "Search demand, topic scoring, and proof packets.",
		"members":     []string{"research-lead", "scriptwriter", "growth-ops"},
		"created_by":  "ceo",
	})
	req, _ := http.NewRequest(http.MethodPost, base+"/channels", bytes.NewReader(updateBody))
	req.Header.Set("Authorization", "Bearer "+b.Token())
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("update channel failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200 updating channel, got %d: %s", resp.StatusCode, raw)
	}

	var payload struct {
		Channel teamChannel `json:"channel"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if payload.Channel.Description != "Search demand, topic scoring, and proof packets." {
		t.Fatalf("unexpected description after update: %q", payload.Channel.Description)
	}
	if !containsString(payload.Channel.Members, "ceo") || !containsString(payload.Channel.Members, "scriptwriter") || !containsString(payload.Channel.Members, "growth-ops") {
		t.Fatalf("expected updated member roster plus CEO, got %+v", payload.Channel.Members)
	}
	if containsString(payload.Channel.Disabled, "scriptwriter") {
		t.Fatalf("expected disabled list to drop removed/now-enabled members, got %+v", payload.Channel.Disabled)
	}
}

func createOfficeMemberForTest(t *testing.T, base, token, slug, name, role string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"action":     "create",
		"slug":       slug,
		"name":       name,
		"role":       role,
		"created_by": "ceo",
	})
	req, _ := http.NewRequest(http.MethodPost, base+"/office-members", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("create office member %s failed: %v", slug, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200 creating office member %s, got %d: %s", slug, resp.StatusCode, raw)
	}
}

func TestNormalizeLoadedStateRepopulatesGeneralFromOfficeRoster(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	b.members = []officeMember{
		{Slug: "ceo", Name: "CEO", Role: "CEO", BuiltIn: true},
		{Slug: "pm", Name: "Product Manager", Role: "Product Manager"},
		{Slug: "fe", Name: "Frontend Engineer", Role: "Frontend Engineer"},
	}
	b.channels = []teamChannel{{
		Slug:        "general",
		Name:        "general",
		Description: "Company-wide room",
		Members:     []string{"ceo"},
	}}

	b.normalizeLoadedStateLocked()

	ch := b.findChannelLocked("general")
	if ch == nil {
		t.Fatal("expected general channel after normalization")
	}
	if !containsString(ch.Members, "ceo") || !containsString(ch.Members, "pm") || !containsString(ch.Members, "fe") {
		t.Fatalf("expected general channel to be repopulated from office roster, got %+v", ch.Members)
	}
}

func TestEnsureDefaultOfficeMembersSeedsWhenEmpty(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	b.members = nil
	b.ensureDefaultOfficeMembersLocked()
	got := len(b.members)
	b.mu.Unlock()
	if got == 0 {
		t.Fatalf("expected defaults to be seeded when members empty, got 0")
	}
	defaults := defaultOfficeMembers()
	if len(defaults) != got {
		t.Fatalf("expected exactly the default roster (len=%d), got len=%d", len(defaults), got)
	}
}

// REGRESSION: if a blueprint has seeded members (e.g. operator/planner/builder/
// growth/reviewer for niche-crm), ensureDefaultOfficeMembersLocked must NOT
// append ceo/planner/executor/reviewer on top.
func TestEnsureDefaultOfficeMembersNoOpWhenNonEmpty(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	b.members = []officeMember{
		{Slug: "operator", Name: "Operator", Role: "Operator", BuiltIn: true},
		{Slug: "builder", Name: "Builder", Role: "Builder"},
	}
	b.ensureDefaultOfficeMembersLocked()
	got := make([]string, 0, len(b.members))
	for _, m := range b.members {
		got = append(got, m.Slug)
	}
	b.mu.Unlock()

	want := []string{"operator", "builder"}
	if len(got) != len(want) {
		t.Fatalf("expected roster unchanged %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected roster unchanged %v, got %v", want, got)
		}
	}
	for _, m := range got {
		if m == "ceo" || m == "planner" || m == "executor" || m == "reviewer" {
			t.Fatalf("default slug %q appended into blueprint roster; roster=%v", m, got)
		}
	}
}

// REGRESSION: simulate a fully-seeded blueprint team, save to disk, load into
// a fresh broker, confirm the team survives unchanged. This is the load-path
// leak the design doc calls out — prior append-behavior in
// ensureDefaultOfficeMembersLocked (called from Broker.Load() at broker.go:2260)
// silently re-added ceo/planner/executor/reviewer.
func TestLoadDoesNotAppendDefaultsAfterBlueprintSeed(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	now := time.Now().UTC().Format(time.RFC3339)
	b.members = []officeMember{
		{Slug: "operator", Name: "Operator", Role: "Operator", BuiltIn: true, CreatedBy: "wuphf", CreatedAt: now},
		{Slug: "planner", Name: "Planner", Role: "Planner", CreatedBy: "wuphf", CreatedAt: now},
		{Slug: "builder", Name: "Builder", Role: "Builder", CreatedBy: "wuphf", CreatedAt: now},
		{Slug: "growth", Name: "Growth", Role: "Growth", CreatedBy: "wuphf", CreatedAt: now},
		{Slug: "reviewer", Name: "Reviewer", Role: "Reviewer", CreatedBy: "wuphf", CreatedAt: now},
	}
	// Seed a task so saveLocked doesn't short-circuit on default state.
	b.tasks = []teamTask{{ID: "niche-crm-1", Channel: "general", Title: "Choose the niche", status: "open", CreatedBy: "wuphf", CreatedAt: now, UpdatedAt: now}}
	if err := b.saveLocked(); err != nil {
		b.mu.Unlock()
		t.Fatalf("saveLocked failed: %v", err)
	}
	b.mu.Unlock()

	reloaded := reloadedBroker(t, b)
	reloaded.mu.Lock()
	slugs := make([]string, 0, len(reloaded.members))
	for _, m := range reloaded.members {
		slugs = append(slugs, m.Slug)
	}
	reloaded.mu.Unlock()

	// The curated blueprint roster must survive reload EXACTLY — no additions
	// at all.
	//
	// This assertion used to carry two exceptions: the Librarian and the App
	// Builder, "the universal built-ins added to every roster on load". Those
	// two exceptions were the load-time back-fill, and the back-fill was how
	// the founder's removal of both bots kept undoing itself — the seed edit
	// landed, and the next boot appended them again. The back-fill is deleted,
	// so the exceptions are too, and this test now fails if either one comes
	// back.
	want := []string{"operator", "planner", "builder", "growth", "reviewer"}
	if len(slugs) != len(want) {
		t.Fatalf("expected blueprint roster %v to survive reload untouched, got %v", want, slugs)
	}
	for i := range want {
		if slugs[i] != want[i] {
			t.Fatalf("expected blueprint roster %v to survive reload untouched, got %v", want, slugs)
		}
	}
	for _, s := range slugs {
		switch s {
		case "ceo", "executor", LibrarianSlug, appBuilderSlug:
			t.Fatalf("slug %q was appended to the reloaded roster: a back-fill is live again (%v)", s, slugs)
		}
	}
}
