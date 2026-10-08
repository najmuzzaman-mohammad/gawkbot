package team

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
