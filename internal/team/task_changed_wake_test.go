package team

import (
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
)

// The founder's requirement: "any manual changes to tasks should be reported to
// the channel and the task owner (default CEO) should respond to those
// changes."
//
// The reporting half is postHumanTaskChangeLocked. This pins the RESPONDING
// half, which is the part that can silently rot: announcing a change into the
// channel is worthless if nobody wakes to read it. The announcement is posted
// as the human and tags the owner, so it has to route like any other human
// address — straight to the owner.
//
// These tests run against focus mode, the routing that is hardest on this case:
// it deliberately suppresses cross-bot chatter so specialists only wake when
// the CEO or a human addresses them. A task_changed post must clear that bar.

func taskChangedLauncher() *Launcher {
	return &Launcher{
		focusMode: true,
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

// A task owned by a specialist: that specialist wakes to answer for it.
func TestTaskChangedWakesTheSpecialistOwner(t *testing.T) {
	l := taskChangedLauncher()
	immediate, _ := l.notificationTargetsForMessage(channelMessage{
		From:    "you",
		Kind:    "task_changed",
		Channel: "team",
		Content: "Updated DUNDE-12 (Fix the header): status open -> in_progress. @designer — you own this.",
		Tagged:  []string{"designer"},
	})

	var woke []string
	for _, tgt := range immediate {
		woke = append(woke, tgt.Slug)
	}
	found := false
	for _, s := range woke {
		if s == "designer" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the owner must wake to respond to a manual task change, woke=%v", woke)
	}
}

// The default case, and the one the founder named explicitly: an unowned task
// falls to the CEO, so the CEO must wake.
func TestTaskChangedWakesTheCEOByDefault(t *testing.T) {
	l := taskChangedLauncher()
	immediate, _ := l.notificationTargetsForMessage(channelMessage{
		From:    "you",
		Kind:    "task_changed",
		Channel: "team",
		Content: "Updated DUNDE-13 (Ship the docs): title -> \"Ship the docs\". @ceo — you own this.",
		Tagged:  []string{"ceo"},
	})

	for _, tgt := range immediate {
		if tgt.Slug == "ceo" {
			return
		}
	}
	t.Fatalf("the CEO owns unowned tasks and must wake for a manual change, got %+v", immediate)
}
