package team

import (
	"path/filepath"
	"testing"
)

// The #general kill switch removed the shared room. These tests pin what
// replaces it, and the privacy property that made the replacement worth
// having.
//
// Written after flipping generalEnabled to false produced a workspace with SIX
// BOTS AND ZERO CHANNELS -- a full roster and nowhere to say anything. The
// switch had been threaded through seven gates and left off, and nobody had
// built the surface that takes over when it flips.

func newSeededBroker(t *testing.T) *Broker {
	t.Helper()
	return NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))
}

// hireSpecialists adds ordinary, user-created bots to the roster and runs the
// production DM seed over the result.
//
// It exists because the default roster is now the Chief of Staff alone. These
// tests used to lean on app-builder / planner / librarian being preinstalled,
// and with those bots retired as DEFAULTS the assertions below would have
// gone quiet: "no DM to check" reads exactly like "the DM is fine". The bots
// themselves are still perfectly legal — a user creates them — so the fixture
// creates them the way a user would, and every property here stays falsifiable.
func hireSpecialists(t *testing.T, b *Broker, slugs ...string) {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, slug := range slugs {
		if b.findMemberLocked(slug) != nil {
			continue
		}
		member := officeMember{Slug: slug}
		applyOfficeMemberDefaults(&member)
		b.members = append(b.members, member)
	}
	b.rebuildMemberIndexLocked()
	b.ensureBotDMsLocked()
}

// The office must be usable on first boot. A roster with no conversation is
// not a product, and this is the exact state the switch produced before the
// DM seed existed.
func TestFreshOfficeSeedsADMForEveryBot(t *testing.T) {
	b := newSeededBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.members) == 0 {
		t.Fatal("no members seeded; the rest of this test proves nothing")
	}
	for _, m := range b.members {
		if isHumanMessageSender(m.Slug) {
			continue
		}
		want := "human"
		dm := b.findChannelLocked(directSlugFor(want, m.Slug))
		if dm == nil {
			t.Errorf("bot %q has no DM: it is on the roster and unreachable", m.Slug)
			continue
		}
		if dm.Type != "dm" {
			t.Errorf("%s: type = %q, want \"dm\"", dm.Slug, dm.Type)
		}
	}
}

// A DM's member list IS its access control list: canAccessChannelLocked
// authorizes a bot by membership alone. So membership has to be exactly the
// two participants -- no more, and no fewer.
//
// "no fewer" is not padding. The human was being stripped from every DM
// because the roster filter only kept slugs that are bots, and the human is
// not a bot.
func TestDMHoldsExactlyItsTwoParticipants(t *testing.T) {
	b := newSeededBroker(t)
	hireSpecialists(t, b, "app-builder")
	b.mu.Lock()
	defer b.mu.Unlock()

	dm := b.findChannelLocked(directSlugFor("human", "app-builder"))
	if dm == nil {
		t.Fatal("no app-builder DM")
	}
	if len(dm.Members) != 2 {
		t.Fatalf("members = %v, want exactly [human app-builder]", dm.Members)
	}
	if !containsString(dm.Members, "human") {
		t.Errorf("members = %v: the human is missing from their own DM", dm.Members)
	}
	if !containsString(dm.Members, "app-builder") {
		t.Errorf("members = %v: the bot is missing from its own DM", dm.Members)
	}
}

// THE REGRESSION THIS FILE EXISTS FOR.
//
// broker_channel_access.go deliberately removed the blanket read that the CEO,
// the Librarian and the App Builder used to have over every channel, so that a
// DM is readable by exactly its two participants. That fix was correct and it
// worked. The SEED then handed the access straight back, by prepending "ceo"
// to every channel's member list -- DMs included.
//
// Measured before the fix:
//
//	app-builder__human members = [ceo app-builder]
//	canAccess(ceo, app-builder__human) = true
//
// The access check was never wrong. Its input was. A test on the check alone
// would have stayed green through the whole bug, which is why this one asserts
// the OUTCOME on a seeded broker rather than the rule in isolation.
// The specialists are HIRED here rather than assumed. They used to be the
// default roster, and the loop below skipped any bot whose DM was missing --
// so once the defaults were retired this test would have iterated five absent
// channels, asserted nothing, and passed. A privacy guard that cannot fail is
// worse than no guard, because it reads as coverage.
func TestCEOCannotReadDMsItIsNotPartyTo(t *testing.T) {
	b := newSeededBroker(t)
	others := []string{"app-builder", "planner", "executor", "reviewer", "librarian"}
	hireSpecialists(t, b, others...)
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, bot := range others {
		dm := directSlugFor("human", bot)
		if b.findChannelLocked(dm) == nil {
			t.Errorf("%s has no DM: the fixture is broken, so the privacy check below is vacuous", bot)
			continue
		}
		if b.canAccessChannelLocked("ceo", dm) {
			t.Errorf("ceo can read %s: a DM is private to its two participants", dm)
		}
		if b.canAccessChannelLocked("librarian", dm) && bot != "librarian" {
			t.Errorf("librarian can read %s: no bot gets a blanket read over other bots' DMs", dm)
		}
	}

	// The other half: the bot and the human must still reach their own DM,
	// or "private" has been implemented as "broken".
	own := directSlugFor("human", "app-builder")
	if !b.canAccessChannelLocked("app-builder", own) {
		t.Error("app-builder cannot read its OWN DM")
	}
	if !b.canAccessChannelLocked("human", own) {
		t.Error("the human cannot read their own DM")
	}
	// And the CEO's own DM is still the CEO's.
	if !b.canAccessChannelLocked("ceo", directSlugFor("human", "ceo")) {
		t.Error("ceo cannot read its own DM")
	}
}

// Seeding runs on every Load. It must never disturb a conversation that
// already exists -- not its membership, and not its history.
func TestSeedingIsIdempotentAndLeavesExistingDMsAlone(t *testing.T) {
	b := newSeededBroker(t)
	hireSpecialists(t, b, "planner")

	b.mu.Lock()
	slug := directSlugFor("human", "planner")
	before := b.findChannelLocked(slug)
	if before == nil {
		t.Fatal("no planner DM")
	}
	created := before.CreatedAt
	count := len(b.channels)
	b.mu.Unlock()

	// Re-run the seed the way a second boot would.
	b.mu.Lock()
	b.ensureBotDMsLocked()
	after := b.findChannelLocked(slug)
	gotCount := len(b.channels)
	b.mu.Unlock()

	if gotCount != count {
		t.Errorf("channel count %d -> %d: seeding duplicated rooms", count, gotCount)
	}
	if after.CreatedAt != created {
		t.Errorf("CreatedAt rewritten (%q -> %q): an existing conversation was disturbed",
			created, after.CreatedAt)
	}
}

func directSlugFor(a, b string) string {
	if a > b {
		return b + "__" + a
	}
	return a + "__" + b
}
