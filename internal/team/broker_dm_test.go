package team

import "testing"

// The canonical DM slug is the pair-sorted "<a>__<b>" from channel.DirectSlug.
// Recognition used to run through canonicalDMTargetBot, which answers ""
// unless one side is the human — so a bot-to-bot pair was not a DM at
// all and fell through to channel routing. These pin the shape-based
// recognition and the viewer-relative lookup that replaced it.

func TestIsDMSlugRecognisesBotToBotPair(t *testing.T) {
	t.Parallel()
	// The bug: "ceo__designer" has no human side, so the old
	// canonicalDMTargetBot-based test returned false and the consult relay
	// had no DM to route through.
	if !IsDMSlug("ceo__designer") {
		t.Fatal("bot-to-bot pair slug must be recognised as a DM")
	}
}

func TestIsDMSlugRecognisesHumanPairAndLegacyForms(t *testing.T) {
	t.Parallel()
	for _, slug := range []string{
		"human__eng",
		"eng__human",
		"dm-eng",
		"dm-human-eng",
	} {
		if !IsDMSlug(slug) {
			t.Errorf("IsDMSlug(%q) = false, want true", slug)
		}
	}
}

func TestIsDMSlugRejectsNonPairSlugs(t *testing.T) {
	t.Parallel()
	// normalizeChannelSlug collapses every single "_" to "-" and preserves
	// only "__", so a regular channel can never wear the pair shape. These
	// guard the edges of that guarantee.
	for _, slug := range []string{
		"general",
		"eng-standup",
		"eng_standup", // single underscore normalizes to "eng-standup"
		"a__b__c",     // three parts is not a 1:1 pair
		"__b",         // empty first side
		"a__",         // empty second side
	} {
		if IsDMSlug(slug) {
			t.Errorf("IsDMSlug(%q) = true, want false", slug)
		}
	}
}

func TestDMTargetBotStaysHumanRelative(t *testing.T) {
	t.Parallel()
	// A dozen call sites read DMTargetBot as "the bot the human is talking
	// to". Widening IsDMSlug must not quietly change that contract.
	if got := DMTargetBot("human__eng"); got != "eng" {
		t.Errorf("DMTargetBot(human__eng) = %q, want eng", got)
	}
	if got := DMTargetBot("dm-human-eng"); got != "eng" {
		t.Errorf("DMTargetBot(dm-human-eng) = %q, want eng", got)
	}
	if got := DMTargetBot("ceo__designer"); got != "" {
		t.Errorf("DMTargetBot on a bot-to-bot DM must stay empty; got %q", got)
	}
}

func TestDMOtherParticipantResolvesRelativeToViewer(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		slug   string
		viewer string
		want   string
	}{
		{"bot pair, ceo viewing", "ceo__designer", "ceo", "designer"},
		{"bot pair, designer viewing", "ceo__designer", "designer", "ceo"},
		{"human pair, human viewing", "human__eng", "human", "eng"},
		{"human pair, bot viewing", "human__eng", "eng", "human"},
		{"human alias 'you' viewing", "human__eng", "you", "eng"},
		{"legacy slug, human viewing", "dm-human-eng", "human", "eng"},
		{"legacy slug, bot viewing", "dm-human-eng", "eng", "human"},
		{"viewer is not a participant", "ceo__designer", "pm", ""},
		{"empty viewer cannot be resolved", "ceo__designer", "", ""},
		{"not a DM", "general", "ceo", ""},
		{"group DM has no readable pair", "a__b__c", "a", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := DMOtherParticipant(tc.slug, tc.viewer); got != tc.want {
				t.Errorf("DMOtherParticipant(%q, %q) = %q, want %q",
					tc.slug, tc.viewer, got, tc.want)
			}
		})
	}
}

func TestDMOtherParticipantNeverReturnsTheViewer(t *testing.T) {
	t.Parallel()
	// This is what makes the notifier's "don't echo a bot's own message
	// back to it" guard structural rather than a separate check.
	for _, viewer := range []string{"ceo", "designer", "human"} {
		for _, slug := range []string{"ceo__designer", "human__eng"} {
			if got := DMOtherParticipant(slug, viewer); got != "" && got == viewer {
				t.Errorf("DMOtherParticipant(%q, %q) returned the viewer", slug, viewer)
			}
		}
	}
}

func TestDMPartnerRefusesToGuessInAnBotToBotDM(t *testing.T) {
	t.Parallel()
	b := &Broker{}
	b.channels = []teamChannel{
		{Slug: "human__eng", Type: "dm", Members: []string{"human", "eng"}},
		{Slug: "ceo__designer", Type: "dm", Members: []string{"ceo", "designer"}},
	}

	if got := b.DMPartner("human__eng"); got != "eng" {
		t.Errorf("DMPartner(human__eng) = %q, want eng", got)
	}
	// Both members are real bots. The old "first non-human member wins" loop
	// handed the surface bridge a coin flip between them; with no viewer to
	// resolve against, "cannot route" is the only honest answer.
	if got := b.DMPartner("ceo__designer"); got != "" {
		t.Errorf("DMPartner on a bot-to-bot DM must not guess a side; got %q", got)
	}
}

// Not parallel: t.Setenv cannot be combined with t.Parallel.
func TestBotMCPServersTreatsCanonicalDMAsDMMode(t *testing.T) {
	// The stale check here was strings.HasPrefix(channel, "dm-"), so every
	// canonical DM silently got the full server set.
	t.Setenv("WUPHF_CHANNEL", "human__pm")
	got := botMCPServers("pm")
	if len(got) != 1 || got[0] != "wuphf-office" {
		t.Fatalf("canonical DM must get the minimal server set; got %v", got)
	}
}

func TestBotMCPServersKeepsFullSetOutsideDMs(t *testing.T) {
	t.Setenv("WUPHF_CHANNEL", "general")
	got := botMCPServers("pm")
	if len(got) != len(ServerKeys()) {
		t.Fatalf("non-DM channel must keep the full server set; got %v want %v", got, ServerKeys())
	}
}
