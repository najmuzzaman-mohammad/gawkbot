package team

import (
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
)

// The DM branch of notificationTargetsForMessage used to resolve its single
// recipient with DMTargetBot, which is human-relative. In a bot-to-bot
// DM there is no human side, so it named nobody and the message reached
// nobody — the thing that blocked the consult relay (tagging a bot in your
// DM sends your bot to talk to theirs). It now resolves relative to the
// SENDER.

func dmRoutingTestLauncher(t *testing.T) *Launcher {
	t.Helper()
	return &Launcher{
		pack: &bot.PackDefinition{
			LeadSlug: "ceo",
			Bots: []bot.BotConfig{
				{Slug: "ceo", Name: "CEO"},
				{Slug: "designer", Name: "Designer"},
				{Slug: "eng", Name: "Engineer"},
			},
		},
	}
}

func onlyTarget(t *testing.T, targets []notificationTarget) string {
	t.Helper()
	if len(targets) != 1 {
		t.Fatalf("expected exactly one immediate target, got %d (%v)", len(targets), targets)
	}
	return targets[0].Slug
}

func TestDMRouting_AgentToAgentReachesTheOtherAgent(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	immediate, delayed := l.notificationTargetsForMessage(channelMessage{
		ID:      "dm-msg-1",
		From:    "ceo",
		Channel: "ceo__designer",
		Content: "what do you think of the pricing page?",
	})

	if got := onlyTarget(t, immediate); got != "designer" {
		t.Errorf("CEO's message in ceo__designer must wake designer; woke %q", got)
	}
	if len(delayed) != 0 {
		t.Errorf("DMs are isolated: no delayed targets, got %v", delayed)
	}
}

func TestDMRouting_AgentToAgentIsSymmetric(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	immediate, _ := l.notificationTargetsForMessage(channelMessage{
		ID:      "dm-msg-2",
		From:    "designer",
		Channel: "ceo__designer",
		Content: "shipping the mock now",
	})

	if got := onlyTarget(t, immediate); got != "ceo" {
		t.Errorf("designer's reply must wake ceo; woke %q", got)
	}
}

func TestDMRouting_HumanToAgentStillWakesTheAgent(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	// The common case, and the one that must not regress.
	for _, from := range []string{"human", "you"} {
		immediate, _ := l.notificationTargetsForMessage(channelMessage{
			ID:      "dm-msg-3",
			From:    from,
			Channel: "human__eng",
			Content: "can you look at the migration?",
		})
		if got := onlyTarget(t, immediate); got != "eng" {
			t.Errorf("human (%q) messaging human__eng must wake eng; woke %q", from, got)
		}
	}
}

func TestDMRouting_LegacySlugStillWakesTheAgent(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	for _, slug := range []string{"dm-eng", "dm-human-eng"} {
		immediate, _ := l.notificationTargetsForMessage(channelMessage{
			ID:      "dm-msg-4",
			From:    "human",
			Channel: slug,
			Content: "ping",
		})
		if got := onlyTarget(t, immediate); got != "eng" {
			t.Errorf("legacy slug %q must still wake eng; woke %q", slug, got)
		}
	}
}

func TestDMRouting_AgentReplyToHumanNotifiesNobody(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	// The other side is the human, who is not woken by the notifier. This also
	// covers the old "don't echo a bot's own message back" guard.
	immediate, delayed := l.notificationTargetsForMessage(channelMessage{
		ID:      "dm-msg-5",
		From:    "eng",
		Channel: "human__eng",
		Content: "done",
	})
	if len(immediate) != 0 || len(delayed) != 0 {
		t.Errorf("a bot replying to the human must wake nobody; got %v / %v", immediate, delayed)
	}
}

func TestDMRouting_NeverEchoesBackToTheSender(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	for _, sender := range []string{"ceo", "designer"} {
		immediate, _ := l.notificationTargetsForMessage(channelMessage{
			ID:      "dm-msg-6",
			From:    sender,
			Channel: "ceo__designer",
			Content: "thinking out loud",
		})
		for _, target := range immediate {
			if target.Slug == sender {
				t.Errorf("sender %q was woken by its own DM message", sender)
			}
		}
	}
}

func TestDMRouting_SystemPostStillWakesTheAgentInAHumanDM(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	// A broker/system post is not a DM participant, so the sender-relative
	// lookup cannot name a recipient. The human-relative fallback keeps these
	// waking the bot, as they always have.
	immediate, _ := l.notificationTargetsForMessage(channelMessage{
		ID:      "dm-msg-7",
		From:    "system",
		Channel: "human__eng",
		Content: "task DUNDE-4 moved to review",
	})
	if got := onlyTarget(t, immediate); got != "eng" {
		t.Errorf("system post in human__eng must still wake eng; woke %q", got)
	}
}

func TestDMRouting_SystemPostInAnAgentDMWakesNobody(t *testing.T) {
	l := dmRoutingTestLauncher(t)

	// Deliberate: with no viewer to resolve against there is no non-arbitrary
	// side to pick, so nobody is woken rather than a coin flip between two
	// real bots.
	immediate, delayed := l.notificationTargetsForMessage(channelMessage{
		ID:      "dm-msg-8",
		From:    "system",
		Channel: "ceo__designer",
		Content: "task DUNDE-4 moved to review",
	})
	if len(immediate) != 0 || len(delayed) != 0 {
		t.Errorf("system post in a bot-to-bot DM must wake nobody; got %v / %v", immediate, delayed)
	}
}
