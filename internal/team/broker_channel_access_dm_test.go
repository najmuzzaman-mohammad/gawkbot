package team

import "testing"

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

// Membership — not identity — is what grants access on an ORDINARY channel.
// Adding a bot to the conversation is the supported way in, and it must still
// work.
//
// A DM is the deliberate exception, and it is asserted here too so the two
// rules stay visible side by side: a DM admits exactly the two participants
// its slug names and ignores its stored Members list entirely
// (canAccessChannelLocked, broker_channel_access.go — "There is no path for a
// third party into a DM"). This test used to assert the opposite for the DM
// case, which is the bypass that change closed on purpose.
func TestMembershipGrantsChannelAccess(t *testing.T) {
	b, dmChannel := dmBrokerWithRoster(t)
	b.mu.Lock()
	defer b.mu.Unlock()

	const room = "delivery"
	b.channels = append(b.channels, teamChannel{
		Slug: room, Name: room, Members: []string{"human", "eng"},
	})

	// Ordinary channel: membership is the gate, and it opens.
	if b.canAccessChannelLocked(LibrarianSlug, room) {
		t.Fatalf("precondition: librarian should start outside %q", room)
	}
	for i := range b.channels {
		if b.channels[i].Slug == room {
			b.channels[i].Members = append(b.channels[i].Members, LibrarianSlug)
		}
	}
	if !b.canAccessChannelLocked(LibrarianSlug, room) {
		t.Fatalf("librarian was added to %q and must now reach it", room)
	}

	// DM: the same edit must NOT open it. The slug names the two parties.
	for i := range b.channels {
		if b.channels[i].Slug == dmChannel {
			b.channels[i].Members = append(b.channels[i].Members, LibrarianSlug)
		}
	}
	if b.canAccessChannelLocked(LibrarianSlug, dmChannel) {
		t.Fatalf("a drifted Members row must not admit a third party to DM %q", dmChannel)
	}
}
