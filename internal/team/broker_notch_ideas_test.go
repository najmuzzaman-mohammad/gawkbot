package team

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
)

func ideasTestConnected() map[string]curatedComposioToolkit {
	out := map[string]curatedComposioToolkit{}
	for _, t := range curatedComposioToolkits {
		if t.platform == "github" || t.platform == "gmail" {
			out[t.platform] = t
		}
	}
	return out
}

func ideasTestEvidence() []notchIdeaEvidence {
	return []notchIdeaEvidence{
		{ID: "github-1", Platform: "github", Text: "#4097 Ship the new deploy pipeline · open"},
		{ID: "github-2", Platform: "github", Text: "#4101 Fix flaky checkout test · open"},
		{ID: "gmail-1", Platform: "gmail", Text: "Invoice from Acme · unread"},
	}
}

func ideasTestCheck(b *Broker) notchIdeaCheck {
	chk := notchIdeaCheck{Connected: ideasTestConnected(), Evidence: map[string]notchIdeaEvidence{}, Members: map[string]bool{}, Now: time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)}
	for _, e := range ideasTestEvidence() {
		chk.Evidence[e.ID] = e
	}
	for _, m := range b.OfficeMembers() {
		chk.Members[strings.ToLower(m.Name)] = true
		chk.Members[strings.ToLower(m.Slug)] = true
	}
	return chk
}

const ideasJudgeReply = `Here you go:
{"ideas":[
 {"name":"Release Checker","role":"Reads what waits on the deploy","integration":"github","promise":"Before #4097 goes to production, I will read every change waiting on the deploy and call go or no go.","rationale":"Two PRs wait on it right now.","cadence":"0 9 * * 1-5","first_task":"Read #4097 and #4101 and say whether they are safe to ship.","evidence":["github-1","github-2"]},
 {"name":"Inbox Sorter","role":"Sorts the inbox","integration":"notion","promise":"I sort things.","rationale":"","cadence":"","first_task":"","evidence":["gmail-1"]},
 {"name":"Borrower","role":"","integration":"github","promise":"I cite what I did not see.","rationale":"","cadence":"","first_task":"","evidence":["gmail-1"]},
 {"name":"Too Often","role":"","integration":"github","promise":"I run every minute.","rationale":"","cadence":"* * * * *","first_task":"","evidence":["github-1"]},
 {"name":"Chief of Staff","role":"","integration":"github","promise":"I take a name that is taken.","rationale":"","cadence":"","first_task":"","evidence":["github-1"]},
 {"name":"Invoice Watcher","role":"Watches invoices","integration":"gmail","promise":"When an invoice lands, like the one from Acme, I will log it and say so.","rationale":"One is unread now.","cadence":"","first_task":"Log the Acme invoice.","evidence":["gmail-1"]}
]}`

func TestNotchIdeaDraftsAreVettedBeforeTheyBecomeCards(t *testing.T) {
	b := newTestBroker(t)
	drafts := parseNotchIdeaDrafts(ideasJudgeReply)
	if len(drafts) != 6 {
		t.Fatalf("parsed %d drafts", len(drafts))
	}
	chk := ideasTestCheck(b)
	var kept []notchIdea
	var reasons []string
	for _, d := range drafts {
		idea, why := vetNotchIdea(d, chk)
		if why != "" {
			reasons = append(reasons, why)
			continue
		}
		kept = append(kept, idea)
	}
	if len(kept) != 2 || kept[0].Name != "Release Checker" || kept[1].Name != "Invoice Watcher" {
		t.Fatalf("kept %+v", kept)
	}
	want := []string{"integration not connected", "evidence not from the scan", "cadence too often", "a bot has that name"}
	if strings.Join(reasons, "|") != strings.Join(want, "|") {
		t.Fatalf("reasons %v", reasons)
	}
	rc := kept[0]
	if rc.Integration != "github" || rc.IntegrationName != "GitHub" || rc.CadenceLabel != "Every weekday at 9:00, while this Mac is awake" || len(rc.Evidence) != 2 || rc.ID != "idea:"+rc.Fingerprint {
		t.Fatalf("release checker: %+v", rc)
	}
	// The same idea worded again is the same idea.
	again, _ := vetNotchIdea(notchIdeaDraft{Name: "Release Checker", Integration: "GitHub", Promise: "before #4097 goes to production, I will read every change waiting on the deploy and call go or no go.", Evidence: []string{"github-1"}}, chk)
	if again.Fingerprint != rc.Fingerprint {
		t.Fatalf("fingerprint moved: %s vs %s", again.Fingerprint, rc.Fingerprint)
	}
	if parseNotchIdeaDrafts("no json here") != nil {
		t.Fatal("nonsense parsed")
	}
}

func withIdeasFakes(t *testing.T, judge string) {
	t.Helper()
	prevCollect, prevJudge := notchIdeaCollectFn, notchIdeaJudgeFn
	notchIdeaCollectFn = func(context.Context, *Broker) (map[string]curatedComposioToolkit, []notchIdeaEvidence) {
		return ideasTestConnected(), ideasTestEvidence()
	}
	notchIdeaJudgeFn = func(context.Context, string, string, string) (string, error) { return judge, nil }
	t.Cleanup(func() { notchIdeaCollectFn, notchIdeaJudgeFn = prevCollect, prevJudge })
}

func ideasOnState(t *testing.T, b *Broker, token string) *notchIdeas {
	t.Helper()
	s := notchStateAs(t, b, token, "")
	return s.Ideas
}

func TestNotchIdeasScanFillsTheNotchAndRemembersWhatYouSaid(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("WUPHF_RUNTIME_HOME", tmp)
	withIdeasFakes(t, ideasJudgeReply)
	b := newTestBroker(t)
	b.token = "owner-token"
	if ideas := ideasOnState(t, b, ""); ideas != nil {
		t.Fatal("a joined human was shown ideas")
	}
	if ideas := ideasOnState(t, b, "owner-token"); ideas == nil || !ideas.Enabled || len(ideas.Items) != 0 || ideas.NextAt == "" {
		t.Fatalf("before any scan: %+v", ideas)
	}
	added, _ := b.runNotchIdeasScan(context.Background(), false)
	if added != 2 {
		t.Fatalf("added %d", added)
	}
	ideas := ideasOnState(t, b, "owner-token")
	if len(ideas.Items) != 2 || ideas.CheckedAt == "" {
		t.Fatalf("after scan: %+v", ideas)
	}
	id := ideas.Items[0].ID
	post := func(path, token, body string, h func(http.ResponseWriter, *http.Request)) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}
	if code := post("/notch/ideas/seen", "", `{"id":"`+id+`"}`, b.handleNotchIdeaSeen); code != http.StatusForbidden {
		t.Fatalf("joined human marked seen: %d", code)
	}
	if code := post("/notch/ideas/seen", "owner-token", `{"id":"`+id+`"}`, b.handleNotchIdeaSeen); code != http.StatusOK {
		t.Fatalf("seen: %d", code)
	}
	if code := post("/notch/ideas/dismiss", "owner-token", `{"id":"`+id+`"}`, b.handleNotchIdeaDismiss); code != http.StatusOK {
		t.Fatalf("dismiss: %d", code)
	}
	if ideas := ideasOnState(t, b, "owner-token"); len(ideas.Items) != 1 || ideas.Items[0].ID == id {
		t.Fatalf("after one No: %+v", ideas.Items)
	}
	// A second scan does not bring a resting idea back; the same scan twice adds nothing.
	if added, _ := b.runNotchIdeasScan(context.Background(), false); added != 0 {
		t.Fatalf("second scan added %d", added)
	}
	if ideas := ideasOnState(t, b, "owner-token"); len(ideas.Items) != 1 {
		t.Fatalf("resting idea came back: %+v", ideas.Items)
	}
	// Restart: still remembered.
	again := NewBrokerAt(b.statePath)
	again.token = "owner-token"
	if ideas := ideasOnState(t, again, "owner-token"); len(ideas.Items) != 1 || ideas.Items[0].SeenCount != 0 {
		t.Fatalf("after restart: %+v", ideas.Items)
	}
}

func TestNotchIdeaAcceptMakesTheBotAndItsRoutine(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("WUPHF_RUNTIME_HOME", tmp)
	withIdeasFakes(t, ideasJudgeReply)
	b := newTestBroker(t)
	b.token = "owner-token"
	b.runNotchIdeasScan(context.Background(), false)
	ideas := ideasOnState(t, b, "owner-token")
	var rc notchIdea
	for _, it := range ideas.Items {
		if it.Name == "Release Checker" {
			rc = it
		}
	}
	if rc.ID == "" {
		t.Fatal("no release checker idea")
	}
	accept := func(token, id string) (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/notch/ideas/accept", strings.NewReader(`{"id":"`+id+`"}`))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		b.handleNotchIdeaAccept(rec, req)
		return rec.Code, rec.Body.String()
	}
	if code, _ := accept("", rc.ID); code != http.StatusForbidden {
		t.Fatalf("joined human made a bot: %d", code)
	}
	code, body := accept("owner-token", rc.ID)
	if code != http.StatusOK {
		t.Fatalf("accept: %d %s", code, body)
	}
	var out struct {
		Slug string `json:"slug"`
	}
	_ = json.Unmarshal([]byte(body), &out)
	if out.Slug != "release-checker" {
		t.Fatalf("slug %q", out.Slug)
	}
	b.mu.Lock()
	member := b.findMemberLocked("release-checker")
	var routine *schedulerJob
	for i := range b.scheduler {
		if b.scheduler[i].Kind == "agent_routine" && b.scheduler[i].TargetID == "release-checker" {
			routine = &b.scheduler[i]
		}
	}
	dm := channel.DirectSlug("human", "release-checker")
	var first *channelMessage
	for i := range b.messages {
		if b.messages[i].Channel == dm && b.messages[i].From == "routine" {
			first = &b.messages[i]
		}
	}
	b.mu.Unlock()
	if member == nil || member.Name != "Release Checker" {
		t.Fatalf("member: %+v", member)
	}
	if member.Avatar == nil || member.Avatar.Shape != rc.Avatar.Shape || member.Avatar.Look == nil || member.Avatar.Look.Hair == "" {
		t.Fatalf("the bot did not keep the card's face: %+v vs %+v", member.Avatar, rc.Avatar)
	}
	if routine == nil || routine.ScheduleExpr != "0 9 * * 1-5" || !routine.Enabled {
		t.Fatalf("routine: %+v", routine)
	}
	if first == nil || !strings.Contains(first.Content, "#4097") {
		t.Fatalf("first task: %+v", first)
	}
	// Made once: the card is gone, and a second Yes is refused.
	if ideas := ideasOnState(t, b, "owner-token"); len(ideas.Items) != 1 {
		t.Fatalf("accepted idea still shown: %+v", ideas.Items)
	}
	if code, _ := accept("owner-token", rc.ID); code != http.StatusBadRequest {
		t.Fatalf("second accept: %d", code)
	}
}

func TestNotchIdeasRunOncePerLocalDayAtTheHour(t *testing.T) {
	loc := time.Local
	day := func(h int) time.Time { return time.Date(2026, 10, 15, h, 30, 0, 0, loc) }
	if notchIdeasScanDue(day(8), 9, "") {
		t.Fatal("ran before the hour")
	}
	if !notchIdeasScanDue(day(9), 9, "") {
		t.Fatal("did not run at the hour")
	}
	if !notchIdeasScanDue(day(14), 9, "2026-10-14") {
		t.Fatal("did not catch up after the hour")
	}
	if notchIdeasScanDue(day(14), 9, "2026-10-15") {
		t.Fatal("ran twice in a day")
	}
	next := notchIdeasNextAt(day(8), 9, "")
	if next.Hour() != 9 || next.Day() != 15 {
		t.Fatalf("next before the hour: %v", next)
	}
	next = notchIdeasNextAt(day(10), 9, "2026-10-15")
	if next.Day() != 16 {
		t.Fatalf("next after today's run: %v", next)
	}
}

func TestNotchHeadlineOffersIdeasWhenQuiet(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("WUPHF_RUNTIME_HOME", tmp)
	withIdeasFakes(t, ideasJudgeReply)
	// The sessions on the machine running the test would make it busy.
	stubLocalSessions(t, nil)
	b := newTestBroker(t)
	b.token = "owner-token"
	if s := notchStateAs(t, b, "owner-token", ""); s.Mood != MoodIdle || strings.Contains(s.Headline, "idea") {
		t.Fatalf("before the look: %s %q", s.Mood, s.Headline)
	}
	b.runNotchIdeasScan(context.Background(), false)
	s := notchStateAs(t, b, "owner-token", "")
	if s.Mood != MoodIdle || s.Headline != "2 ideas for new bots, when you're ready" {
		t.Fatalf("after the look: %s %q", s.Mood, s.Headline)
	}
	if joined := notchStateAs(t, b, "", ""); strings.Contains(joined.Headline, "idea") {
		t.Fatal("a joined human was offered the owner's ideas")
	}
}
