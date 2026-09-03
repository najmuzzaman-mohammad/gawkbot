package team

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// Bot autonomy: a bot files and does the work the human asked IT for.
//
// The old rule routed every task create through the CEO. That bought dedup and
// prioritisation for free when everyone shared #general and the CEO could see
// all of it. Under DM-first the CEO is not in the conversation, so the same
// rule costs three async bot turns to get permission for something the human
// asked for directly — and every hop is a place a wake can fail.
//
// The split is on WHERE THE WORK CAME FROM, not on who may file it:
//   - the human asked this bot, in its DM  -> it creates and does the work
//   - the bot thought of it itself         -> it asks the HUMAN, who is right
//     there, rather than the CEO, who is three turns away
//
// What deliberately did NOT widen: reassign, approve, and reject. Those are
// decisions about somebody ELSE's work, and nothing in the founder's question
// asks for them.

func autonomyBroker(t *testing.T) *Broker {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	b := newBrokerWithTeamRoom(filepath.Join(t.TempDir(), "state.json"))
	b.mu.Lock()
	b.members = []officeMember{
		{Slug: "ceo", Name: "CEO", Role: "Chief Executive"},
		{Slug: "designer", Name: "Designer", Role: "Designer"},
		{Slug: "eng", Name: "Engineer", Role: "Engineer"},
	}
	b.memberIndex = nil
	b.channels = []teamChannel{
		// The designer's 1:1 with the human — where the human asks for work.
		{Slug: "designer__human", Name: "designer__human", Type: "dm",
			Members: []string{"human", "designer"}},
		{Slug: "delivery", Name: "delivery", Members: []string{"human", "ceo", "designer", "eng"}},
	}
	b.mu.Unlock()
	return b
}

func forbidden(t *testing.T, err error, what string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s must still be refused, got nil error", what)
	}
	var mutErr *TaskMutationError
	if !errors.As(err, &mutErr) || mutErr.Kind != TaskMutationForbidden {
		t.Fatalf("%s must be refused as forbidden, got %v", what, err)
	}
}

// THE CHANGE. The human asked the designer, in the designer's DM. The designer
// files it and owns it. No CEO in the loop.
func TestSpecialistCreatesItsOwnWork(t *testing.T) {
	b := autonomyBroker(t)
	res, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Channel:   "designer__human",
		Title:     "Redraw the onboarding illustrations",
		Details:   "The human asked for this directly in the DM.",
		Owner:     "designer",
		CreatedBy: "designer",
		TaskType:  "issue",
	})
	if err != nil {
		t.Fatalf("a specialist must be able to file the work the human asked it for: %v", err)
	}
	if got := strings.TrimSpace(res.Task.Owner); got != "designer" {
		t.Fatalf("expected the filer to own its own work, got owner=%q", got)
	}
}

// A bot files ITS OWN work — it does not hand work to someone else. That is
// reassignment wearing a different hat, and it stays a CEO/human decision.
func TestSpecialistCannotCreateWorkOwnedByAnotherBot(t *testing.T) {
	b := autonomyBroker(t)
	_, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Channel:   "delivery",
		Title:     "Rewrite the auth layer",
		Details:   "Designer trying to put work on the engineer.",
		Owner:     "eng",
		CreatedBy: "designer",
		TaskType:  "issue",
	})
	forbidden(t, err, "a specialist creating work owned by another bot")
}

// The three that did NOT widen. Each is a decision about someone else's work.
func TestSpecialistStillCannotReassignApproveOrReject(t *testing.T) {
	b := autonomyBroker(t)
	created, err := b.MutateTask(TaskPostRequest{
		Action: "create", Channel: "delivery", Title: "Ship the pricing page",
		Details: "CEO-scoped work.", Owner: "eng", CreatedBy: "ceo", TaskType: "issue",
	})
	if err != nil {
		t.Fatalf("ceo create: %v", err)
	}
	id := created.Task.ID

	for _, action := range []string{"reassign", "approve", "reject"} {
		_, err := b.MutateTask(TaskPostRequest{
			Action: action, ID: id, Channel: "delivery",
			CreatedBy: "designer", Owner: "designer", Details: "because I said so",
		})
		forbidden(t, err, "a specialist calling "+action)
	}
}

// The CEO keeps everything it had. This change adds a path; it removes none.
func TestCEORetainsFullIssueAuthority(t *testing.T) {
	b := autonomyBroker(t)
	created, err := b.MutateTask(TaskPostRequest{
		Action: "create", Channel: "delivery", Title: "Plan the launch",
		Details: "Lead-scoped.", Owner: "designer", CreatedBy: "ceo", TaskType: "issue",
	})
	if err != nil {
		t.Fatalf("ceo must still create: %v", err)
	}
	startPlanning(t, b, created.Task.ID)
	if _, err := b.MutateTask(TaskPostRequest{
		Action: "reassign", ID: created.Task.ID, Channel: "delivery",
		Owner: "eng", CreatedBy: "ceo",
	}); err != nil {
		t.Fatalf("ceo must still reassign: %v", err)
	}
}

// Dedup is a LOOKUP, not a person: findReusableTaskLocked collapses a repeat
// create onto the open task by title + owner, regardless of who is filing. It
// is what stands in for the CEO's global view now that creates do not route
// through it, so this pins that it applies to a specialist filing directly.
//
// Scope note, measured rather than assumed: the match is fuzzy but TIGHT —
// titleSimilarityThreshold is 0.85, and one extra word drops a pair to 0.750,
// i.e. below the bar. So this covers the same ask filed twice, NOT a genuine
// rephrasing. See the report for why that matters more now than it used to.
func TestSpecialistCreateStillDedupes(t *testing.T) {
	b := autonomyBroker(t)
	const title = "Redraw the onboarding illustrations"
	first, err := b.MutateTask(TaskPostRequest{
		Action: "create", Channel: "designer__human", Title: title,
		Details: "first ask", Owner: "designer", CreatedBy: "designer", TaskType: "issue",
	})
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	second, err := b.MutateTask(TaskPostRequest{
		Action: "create", Channel: "designer__human", Title: title,
		Details: "same ask again", Owner: "designer", CreatedBy: "designer", TaskType: "issue",
	})
	if err != nil {
		t.Fatalf("second create: %v", err)
	}
	if second.Task.ID != first.Task.ID {
		t.Fatalf("a repeat create must collapse onto the open task, got %q then %q",
			first.Task.ID, second.Task.ID)
	}
}

// Comment stays open to everyone — unchanged, asserted so a future tightening
// of the gate cannot silently take it away.
func TestCommentRemainsOpenToSpecialists(t *testing.T) {
	b := autonomyBroker(t)
	created, err := b.MutateTask(TaskPostRequest{
		Action: "create", Channel: "delivery", Title: "Ship the pricing page",
		Details: "x", Owner: "eng", CreatedBy: "ceo", TaskType: "issue",
	})
	if err != nil {
		t.Fatalf("ceo create: %v", err)
	}
	if _, err := b.MutateTask(TaskPostRequest{
		Action: "comment", ID: created.Task.ID, Channel: "delivery",
		Details: "a note from someone who does not own this", CreatedBy: "designer",
	}); err != nil {
		t.Fatalf("comment must stay open to every bot: %v", err)
	}
}
