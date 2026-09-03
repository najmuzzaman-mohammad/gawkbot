package team

// broker_utterance_routing_test.go — unit coverage for the v3 fix family #2
// mechanisms ("every human utterance reaches a bot; blocking asks are
// loud"). The utterance-routing office_eval job exercises the same paths at
// the HTTP layer with the exact FE payloads; these tests pin the broker
// helpers in isolation:
//
//  1. The FE's override_reason payload lands request-changes text in the
//     ChangesRequested stamp (MutateTask fallback shim).
//  2. A human message in a waiting (decision/review/changes-requested/done)
//     task channel stamps the note AND appends the task_followup wake;
//     drafting and archived tasks stay out; #general carve-out holds.
//  3. Creating a human-decision request posts the loud chat announcement
//     and anchors the thread; a human thread reply on that anchor ANSWERS
//     the interview instead of canceling it.
//  4. The blocking-request chat gate is channel-scoped, and the interview
//     suppression is scoped to the asking bot.

import (
	"encoding/json"
	"strings"
	"testing"
)

func newUtteranceTestBroker(t *testing.T) *Broker {
	t.Helper()
	b := newTestBroker(t)
	b.members = []officeMember{
		{Slug: "ceo", Name: "CEO", BuiltIn: true},
		{Slug: "eng", Name: "Engineer"},
	}
	b.channels = []teamChannel{
		{Slug: "team", Name: "team", Members: []string{"human", "ceo", "eng"}},
		{Slug: "task-acme", Name: "Acme renewal", Members: []string{"human", "ceo", "eng"}},
	}
	return b
}

func TestMutateTaskRequestChangesFallsBackToOverrideReason(t *testing.T) {
	t.Parallel()
	b := newUtteranceTestBroker(t)
	b.tasks = []teamTask{{
		ID: "task-rc-1", Channel: "task-acme", Title: "Draft renewal emails",
		Owner: "eng", status: "review", reviewState: "ready_for_review",
		LifecycleState: LifecycleStateReview,
	}}

	const text = "Use Dana Whitfield as the Acme contact; show full email bodies."
	// Exact FE field placement (web/src/api/tasks.ts): the typed reason
	// rides override_reason, details is empty.
	if _, err := b.MutateTask(TaskPostRequest{
		Action: "request_changes", ID: "task-rc-1", Channel: "team",
		CreatedBy: "human", OverrideReason: text,
		MemoryWorkflowOverrideReason: text,
	}); err != nil {
		t.Fatalf("request_changes: %v", err)
	}
	task := b.TaskByID("task-rc-1")
	if task.ChangesRequested == nil || !strings.Contains(task.ChangesRequested.Body, "Dana Whitfield") {
		t.Fatalf("ChangesRequested = %+v, want body carrying the override_reason text", task.ChangesRequested)
	}
	if task.HumanObjection == nil {
		t.Fatalf("HumanObjection not armed for a human request_changes")
	}

	// Explicit details still win over override_reason.
	b.tasks = append(b.tasks, teamTask{
		ID: "task-rc-2", Channel: "task-acme", Title: "Second draft",
		Owner: "eng", status: "review", reviewState: "ready_for_review",
		LifecycleState: LifecycleStateReview,
	})
	if _, err := b.MutateTask(TaskPostRequest{
		Action: "request_changes", ID: "task-rc-2", Channel: "team",
		CreatedBy: "human", Details: "details text wins", OverrideReason: "ignored",
	}); err != nil {
		t.Fatalf("request_changes with details: %v", err)
	}
	if got := b.TaskByID("task-rc-2").ChangesRequested.Body; got != "details text wins" {
		t.Fatalf("ChangesRequested.Body = %q, want details to win over override_reason", got)
	}
}

func TestHumanNoteWakesOwnerOnWaitingTaskStates(t *testing.T) {
	t.Parallel()
	b := newUtteranceTestBroker(t)
	mk := func(id string, state LifecycleState, channel string) teamTask {
		task := teamTask{ID: id, Channel: channel, Title: "Waiting work " + id, Owner: "eng"}
		row, ok := derivedFieldsFor(state)
		if !ok {
			t.Fatalf("no forward-map row for %s", state)
		}
		task.LifecycleState = state
		task.status = row.Status
		task.reviewState = row.ReviewState
		task.blocked = row.Blocked
		return task
	}
	b.tasks = []teamTask{
		mk("task-w-decision", LifecycleStateDecision, "task-acme"),
		mk("task-w-review", LifecycleStateReview, "task-acme"),
		mk("task-w-changes", LifecycleStateChangesRequested, "task-acme"),
		mk("task-w-done", LifecycleStateApproved, "task-acme"),
		mk("task-w-drafting", LifecycleStateDrafting, "task-acme"),
		mk("task-w-archived", LifecycleStateArchived, "task-acme"),
		mk("task-w-general", LifecycleStateDecision, "team"),
	}

	if _, err := b.PostMessage("you", "task-acme", "Redlines: Corti date July 15, sender Maya.", nil, ""); err != nil {
		t.Fatalf("human post: %v", err)
	}

	followUps := map[string]bool{}
	for _, action := range b.Actions() {
		if action.Kind == taskFollowUpActionKind {
			followUps[action.RelatedID] = true
		}
	}
	for _, id := range []string{"task-w-decision", "task-w-review", "task-w-changes", "task-w-done"} {
		task := b.TaskByID(id)
		if task.HumanNotePending == nil {
			t.Errorf("%s: note not stamped", id)
		}
		if !followUps[id] {
			t.Errorf("%s: task_followup wake action missing", id)
		}
	}
	for _, id := range []string{"task-w-drafting", "task-w-archived"} {
		if followUps[id] {
			t.Errorf("%s: must NOT get the follow-up wake", id)
		}
	}
	if b.TaskByID("task-w-archived").HumanNotePending != nil {
		t.Errorf("archived task must not be stamped")
	}

	// #general carve-out: a decision task parked in the lobby is neither
	// stamped nor woken by lobby chatter.
	if _, err := b.PostMessage("you", "team", "Lobby chatter about something else.", nil, ""); err != nil {
		t.Fatalf("lobby post: %v", err)
	}
	if followUps["task-w-general"] {
		t.Errorf("general-channel decision task must not get the follow-up wake")
	}
}

// The announcement must carry a structured card payload, so the web client
// can render the ask as an interactive card in the thread instead of a
// sentence. Observed live 2026-09-03: a blocking "Add Prospector to the team?"
// rendered as prose from a phantom "Office" speaker, pointing the human at an
// Inbox the nav no longer has.
func TestInterviewAnnouncementCarriesCardPayload(t *testing.T) {
	t.Parallel()
	b := newUtteranceTestBroker(t)
	if _, err := b.CreateRequest(humanInterview{
		Kind: "approval", From: "ceo", Channel: "team", Blocking: true, Required: true,
		Title: "Add Prospector?", Question: "Add Prospector to the team?",
	}); err != nil {
		t.Fatalf("create request: %v", err)
	}

	var announcement *channelMessage
	for _, msg := range b.ChannelMessages("team") {
		if msg.Kind == "human_request_raised" {
			m := msg
			announcement = &m
		}
	}
	if announcement == nil {
		t.Fatalf("no announcement posted")
	}

	// The dead pointer must be gone: the standalone Inbox was consolidated
	// into Tasks, so "Answer it in the Inbox" named a destination that no
	// longer exists.
	if strings.Contains(announcement.Content, "in the Inbox") {
		t.Errorf("announcement still points at the removed Inbox: %q", announcement.Content)
	}

	if len(announcement.Payload) == 0 {
		t.Fatalf("announcement carries no card payload — the client can only render prose")
	}
	var got humanRequestRaisedPayload
	if err := json.Unmarshal(announcement.Payload, &got); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if got.RequestID == "" {
		t.Errorf("payload has no request_id — the card cannot join the live request")
	}
	// The card is attributed to the bot that asked, even though the message
	// itself is sent by "system" so it cannot wake other bots.
	if got.From != "ceo" {
		t.Errorf("payload from = %q, want ceo (the asker, not the wire sender)", got.From)
	}
	if got.Question != "Add Prospector to the team?" {
		t.Errorf("payload question = %q", got.Question)
	}
	if !got.Blocking {
		t.Errorf("payload blocking = false, want true")
	}
	if announcement.From != "system" {
		t.Errorf("announcement From = %q, want system (must never wake bots)", announcement.From)
	}
}

func TestInterviewAnnouncementAnchorsThreadAndReplyAnswers(t *testing.T) {
	t.Parallel()
	b := newUtteranceTestBroker(t)
	req, err := b.CreateRequest(humanInterview{
		Kind: "interview", From: "eng", Channel: "team",
		Title: "Human interview", Question: "What is your sender name?",
	})
	if err != nil {
		t.Fatalf("create interview: %v", err)
	}
	if strings.TrimSpace(req.ReplyTo) == "" {
		t.Fatalf("interview has no thread anchor — announcement message must anchor it")
	}
	var announcement *channelMessage
	for _, msg := range b.ChannelMessages("team") {
		if msg.Kind == "human_request_raised" {
			m := msg
			announcement = &m
		}
	}
	if announcement == nil {
		t.Fatalf("no loud chat announcement posted for the interview")
	}
	if announcement.From != "system" {
		t.Fatalf("announcement From = %q, want system (must never wake bots)", announcement.From)
	}
	if !strings.Contains(announcement.Content, "sender name") {
		t.Fatalf("announcement does not carry the question: %q", announcement.Content)
	}
	if req.ReplyTo != announcement.ID {
		t.Fatalf("anchor = %q, want the announcement id %q", req.ReplyTo, announcement.ID)
	}

	// A human thread reply on the anchor IS the answer — not a cancel.
	const reply = "Sender name: Maya Reyes."
	if _, err := b.PostMessage("you", "team", reply, nil, req.ReplyTo); err != nil {
		t.Fatalf("thread reply: %v", err)
	}
	b.mu.Lock()
	var answered *humanInterview
	for i := range b.requests {
		if b.requests[i].ID == req.ID {
			r := b.requests[i]
			answered = &r
		}
	}
	b.mu.Unlock()
	if answered == nil || answered.Status != "answered" || answered.Answered == nil {
		t.Fatalf("interview not answered by the thread reply: %+v", answered)
	}
	if answered.Answered.CustomText != reply {
		t.Fatalf("answer text = %q, want the human's reply verbatim", answered.Answered.CustomText)
	}
}

func TestBlockingRequestGateIsChannelScoped(t *testing.T) {
	t.Parallel()
	b := newUtteranceTestBroker(t)
	if _, err := b.CreateRequest(humanInterview{
		Kind: "approval", From: "eng", Channel: "task-acme",
		Title: "Approve the send", Question: "Send the renewal emails now?",
		Blocking: true, Required: true,
	}); err != nil {
		t.Fatalf("create blocking approval: %v", err)
	}
	if _, err := b.PostMessage("you", "task-acme", "Trying to chat past the gate.", nil, ""); err == nil {
		t.Fatalf("chat in the blocking request's channel must 409")
	}
	if _, err := b.PostMessage("you", "team", "The rest of the team keeps talking.", nil, ""); err != nil {
		t.Fatalf("chat in another channel must flow: %v", err)
	}
}

func TestBotAwaitingInterviewAnswerScopesToAsker(t *testing.T) {
	t.Parallel()
	b := newUtteranceTestBroker(t)
	req, err := b.CreateRequest(humanInterview{
		Kind: "interview", From: "eng", Channel: "team",
		Title: "Human interview", Question: "Which export format?",
	})
	if err != nil {
		t.Fatalf("create interview: %v", err)
	}
	if !b.BotAwaitingInterviewAnswer("eng") {
		t.Fatalf("asking bot must be parked while its interview is pending")
	}
	if b.BotAwaitingInterviewAnswer("ceo") {
		t.Fatalf("other bots must NOT be parked — the v3 office-wide wedge")
	}
	b.mu.Lock()
	for i := range b.requests {
		if b.requests[i].ID == req.ID {
			b.cancelRequestLocked(&b.requests[i], "you", "test cleanup")
		}
	}
	b.mu.Unlock()
	if b.BotAwaitingInterviewAnswer("eng") {
		t.Fatalf("asker must resume once the interview resolves")
	}
}
