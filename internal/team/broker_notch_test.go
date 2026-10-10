package team

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/channel"
)

func fetchNotchState(t *testing.T, b *Broker) notchState {
	t.Helper()
	rec := httptest.NewRecorder()
	b.handleNotchState(rec, httptest.NewRequest(http.MethodGet, "/notch/state", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var s notchState
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func notchAgentBySlug(t *testing.T, s notchState, slug string) notchAgent {
	t.Helper()
	for _, a := range s.Agents {
		if a.Slug == slug {
			return a
		}
	}
	t.Fatalf("no notch agent %q in %+v", slug, s.Agents)
	return notchAgent{}
}

func TestNotchStateQuietOffice(t *testing.T) {
	b := newTestBroker(t)
	s := fetchNotchState(t, b)
	if s.Lead == "" || s.LeadDM == "" || !strings.Contains(s.LeadDM, s.Lead) {
		t.Fatalf("lead=%q lead_dm=%q, want the Chief of Staff and its DM", s.Lead, s.LeadDM)
	}
	if s.Mood != MoodIdle || !strings.Contains(s.Headline, "Nothing needs you") {
		t.Fatalf("mood=%q headline=%q", s.Mood, s.Headline)
	}
	if len(s.Agents) == 0 || !s.Agents[0].IsLead {
		t.Fatalf("agents should lead with the Chief of Staff: %+v", s.Agents)
	}
}

func TestNotchStateSurfacesWhatNeedsTheHuman(t *testing.T) {
	b := newTestBroker(t)
	now := time.Now().UTC()
	b.mu.Lock()
	lead := officeLeadSlugFrom(b.members)
	const other = "eng"
	b.members = append(b.members, officeMember{Slug: other, Name: "Engineer"})
	b.memberIndex[other] = len(b.members) - 1
	b.requests = append(b.requests,
		humanInterview{ID: "r-old", Kind: "interview", From: lead, Question: "Which CRM?", CreatedAt: now.Add(-time.Hour).Format(time.RFC3339)},
		humanInterview{ID: "r-block", Kind: "approval", From: other, Title: "Send the launch email?", Question: "Send it?", Blocking: true,
			Options: []interviewOption{{ID: "approve", Label: "Approve"}, {ID: "reject", Label: "Reject"}}, CreatedAt: now.Format(time.RFC3339)},
		humanInterview{ID: "r-secret", Kind: "secret", From: other, Title: "API key", Question: "paste sk-live-123", Secret: true,
			Options: []interviewOption{{ID: "x", Label: "sk-live-123"}}, CreatedAt: now.Format(time.RFC3339)},
		humanInterview{ID: "r-done", From: other, Question: "old", Answered: &interviewAnswer{ChoiceID: "ok"}},
	)
	b.activity[lead] = botActivitySnapshot{Slug: lead, Status: "active", Detail: "drafting response"}
	b.mu.Unlock()

	s := fetchNotchState(t, b)
	if len(s.Attention) != 3 {
		t.Fatalf("attention = %+v, want 3 open requests (answered one dropped)", s.Attention)
	}
	if s.Attention[0].ID != "r-block" {
		t.Fatalf("first attention = %q, want the blocking approval first", s.Attention[0].ID)
	}
	if len(s.Attention[0].Options) != 2 {
		t.Fatalf("approval options = %+v", s.Attention[0].Options)
	}
	for _, a := range s.Attention {
		if a.ID == "r-secret" && (len(a.Options) != 0 || strings.Contains(a.Question, "sk-live")) {
			t.Fatalf("secret request leaked into the notch: %+v", a)
		}
	}
	if s.Mood != MoodNeedsYou || s.Headline != "3 things need you" {
		t.Fatalf("mood=%q headline=%q", s.Mood, s.Headline)
	}
	// A pending ask beats "working": the lead is mid-turn but also waiting on you.
	if got := notchAgentBySlug(t, s, lead).Mood; got != MoodNeedsYou {
		t.Fatalf("lead mood = %q, want needs_you", got)
	}
	if got := notchAgentBySlug(t, s, other).Mood; got != MoodNeedsYou {
		t.Fatalf("%s mood = %q, want needs_you", other, got)
	}
}

func TestNotchMood(t *testing.T) {
	now := time.Now().UTC()
	recent := now.Add(-10 * time.Second).Format(time.RFC3339)
	stale := now.Add(-10 * time.Minute).Format(time.RFC3339)
	cases := []struct {
		name string
		snap botActivitySnapshot
		ask  bool
		want string
	}{
		{"idle", botActivitySnapshot{}, false, MoodIdle},
		{"working", botActivitySnapshot{Status: "active", Detail: "running tool"}, false, MoodWorking},
		{"error", botActivitySnapshot{Status: "error", Detail: "auth failed"}, false, MoodError},
		{"stuck", botActivitySnapshot{Status: "idle", Kind: "stuck"}, false, MoodError},
		{"just done", botActivitySnapshot{Status: "idle", Detail: "reply ready · 3s", LastTime: recent}, false, MoodDone},
		{"done a while ago", botActivitySnapshot{Status: "idle", Detail: "reply ready", LastTime: stale}, false, MoodIdle},
		{"waiting on you", botActivitySnapshot{Status: "active"}, true, MoodNeedsYou},
	}
	for _, tc := range cases {
		if got, _ := notchMood(tc.snap, tc.ask, now); got != tc.want {
			t.Errorf("%s: mood = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestNotchHeadlineSingleAsk(t *testing.T) {
	mood, line := notchHeadline(1, nil, []notchAttention{{From: "eng", FromName: "Engineer", Title: "Merge the PR?"}}, nil)
	if mood != MoodNeedsYou || line != "Engineer needs you: Merge the PR?" {
		t.Fatalf("mood=%q line=%q", mood, line)
	}
	if mood, line := notchHeadline(0, map[string]int{MoodWorking: 2}, nil, nil); mood != MoodWorking || line != "2 bots working" {
		t.Fatalf("mood=%q line=%q", mood, line)
	}
}

// The human answering has none of the asker's context, so the ask brings
// it: which project, what the asker was doing, what was said just before,
// the asker's own brief in full, and what each option would mean.
func TestNotchAttentionCarriesTheFullBrief(t *testing.T) {
	b := newTestBroker(t)
	now := time.Now().UTC()
	longBrief := strings.Repeat("The dry run kept 0 rows. ", 40)
	b.mu.Lock()
	const eng = "eng"
	b.members = append(b.members, officeMember{Slug: eng, Name: "Engineer", Role: "Backend engineer"})
	b.memberIndex[eng] = len(b.members) - 1
	b.channels = append(b.channels, teamChannel{Slug: "checkout", Name: "checkout", Description: "Ship the new checkout this week."})
	b.tasks = append(b.tasks, teamTask{ID: "task-7", Channel: "checkout", Title: "Migrate sessions to the new store", Details: "Move sessions off the old table, then drop it.", Owner: eng})
	for i, text := range []string{"oldest line", "Starting the migration on staging.", "Dry run is clean.", "One thing I cannot verify from here.", "Asking you now."} {
		b.messages = append(b.messages, channelMessage{ID: fmt.Sprintf("m%d", i), From: eng, Channel: "checkout", Content: text, Timestamp: now.Add(time.Duration(i) * time.Minute).Format(time.RFC3339)})
	}
	b.messages = append(b.messages,
		channelMessage{ID: "elsewhere", From: eng, Channel: "other", Content: "not this room", Timestamp: now.Format(time.RFC3339)},
		// The system's echo of the request is left out of "just before".
		channelMessage{ID: "echo", From: "system", Channel: "checkout", Content: "@eng asks you: Run the migration?", Timestamp: now.Add(time.Hour).Format(time.RFC3339)},
	)
	b.requests = append(b.requests,
		humanInterview{ID: "r-1", Kind: "approval", From: eng, Channel: "checkout", IssueID: "task-7", Title: "Run the migration?", Question: "It drops the old sessions table.", Context: longBrief,
			Options:   []interviewOption{{ID: "approve", Label: "Approve", Description: "Runs it on staging now."}, {ID: "reject", Label: "Reject", Description: "Leaves the old table in place."}},
			CreatedAt: now.Format(time.RFC3339)},
		humanInterview{ID: "r-secret", Kind: "secret", From: eng, Channel: "checkout", Title: "API key", Question: "paste it", Context: "sk-live-123", Secret: true, CreatedAt: now.Format(time.RFC3339)},
	)
	b.mu.Unlock()

	s := fetchNotchState(t, b)
	var got *notchAttention
	for i := range s.Attention {
		switch s.Attention[i].ID {
		case "r-1":
			got = &s.Attention[i]
		case "r-secret":
			if s.Attention[i].Brief != nil || s.Attention[i].Context != "" {
				t.Fatalf("secret request carried a brief: %+v", s.Attention[i])
			}
		}
	}
	if got == nil || got.Brief == nil {
		t.Fatalf("no brief on the approval: %+v", s.Attention)
	}
	br := got.Brief
	// The card shows a short lead-in; the brief holds the asker's words in full.
	if len(got.Context) > notchContextMax+3 || len(br.Context) <= len(got.Context) {
		t.Fatalf("card context %d chars, brief context %d chars", len(got.Context), len(br.Context))
	}
	if br.Project != "checkout" || br.ProjectAbout != "Ship the new checkout this week." {
		t.Fatalf("project = %q / %q", br.Project, br.ProjectAbout)
	}
	if br.Task == nil || br.Task.Title != "Migrate sessions to the new store" || !strings.Contains(br.Task.Details, "drop it") {
		t.Fatalf("task = %+v", br.Task)
	}
	if br.AskerRole != "Backend engineer" {
		t.Fatalf("asker role = %q", br.AskerRole)
	}
	// The last few lines of that room, oldest first, and none from elsewhere.
	if len(br.Recent) != notchBriefRecentMax {
		t.Fatalf("recent = %d lines, want %d", len(br.Recent), notchBriefRecentMax)
	}
	if br.Recent[0].Text != "Starting the migration on staging." || br.Recent[len(br.Recent)-1].Text != "Asking you now." {
		t.Fatalf("recent = %+v", br.Recent)
	}
	if got.Options[0].Description != "Runs it on staging now." {
		t.Fatalf("option description missing: %+v", got.Options)
	}
}

// With no linked task, the brief falls back to what the asker is working
// on right now; a DM is not a project.
func TestNotchBriefFallsBackToTheAskersOpenTask(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	const eng = "eng"
	b.members = append(b.members, officeMember{Slug: eng, Name: "Engineer"})
	b.memberIndex[eng] = len(b.members) - 1
	dm := channel.DirectSlug("human", eng)
	b.channels = append(b.channels, teamChannel{Slug: dm, Name: dm, Type: "dm"})
	b.tasks = append(b.tasks, teamTask{ID: "task-9", Title: "Fix the flaky checkout test", Owner: eng})
	b.requests = append(b.requests, humanInterview{ID: "r-2", Kind: "interview", From: eng, Channel: dm, Title: "Request", Question: "Retry or freeze the clock?"})
	b.mu.Unlock()

	s := fetchNotchState(t, b)
	if len(s.Attention) != 1 || s.Attention[0].Brief == nil {
		t.Fatalf("attention = %+v", s.Attention)
	}
	if s.Attention[0].Title != "" {
		t.Fatalf("placeholder title kept: %q", s.Attention[0].Title)
	}
	br := s.Attention[0].Brief
	if br.Project != "" {
		t.Fatalf("a DM was named as a project: %q", br.Project)
	}
	if br.Task == nil || br.Task.Title != "Fix the flaky checkout test" {
		t.Fatalf("task = %+v", br.Task)
	}
}

// The lead is the face of the notch, so by default it is the logo; a look
// the human picked for it wins.
func TestNotchLeadLooksLikeTheLogoByDefault(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	lead := officeLeadSlugFrom(b.members)
	const other = "eng"
	b.members = append(b.members, officeMember{Slug: other, Name: "Engineer"})
	b.memberIndex[other] = len(b.members) - 1
	b.mu.Unlock()

	s := fetchNotchState(t, b)
	got := notchAgentBySlug(t, s, lead).Avatar
	if got == nil || got.Shape != "flower" || got.Color != "#5aa9ff" {
		t.Fatalf("lead avatar = %+v, want the brand flower", got)
	}
	if a := notchAgentBySlug(t, s, other).Avatar; a != nil {
		t.Fatalf("another bot was given the logo: %+v", a)
	}

	b.mu.Lock()
	b.members[b.memberIndex[lead]].Avatar = &MemberAvatar{Shape: "bear", Color: "#ff7a59"}
	b.mu.Unlock()
	if got := notchAgentBySlug(t, fetchNotchState(t, b), lead).Avatar; got == nil || got.Shape != "bear" {
		t.Fatalf("chosen look lost: %+v", got)
	}
}

// stubLocalSessions swaps the machine scan for a fixed list and clears the
// cache around the test.
func stubLocalSessions(t *testing.T, list []agentdetect.Session) {
	t.Helper()
	prev := localSessionsFn
	localSessionsFn = func(context.Context) []agentdetect.Session { return list }
	reset := func() {
		localSessions.mu.Lock()
		localSessions.list = nil
		localSessions.mu.Unlock()
	}
	reset()
	t.Cleanup(func() {
		localSessionsFn = prev
		reset()
	})
}

// The sessions running on this Mac are agents like any other: they join the
// one list after the office bots, each with what it is doing. Only the
// owner's own surfaces see them.
func TestNotchListsRunningSessionsAsAgentsForTheOwnerOnly(t *testing.T) {
	now := time.Now().UTC()
	stubLocalSessions(t, []agentdetect.Session{
		{ID: "claude-code:aaa", Tool: "claude-code", ToolName: "Claude Code", Title: "Fix the flaky checkout test", Project: "shop", Cwd: "/Users/me/shop", State: agentdetect.SessionWorking, UpdatedAt: now.Format(time.RFC3339), Model: "claude-opus-5-5[1m]"},
		{ID: "codex:bbb", Tool: "codex", ToolName: "Codex CLI", Title: "Tidy the migration scripts", Project: "api", State: agentdetect.SessionYourTurn, UpdatedAt: now.Add(-2 * time.Hour).Format(time.RFC3339), LastSaid: "Run them on staging?"},
	})
	b := newTestBroker(t)
	b.token = "owner-token"
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
	busy := notchAgentBySlug(t, owner, "session.claude-code.aaa")
	if busy.Kind != notchAgentSession || busy.Name != "Fix the flaky checkout test" || busy.Mood != MoodWorking || busy.Tool != "claude-code" || busy.Detail != "Working in shop" {
		t.Fatalf("working session = %+v", busy)
	}
	waiting := notchAgentBySlug(t, owner, "session.codex.bbb")
	if waiting.Mood != MoodIdle || waiting.Detail != "Your turn · api" || waiting.LastSaid != "Run them on staging?" {
		t.Fatalf("waiting session = %+v", waiting)
	}
	if !owner.Agents[0].IsLead {
		t.Fatalf("the Chief of Staff still leads: %+v", owner.Agents[0])
	}
	// Every agent says what it runs on, for the badge on its avatar: a
	// session from its own log, a bot from its binding or the default.
	if r := busy.Runtime; r == nil || r.Harness != "claude-code" || r.HarnessName != "Claude Code" || r.ModelLabel != "Opus 5.5" || r.Source != runtimeSourceObserved {
		t.Fatalf("working session runtime = %+v", r)
	}
	if r := waiting.Runtime; r == nil || r.HarnessName != "Codex CLI" || r.Model != "" {
		t.Fatalf("a session whose log names no model shows its tool alone, got %+v", r)
	}
	if r := owner.Agents[0].Runtime; r == nil || r.Harness == "" || r.HarnessName == "" {
		t.Fatalf("an office bot has a runtime too, got %+v", r)
	}
	// The office is idle, a session is busy: the notch says so.
	if owner.Mood != MoodWorking || owner.Headline != "1 working on this Mac" {
		t.Fatalf("mood=%q headline=%q", owner.Mood, owner.Headline)
	}

	for _, a := range fetch("").Agents {
		if a.Kind == notchAgentSession {
			t.Fatalf("a caller without the owner token saw session %+v", a)
		}
	}
}

// A session that just finished its turn celebrates like a bot does, then
// rests while it waits.
func TestNotchSessionMood(t *testing.T) {
	now := time.Now().UTC()
	fresh := agentdetect.Session{State: agentdetect.SessionYourTurn, Project: "shop", UpdatedAt: now.Add(-10 * time.Second).Format(time.RFC3339)}
	if mood, detail := notchSessionMood(fresh, now); mood != MoodDone || detail != "Your turn · shop" {
		t.Fatalf("just finished: %q %q", mood, detail)
	}
	if mood, detail := notchSessionMood(agentdetect.Session{State: agentdetect.SessionQuiet}, now); mood != MoodIdle || detail != "Quiet" {
		t.Fatalf("quiet: %q %q", mood, detail)
	}
}
