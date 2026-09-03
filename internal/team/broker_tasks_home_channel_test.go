package team

import (
	"path/filepath"
	"strings"
	"testing"
)

// These tests pin the routing rule that replaced #general for task mutations:
// a task with no explicit channel belongs in its OWNER's DM, and a mutation on
// an existing task does not need a channel at all.
//
// Both were live bugs. With the shared room retired, MutateTask resolved a
// missing channel from CreatedBy only — which is "human" for everything the web
// sends, and "human" is not a roster member — so it refused the mutation
// outright. The web worked around it by naming the literal "general", which no
// longer exists, so that failed too with "channel not found". Every task-create
// path from the UI was broken in both directions at once.

// brokerWithBots is NewBrokerAt plus a roster these routing rules can
// actually resolve against.
//
// The owners below — app-builder, planner, librarian — used to arrive free as
// seeded defaults. They are retired as DEFAULTS, not as bots: a user still
// creates them, and the routing rule is the same either way. Without hiring
// them the creates fail with "channel is required" before the rule under test
// ever runs, so these would have become tests of an error message.
func brokerWithBots(t *testing.T, slugs ...string) *Broker {
	t.Helper()
	b := NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))
	hireSpecialists(t, b, slugs...)
	return b
}

func TestTaskCreateWithoutChannelLandsInOwnerDM(t *testing.T) {
	b := brokerWithBots(t, appBuilderSlug)

	resp, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Title:     "Improve app: Pipeline",
		Owner:     appBuilderSlug,
		CreatedBy: "human",
		TaskType:  "issue",
	})
	if err != nil {
		t.Fatalf("create with no channel: %v", err)
	}
	want := DMSlugFor(appBuilderSlug)
	if resp.Task.Channel != want {
		t.Errorf("task channel = %q, want the owner's DM %q", resp.Task.Channel, want)
	}
	if strings.Contains(resp.Task.Channel, GeneralChannelSlug) {
		t.Errorf("task leaked into the retired shared room: %q", resp.Task.Channel)
	}
}

// The owner is preferred over the creator when the creator may post there.
// The human is a party to every human__<bot> DM, so a human-created task
// lands on its owner.
func TestTaskCreateChannelPrefersOwnerOverCreator(t *testing.T) {
	b := brokerWithBots(t, "planner")

	resp, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Title:     "Draft the launch plan",
		Owner:     "planner",
		CreatedBy: "human",
		TaskType:  "issue",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got, want := resp.Task.Channel, DMSlugFor("planner"); got != want {
		t.Errorf("task channel = %q, want the owner's DM %q", got, want)
	}
}

// But a DM has exactly two participants, so a bot opening a task for a
// DIFFERENT bot must not be routed into a private conversation it cannot
// post in. It falls back to its own DM rather than failing the create.
func TestTaskCreateByBotForAnotherBotUsesTheCreatorsOwnDM(t *testing.T) {
	// planner is hired, so the fallback below is genuinely "the creator cannot
	// post in the owner's DM" and not "the owner does not exist".
	b := brokerWithBots(t, "planner")

	resp, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Title:     "Draft the launch plan",
		Owner:     "planner",
		CreatedBy: "ceo",
		TaskType:  "issue",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got, want := resp.Task.Channel, DMSlugFor("ceo"); got != want {
		t.Errorf("task channel = %q, want the creator's own DM %q", got, want)
	}
}

// A create that names nobody resolvable must fail LOUDLY naming the field,
// not silently land in a room nobody reads.
func TestTaskCreateWithNoResolvableActorFailsLoudly(t *testing.T) {
	b := NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))

	_, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Title:     "orphan",
		Owner:     "nobody-on-the-roster",
		CreatedBy: "human",
		TaskType:  "issue",
	})
	if err == nil {
		t.Fatal("expected a refusal when no actor resolves to a home channel")
	}
	if !strings.Contains(err.Error(), "channel is required") {
		t.Errorf("error should name the missing field, got: %v", err)
	}
}

// A mutation on an EXISTING task carries no channel and must not need one:
// the task already knows where it lives.
func TestTaskMutationWithoutChannelUsesTheTasksOwnChannel(t *testing.T) {
	b := brokerWithBots(t, "planner")

	created, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Title:     "Ship the thing",
		Owner:     "planner",
		CreatedBy: "human",
		TaskType:  "issue",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// No Channel field at all — exactly what web/src/api/tasks.ts sends once it
	// stops laundering an empty channel into "general".
	if _, err := b.MutateTask(TaskPostRequest{
		Action:    "comment",
		ID:        created.Task.ID,
		Details:   "a note from the human",
		CreatedBy: "human",
	}); err != nil {
		t.Fatalf("comment on an existing task with no channel: %v", err)
	}
}

// The literal the web used to send. Kept as a test so a re-introduction is
// caught here rather than in the browser.
func TestTaskCreateIntoRetiredGeneralIsRefused(t *testing.T) {
	// The owner is on the roster, so the refusal below can only come from
	// #general being unroutable — not from an unresolvable owner.
	b := brokerWithBots(t, appBuilderSlug)

	_, err := b.MutateTask(TaskPostRequest{
		Action:    "create",
		Channel:   GeneralChannelSlug,
		Title:     "Improve app: Pipeline",
		Owner:     appBuilderSlug,
		CreatedBy: "human",
		TaskType:  "issue",
	})
	if err == nil {
		t.Fatal("expected #general to be unroutable while the kill switch is off")
	}
}

func TestHomeChannelForWriterSkipsUnresolvableAndInaccessible(t *testing.T) {
	b := brokerWithBots(t, LibrarianSlug)

	// "" is skipped as empty, "human" as a non-member; the librarian resolves.
	got, err := b.homeChannelForWriter("human", "", "human", "librarian")
	if err != nil {
		t.Fatalf("expected the librarian to resolve: %v", err)
	}
	if want := DMSlugFor("librarian"); got != want {
		t.Errorf("got %q, want %q", got, want)
	}

	// The librarian's DM resolves but the CEO may not post there, so it is
	// skipped in favour of the CEO's own.
	got, err = b.homeChannelForWriter("ceo", "librarian", "ceo")
	if err != nil {
		t.Fatalf("expected the ceo to fall back to its own DM: %v", err)
	}
	if want := DMSlugFor("ceo"); got != want {
		t.Errorf("got %q, want %q", got, want)
	}

	if _, err := b.homeChannelForWriter("human", "", "human"); err == nil {
		t.Error("expected an error when nothing resolves")
	}
}
