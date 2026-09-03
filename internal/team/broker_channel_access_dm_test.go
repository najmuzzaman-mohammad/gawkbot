package team

import (
	"strings"
	"testing"
)

// The DM privacy invariant: a direct message is readable and postable by
// exactly its two participants. No bot — not the CEO, not Pam the
// librarian, not the App Builder — reads a conversation it is not a party
// to. Before this, all three bypassed membership entirely, which made the
// DM packet preamble ("This is a private 1:1 conversation with the human",
// notification_context.go) a promise the code did not keep.
//
// These tests pin the boundary from both sides: the privacy rule itself,
// and the directory visibility the founder explicitly kept ("every bot
// knows what each bot is good for"). Both halves matter — a fix that
// made bots private but also blind to who exists would break consulting.

// dmBrokerWithRoster returns a broker holding a human<->eng DM that neither
// the CEO, the Librarian, nor the App Builder is a member of.
func dmBrokerWithRoster(t *testing.T) (*Broker, string) {
	t.Helper()
	b := newTestBroker(t)
	const dmChannel = "eng__human"
	b.mu.Lock()
	// Inline roster: the ensure-style helpers that used to append the
	// Librarian and App Builder are deleted with those bots' retirement as
	// defaults. The privacy rules pinned here still matter for LEGACY
	// workspaces that hold both bots on disk, so the fixture keeps them.
	b.members = []officeMember{
		{Slug: "ceo", Name: "CEO", Role: "Chief Executive"},
		{Slug: "eng", Name: "Engineer", Role: "Engineer"},
		{Slug: LibrarianSlug, Name: librarianName, Role: librarianRole},
		{Slug: appBuilderSlug, Name: appBuilderRole, Role: appBuilderRole},
	}
	b.channels = []teamChannel{{
		Slug:    dmChannel,
		Name:    dmChannel,
		Type:    "dm",
		Members: []string{"human", "eng"},
	}}
	b.mu.Unlock()
	return b, dmChannel
}

// The headline case the founder called out by name.
func TestLibrarianCannotReadHumanBotDM(t *testing.T) {
	b, dmChannel := dmBrokerWithRoster(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.canAccessChannelLocked(LibrarianSlug, dmChannel) {
		t.Fatalf("Pam the librarian must NOT reach %q — she is not a participant", dmChannel)
	}
	// The two real participants still can, or the DM is useless.
	if !b.canAccessChannelLocked("human", dmChannel) {
		t.Fatalf("the human must reach their own DM %q", dmChannel)
	}
	if !b.canAccessChannelLocked("eng", dmChannel) {
		t.Fatalf("the DM's bot participant must reach %q", dmChannel)
	}
}

// The same rule for the other two former bypasses. The CEO routes work by
// DMing specialists, not by reading their DMs.
func TestNoBotBypassesDMMembership(t *testing.T) {
	b, dmChannel := dmBrokerWithRoster(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, slug := range []string{"ceo", LibrarianSlug, appBuilderSlug} {
		if b.canAccessChannelLocked(slug, dmChannel) {
			t.Errorf("%q must not bypass membership on %q", slug, dmChannel)
		}
	}
}

// Membership — not identity — is what grants access. Adding a bot to the
// conversation is the supported way in, and it must still work.
func TestMembershipGrantsChannelAccess(t *testing.T) {
	b, dmChannel := dmBrokerWithRoster(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.canAccessChannelLocked(LibrarianSlug, dmChannel) {
		t.Fatalf("precondition: librarian should start outside %q", dmChannel)
	}
	for i := range b.channels {
		if b.channels[i].Slug == dmChannel {
			b.channels[i].Members = append(b.channels[i].Members, LibrarianSlug)
		}
	}
	if !b.canAccessChannelLocked(LibrarianSlug, dmChannel) {
		t.Fatalf("librarian was added to %q and must now reach it", dmChannel)
	}
}

// An absent channel must add NOBODY to ANYTHING.
//
// The guard used to sit after `channel = normalizeChannelSlug(channel)`, and
// normalizeChannelSlug("") returns "team" — so the guard was unreachable
// and an empty channel silently made the task owner a member of the general
// room. Same trap on `owner`, which was additionally run through the CHANNEL
// normaliser despite being an actor slug. These cases pin the ordering: they
// fail if anyone moves the emptiness check back below the normalise.
func TestOwnerPromotionIgnoresAbsentChannelOrOwner(t *testing.T) {
	general := func() []teamChannel {
		return []teamChannel{{
			Slug:    "team",
			Name:    "team",
			Members: []string{"human"},
		}}
	}

	cases := []struct {
		name    string
		channel string
		owner   string
	}{
		{"empty channel", "", "eng"},
		{"blank channel", "   ", "eng"},
		{"empty owner", "team", ""},
		{"blank owner", "team", "  "},
		{"both empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := newTestBroker(t)
			b.mu.Lock()
			defer b.mu.Unlock()
			b.members = []officeMember{{Slug: "eng", Name: "Engineer", Role: "Engineer"}}
			b.memberIndex = nil
			b.channels = general()

			b.ensureTaskOwnerChannelMembershipLocked(tc.channel, tc.owner)

			got := b.channels[0].Members
			if len(got) != 1 || got[0] != "human" {
				t.Fatalf("absent channel/owner must not touch membership; #team members = %v", got)
			}
		})
	}
}

// A real channel + owner still promotes — the guard must not over-reject.
func TestOwnerPromotionStillAddsRealOwner(t *testing.T) {
	b := newTestBroker(t)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.members = []officeMember{{Slug: "eng", Name: "Engineer", Role: "Engineer"}}
	b.memberIndex = nil
	b.channels = []teamChannel{{Slug: "delivery", Name: "delivery", Members: []string{"human"}}}

	b.ensureTaskOwnerChannelMembershipLocked("delivery", "eng")

	if !b.canAccessChannelLocked("eng", "delivery") {
		t.Fatalf("owning work in #delivery must make eng a member; members = %v", b.channels[0].Members)
	}
}

// A task owner is auto-promoted onto the channel it owns work in, which is
// how the App Builder reaches a build thread now that it has no bypass.
// Without this the 2026-08-16 fresh-workspace failure returns: every build
// post bounces and the operator watches a silent build.
func TestTaskOwnerPromotionGivesAppBuilderChannelAccess(t *testing.T) {
	b := newTestBroker(t)
	const buildChannel = "build-thread"
	b.mu.Lock()
	defer b.mu.Unlock()
	b.members = []officeMember{
		{Slug: appBuilderSlug, Name: appBuilderRole, Role: appBuilderRole},
	}
	b.channels = []teamChannel{{
		Slug:    buildChannel,
		Name:    buildChannel,
		Members: []string{"human"},
	}}

	if b.canAccessChannelLocked(appBuilderSlug, buildChannel) {
		t.Fatalf("precondition: app builder should start outside %q", buildChannel)
	}
	b.ensureTaskOwnerChannelMembershipLocked(buildChannel, appBuilderSlug)
	if !b.canAccessChannelLocked(appBuilderSlug, buildChannel) {
		t.Fatalf("owning a task in %q must make the App Builder a member of it", buildChannel)
	}
}

// The half the founder explicitly preserved: "every bot knows what each
// bot is good for and potentially has knowledge of". The roster directory
// is public even though the conversations are private, so consulting still
// works — a bot that cannot see who exists cannot ask anyone for help.
func TestRosterDirectoryStaysVisibleToEveryBot(t *testing.T) {
	b, _ := dmBrokerWithRoster(t)
	b.mu.Lock()
	members := b.members
	b.mu.Unlock()

	// Rendered from the perspective of a bot with no channel access to
	// anyone else's conversations.
	block := renderAvailableBotsBlock(members, "eng")

	for _, want := range []string{
		"@" + LibrarianSlug, // Pam is listed…
		"Librarian",         // …with her role, so others know what she is for
		"@ceo",
		"@" + appBuilderSlug,
	} {
		if !strings.Contains(block, want) {
			t.Errorf("AVAILABLE AGENTS block must still advertise %q; got:\n%s", want, block)
		}
	}
}
