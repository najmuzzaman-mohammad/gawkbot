package team

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/channel"
)

func addNotchBot(b *Broker, slug, name string) {
	b.members = append(b.members, officeMember{Slug: slug, Name: name})
	b.memberIndex[slug] = len(b.members) - 1
}

func addNotchDM(b *Broker, slug, from, content string, at time.Time) {
	b.messages = append(b.messages, channelMessage{
		ID: fmt.Sprintf("m%d", len(b.messages)), From: from, Channel: channel.DirectSlug("human", slug),
		Content: content, Timestamp: at.Format(time.RFC3339),
	})
}

func TestNotchListsABotThatAnsweredTheHuman(t *testing.T) {
	b := newTestBroker(t)
	now := time.Now().UTC()
	idle := botActivitySnapshot{Status: "idle", Detail: "reply ready"}
	b.mu.Lock()
	lead := officeLeadSlugFrom(b.members)
	for _, s := range []string{"eng", "ops", "pm", "old", "chat", "you-last"} {
		addNotchBot(b, s, strings.ToUpper(s))
		b.activity[s] = idle
	}
	addNotchDM(b, "eng", "you", "Fix the login bug", now.Add(-3*time.Minute))
	addNotchDM(b, "eng", "eng", "Fixed it.\nPushed to main.", now.Add(-time.Minute))
	// Answered you, but is working again.
	addNotchDM(b, "ops", "ops", "Done.", now.Add(-time.Minute))
	b.activity["ops"] = botActivitySnapshot{Status: "active"}
	// Answered you, and also asked something: the question is what counts.
	addNotchDM(b, "pm", "pm", "Drafted.", now.Add(-time.Minute))
	b.requests = append(b.requests, humanInterview{ID: "r1", From: "pm", Question: "Which plan?", CreatedAt: now.Format(time.RFC3339)})
	// Answered you nine hours ago.
	addNotchDM(b, "old", "old", "Sent.", now.Add(-9*time.Hour))
	// Finished a turn talking to another bot, in a channel: not your turn.
	b.messages = append(b.messages, channelMessage{ID: "c1", From: "chat", Channel: "launch", Content: "@ops over to you", Tagged: []string{"ops"}, Timestamp: now.Format(time.RFC3339)})
	// In a channel, a reply to the human's message, and one that tags them:
	// both are the human's turn.
	for _, s := range []string{"rep", "tag"} {
		addNotchBot(b, s, strings.ToUpper(s))
		b.activity[s] = idle
	}
	b.messages = append(b.messages,
		channelMessage{ID: "h1", From: "you", Channel: "launch", Content: "Can someone draft the post?", Timestamp: now.Add(-4 * time.Minute).Format(time.RFC3339)},
		channelMessage{ID: "c2", From: "rep", Channel: "launch", Content: "Draft is in the wiki.", ReplyTo: "h1", Timestamp: now.Add(-3 * time.Minute).Format(time.RFC3339)},
		channelMessage{ID: "c3", From: "tag", Channel: "ops", Content: "@you the deploy is green.", Tagged: []string{"you"}, Timestamp: now.Add(-2 * time.Minute).Format(time.RFC3339)},
	)
	// You spoke last in this DM: nothing waits on you.
	addNotchDM(b, "you-last", "you-last", "Here it is.", now.Add(-2*time.Minute))
	addNotchDM(b, "you-last", "you", "thanks", now.Add(-time.Minute))
	// The lead's own box shows its reply.
	addNotchDM(b, lead, lead, "Morning.", now)
	b.activity[lead] = idle
	b.mu.Unlock()

	s := fetchNotchState(t, b)
	from := map[string]notchAttention{}
	for _, f := range s.Finished {
		from[f.From] = f
	}
	if len(s.Finished) != 3 || from["eng"].ID == "" || from["rep"].ID == "" || from["tag"].ID == "" {
		t.Fatalf("finished = %+v, want eng, rep and tag", s.Finished)
	}
	if r := from["rep"].Recap; r == nil || r.Asked != "Can someone draft the post?" {
		t.Fatalf("a reply's recap names what it answered: %+v", from["rep"].Recap)
	}
	got := from["eng"]
	if got.Kind != "finished" || got.Question != "Fixed it. Pushed to main." {
		t.Fatalf("finished item = %+v", got)
	}
	if r := got.Recap; r == nil || r.Asked != "Fix the login bug" || r.Reply != "Fixed it.\nPushed to main." {
		t.Fatalf("recap = %+v", got.Recap)
	}
	if a := notchAgentBySlug(t, s, "eng"); a.State != agentdetect.SessionYourTurn {
		t.Fatalf("eng row = %+v, want state your_turn like a session", a)
	}
	if a := notchAgentBySlug(t, s, "chat"); a.State != "" {
		t.Fatalf("a bot that answered another bot is %q", a.State)
	}
	if len(s.Attention) != 1 || s.Headline != "4 things need you" {
		t.Fatalf("attention=%d headline=%q", len(s.Attention), s.Headline)
	}
}

func TestNotchFinishedTurnHeadlineAndMarkedDone(t *testing.T) {
	b := newTestBroker(t)
	now := time.Now().UTC()
	b.mu.Lock()
	addNotchBot(b, "eng", "Engineer")
	b.activity["eng"] = botActivitySnapshot{Status: "idle"}
	addNotchDM(b, "eng", "eng", "Fixed.", now.Add(-time.Minute))
	b.mu.Unlock()

	s := fetchNotchState(t, b)
	if len(s.Finished) != 1 || s.Mood != MoodNeedsYou || s.Headline != "Engineer finished. Your turn." {
		t.Fatalf("finished=%+v mood=%q headline=%q", s.Finished, s.Mood, s.Headline)
	}

	for _, bad := range []string{`{"id":"r1"}`, `nope`} {
		rec := httptest.NewRecorder()
		b.handleNotchFinishedSeen(rec, httptest.NewRequest(http.MethodPost, "/notch/finished/seen", strings.NewReader(bad)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d, want 400", bad, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	b.handleNotchFinishedSeen(rec, httptest.NewRequest(http.MethodPost, "/notch/finished/seen", strings.NewReader(`{"id":"`+s.Finished[0].ID+`"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("seen status %d", rec.Code)
	}
	if s = fetchNotchState(t, b); len(s.Finished) != 0 || !strings.Contains(s.Headline, "Nothing needs you") {
		t.Fatalf("after done: finished=%+v headline=%q", s.Finished, s.Headline)
	}

	// The next answer is a new turn and shows again.
	b.mu.Lock()
	addNotchDM(b, "eng", "you", "and the other one?", now)
	addNotchDM(b, "eng", "eng", "Fixed that too.", now.Add(time.Second))
	b.mu.Unlock()
	if s = fetchNotchState(t, b); len(s.Finished) != 1 {
		t.Fatalf("next turn hidden: %+v", s.Finished)
	}
}

func TestNotchFinishedSkipsAClosedSession(t *testing.T) {
	closed, open := false, true
	b := newTestBroker(t)
	state := notchState{Agents: []notchAgent{
		{Slug: "session.a", Name: "A", Kind: notchAgentSession, State: agentdetect.SessionYourTurn, UpdatedAt: "2026-10-11T10:00:00Z", Open: &closed},
		{Slug: "session.b", Name: "B", Kind: notchAgentSession, State: agentdetect.SessionYourTurn, UpdatedAt: "2026-10-11T11:00:00Z", Open: &open, LastSaid: "done here"},
		{Slug: "session.c", Name: "C", Kind: notchAgentSession, State: agentdetect.SessionYourTurn, UpdatedAt: "2026-10-11T12:00:00Z"},
		{Slug: "session.d", Name: "D", Kind: notchAgentSession, State: agentdetect.SessionWorking, UpdatedAt: "2026-10-11T12:00:00Z"},
	}}
	got := b.withNotchFinished(state).Finished
	if len(got) != 2 || got[0].From != "session.c" || got[1].From != "session.b" || got[1].Question != "done here" {
		t.Fatalf("finished = %+v, want c then b, newest first, closed a and working d left out", got)
	}
}

// Done survives a restart: a new broker on the same state folder still
// hides the turn, and marks older than the window are dropped.
func TestNotchFinishedDoneSurvivesARestart(t *testing.T) {
	b := newTestBroker(t)
	now := time.Now().UTC()
	if err := b.markNotchSeen("finished:eng@1", now); err != nil {
		t.Fatal(err)
	}
	if err := b.markNotchSeen("finished:old@1", now.Add(-9*time.Hour)); err != nil {
		t.Fatal(err)
	}
	again := NewBrokerAt(b.statePath)
	seen := again.notchSeenIDs(now)
	if !seen["finished:eng@1"] || seen["finished:old@1"] {
		t.Fatalf("after restart seen = %v, want eng only", seen)
	}
}
