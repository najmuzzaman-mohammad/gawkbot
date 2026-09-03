package team

import (
	"testing"
)

// TestLibrarianIsNotSeededIntoTheDefaultRoster is the INVERSION of the test
// that used to live here ("the Librarian is a built-in member of the default
// roster"). The founder retired the Librarian as a default bot: wiki
// contribution is a system skill every bot carries, so a preinstalled
// specialist who owns the wiki is a bot the product no longer defines.
//
// Inverted rather than deleted, because the failure mode is a REGRESSION, not
// an absence: the first removal attempt edited the seed list and looked done
// while ensureLibrarianMember quietly re-appended her on the next load. If any
// seed path grows a librarian back, this fails.
func TestLibrarianIsNotSeededIntoTheDefaultRoster(t *testing.T) {
	members := defaultOfficeMembers()
	for i := range members {
		if isLibrarianSlug(members[i].Slug) {
			t.Fatalf("librarian is back in defaultOfficeMembers: %+v", members)
		}
	}
	// And the roster it is absent from is a real one, so the assertion above
	// cannot pass by the seed returning nothing at all.
	if len(members) == 0 {
		t.Fatal("defaultOfficeMembers seeded nobody; the assertion above proves nothing")
	}
}

// TestLibrarianIsInTheRoomTheTaskLandsIn: the Librarian and the task owner are
// both members of whatever channel a task lands in, so the Librarian sees the
// work as it happens (D5: owner + CEO + Librarian).
//
// This test used to spell that contract as "every task mints its own channel,
// and createPerTaskChannelLocked seeds the Librarian into it". Per-task channels
// are gone — they split the roster across rooms, so an @mention reached someone
// who was not in the room. A task now stays in the office channel it was created
// from, and the Librarian's presence is a property of that channel rather than
// of a minting step. The contract the test guards is unchanged: nobody has to be
// invited for the Librarian to be watching.
//
// The office channel is a variable rather than a literal because #general is
// scheduled for removal; what this pins is "the room the task lands in".
func TestLibrarianIsInTheRoomTheTaskLandsIn(t *testing.T) {
	b := newTestBroker(t)
	createdFrom := "team"
	ensureTestMemberAccess(b, createdFrom, LibrarianSlug, librarianName)
	ensureTestMemberAccess(b, createdFrom, "eng", "Engineer")

	task, _, err := b.EnsurePlannedTask(plannedTaskInput{
		Channel:       createdFrom,
		Title:         "Build the thing",
		Owner:         "eng",
		CreatedBy:     "ceo",
		TaskType:      "feature",
		ExecutionMode: "office",
	})
	if err != nil {
		t.Fatalf("ensure task: %v", err)
	}
	if task.Channel != createdFrom {
		t.Fatalf("expected the task to stay in %q, got %q", createdFrom, task.Channel)
	}

	b.mu.Lock()
	hasLibrarian := b.channelHasMemberLocked(task.Channel, LibrarianSlug)
	hasOwner := b.channelHasMemberLocked(task.Channel, "eng")
	b.mu.Unlock()
	if !hasLibrarian {
		t.Errorf("expected librarian in the task's channel %q", task.Channel)
	}
	if !hasOwner {
		t.Errorf("expected owner in the task's channel %q", task.Channel)
	}
}

// TestLibrarianTaskChannelSeedNoopsWithoutMember: in a workspace that has no
// Librarian member yet (e.g. a legacy workspace before the Phase 6 migration),
// creating a task must NOT add a phantom "librarian" member to its channel.
// (Pre-one-room this guarded createPerTaskChannelLocked's Librarian seeding;
// with no minting it guards the same invariant one layer up — nothing in the
// create path may invent a member the roster does not have.)
func TestLibrarianTaskChannelSeedNoopsWithoutMember(t *testing.T) {
	b := newTestBroker(t)
	// Simulate a legacy workspace: a roster with one member and NO librarian
	// (as a pre-Phase-4 broker-state.json would load). Overwrite the
	// auto-seeded default roster so findMemberLocked("librarian") is nil.
	b.mu.Lock()
	b.members = []officeMember{{Slug: "eng", Name: "Engineer", Role: "Engineer"}}
	b.memberIndex = nil
	// "ceo" is the CreatedBy below and is a member of #general in every real
	// workspace; membership is authoritative for bots now, so the fixture
	// has to say so. The librarian is still deliberately absent — that
	// absence is what this test is about.
	b.channels = []teamChannel{{Slug: "team", Name: "team", Members: []string{"eng", "ceo"}}}
	b.mu.Unlock()

	task, _, err := b.EnsurePlannedTask(plannedTaskInput{
		Channel:       "team",
		Title:         "Legacy task",
		Owner:         "eng",
		CreatedBy:     "ceo",
		TaskType:      "feature",
		ExecutionMode: "office",
	})
	if err != nil {
		t.Fatalf("ensure task: %v", err)
	}
	b.mu.Lock()
	hasLibrarian := b.channelHasMemberLocked(task.Channel, LibrarianSlug)
	b.mu.Unlock()
	if hasLibrarian {
		t.Errorf("did not expect a phantom librarian member when none is registered")
	}
}

// TestLibrarianHasNoCrossChannelAccess: the Librarian has NO org-wide read.
// This test previously asserted the opposite — Pam could reach any channel
// "for wiki curation context" — which also let her read every human-to-bot
// DM. Membership is now authoritative for every bot; she is added to the
// conversations she curates. Inverted rather than deleted so a reinstated
// bypass fails here. See broker_channel_access_dm_test.go for the DM case.
func TestLibrarianHasNoCrossChannelAccess(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.canAccessChannelLocked(LibrarianSlug, "some-channel-it-is-not-a-member-of") {
		t.Fatalf("librarian must not reach a channel she is not a member of")
	}
}
