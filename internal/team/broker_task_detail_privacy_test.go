package team

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestTaskDetailNeverLeaksTheHumanNote closes a hole straight through the DM
// privacy boundary.
//
// HumanNotePending.Body is the VERBATIM text of a human's message, copied onto
// every task in the channel it was posted to so the owner's next turn can carry
// it. teamTask is both the persisted struct and the wire struct, so that text
// shipped to anyone who could call GET /tasks/{id} — and taskAccessAllowed
// returns true unconditionally for any broker-token holder, which is every
// bot. The endpoint carries no bot identity, so it cannot tell one from
// another.
//
// The result: a bot barred from reading a conversation could read that
// conversation's messages back, word for word, off any task in it. The
// Librarian's wiki-link tool calls this exact endpoint. Closing the channel
// bypasses without closing this would have moved the leak, not fixed it.
func TestTaskDetailNeverLeaksTheHumanNote(t *testing.T) {
	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()

	const secret = "the acquisition price is 4.2 million, do not repeat this"

	created, err := b.MutateTask(TaskPostRequest{
		Action: "create", Channel: "team", Title: "Draft the memo",
		CreatedBy: "human", Owner: "ceo",
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	// A human says something sensitive in the channel, naming the task so it
	// is addressed and the note actually lands. The task must be RUNNING for a
	// note to stamp — a freshly created task sits in planning, which is neither
	// running nor awaiting follow-up.
	b.mu.Lock()
	for i := range b.tasks {
		if b.tasks[i].ID == created.Task.ID {
			b.tasks[i].LifecycleState = LifecycleStateRunning
			b.tasks[i].status = "in_progress"
		}
	}
	b.mu.Unlock()

	b.mu.Lock()
	b.markHumanNoteOnChannelTasksLocked(channelMessage{
		From: "you", Channel: "team",
		Content: created.Task.ID + " " + secret,
	})
	stamped := false
	for i := range b.tasks {
		if b.tasks[i].ID == created.Task.ID && b.tasks[i].HumanNotePending != nil {
			stamped = true
		}
	}
	b.mu.Unlock()
	if !stamped {
		t.Fatal("precondition failed: the note was never stamped, so this test proves nothing")
	}

	req, _ := http.NewRequest(http.MethodGet, "http://"+b.Addr()+"/tasks/"+created.Task.ID, nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /tasks/{id}: %v", err)
	}
	defer resp.Body.Close()

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	raw, _ := json.Marshal(body)

	if strings.Contains(string(raw), secret) {
		t.Error("GET /tasks/{id} leaked the verbatim text of a human message")
	}
	if strings.Contains(string(raw), "human_note_pending") {
		t.Error("the pending human note must not be serialised on this endpoint at all")
	}
	// The endpoint must still be useful.
	taskField, ok := body["task"].(map[string]any)
	if !ok {
		t.Fatal("the task snapshot disappeared entirely; redaction went too far")
	}
	if title, _ := taskField["title"].(string); title != "Draft the memo" {
		t.Errorf("task title = %q, want the real title — only the note should be stripped", title)
	}
}

// The note must survive IN PROCESS, because the owner's packet is what carries
// it. Redacting at the wire boundary rather than dropping the JSON tag is what
// keeps both true at once — the tag is also the persisted shape.
func TestHumanNoteSurvivesInProcessAfterWireRedaction(t *testing.T) {
	b := newTestBroker(t)
	created, err := b.MutateTask(TaskPostRequest{
		Action: "create", Channel: "team", Title: "Still needs the note",
		CreatedBy: "human", Owner: "ceo",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	b.mu.Lock()
	for i := range b.tasks {
		if b.tasks[i].ID == created.Task.ID {
			b.tasks[i].LifecycleState = LifecycleStateRunning
			b.tasks[i].status = "in_progress"
		}
	}
	b.markHumanNoteOnChannelTasksLocked(channelMessage{
		From: "you", Channel: "team", Content: created.Task.ID + " please use the shorter framing",
	})
	var note *TaskHumanNote
	for i := range b.tasks {
		if b.tasks[i].ID == created.Task.ID {
			note = b.tasks[i].HumanNotePending
		}
	}
	b.mu.Unlock()

	if note == nil || !strings.Contains(note.Body, "shorter framing") {
		t.Fatalf("the owner's note must still be readable in process, got %+v", note)
	}
}
