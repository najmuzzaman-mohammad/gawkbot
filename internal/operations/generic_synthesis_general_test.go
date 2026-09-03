package operations

import (
	"testing"

	"github.com/nex-crm/wuphf/internal/channel"
)

// Gate 7 of the #general kill switch lives in this package, so its proof does
// too: the broker-side test in internal/team cannot reach genericDefaultChannels.
//
// The synthesis path reaches the broker through
// blankSlateOfficeChannelsFromBlueprint (gate 4), which already skips a
// declared general, so this gate is defence in depth rather than the only
// thing standing between the switch and a resurrected channel. It still has to
// hold: a synthesized blueprint is a value other code can consume directly,
// and one that lists a channel the product no longer has is a lie in the data.
func TestGenericDefaultChannelsRespectsGeneralKillSwitch(t *testing.T) {
	hasGeneral := func(channels []StarterChannel) bool {
		for _, ch := range channels {
			if ch.Slug == channel.GeneralSlug {
				return true
			}
		}
		return false
	}

	t.Run("switch on: general leads the list", func(t *testing.T) {
		defer channel.SetGeneralEnabledForTest(true)()
		channels := genericDefaultChannels(nil)
		if !hasGeneral(channels) {
			t.Fatal("switch on: synthesis dropped #general, so this test cannot prove the gate")
		}
		if channels[0].Slug != channel.GeneralSlug {
			t.Errorf("general should stay first; got %q", channels[0].Slug)
		}
	})

	t.Run("switch off: general is absent, the rest survive", func(t *testing.T) {
		defer channel.SetGeneralEnabledForTest(false)()
		// Named channels are forced ON for this subtest, and that is the whole
		// point of it: the invariant under test is that the general gate is
		// INDEPENDENT of the named-channel gate. Both switches are off in
		// production today, so without pinning named channels on, "the rest
		// survive" would be vacuously true — the list is empty either way and
		// the test would pass while proving nothing.
		defer channel.SetNamedChannelsEnabledForTest(true)()
		channels := genericDefaultChannels(nil)
		if hasGeneral(channels) {
			t.Error("switch off: synthesis resurrected #general (gate 7 genericDefaultChannels)")
		}
		// Gating general must not take the other starter channels with it.
		for _, want := range []string{"planning", "execution", "review"} {
			found := false
			for _, ch := range channels {
				if ch.Slug == want {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("gating general also dropped #%s", want)
			}
		}
	})

	// Production shape: both switches off. A synthesized blueprint declares no
	// rooms at all, because the office it describes has none. Declaring one
	// would be a lie in the data that seeding then has to reject.
	t.Run("both switches off: no channels at all", func(t *testing.T) {
		defer channel.SetGeneralEnabledForTest(false)()
		defer channel.SetNamedChannelsEnabledForTest(false)()
		if channels := genericDefaultChannels(nil); len(channels) != 0 {
			t.Errorf("expected no channels with every room type retired, got %d: %+v", len(channels), channels)
		}
	})

	// The starter plan must not invent a roster either. planner / executor /
	// reviewer were BuiltIn on every synthesized blueprint, which is why they
	// "always showed up as default in a workspace". They are removed, not
	// renamed: a slug-level assertion so a future rename cannot smuggle the
	// concept back in under new labels.
	t.Run("no retired specialist bots are synthesized", func(t *testing.T) {
		plan := genericStarterPlan("gtm", "Acme", "Grow pipeline", SynthesisInput{}, nil, nil)
		for _, bot := range plan.Bots {
			switch bot.Slug {
			case "planner", "executor", "reviewer":
				t.Errorf("synthesis resurrected the retired built-in %q", bot.Slug)
			}
		}
		for _, task := range plan.Tasks {
			switch task.Owner {
			case "planner", "executor", "reviewer":
				t.Errorf("starter task %q is owned by the retired built-in %q", task.Title, task.Owner)
			}
			if task.Channel != "" {
				t.Errorf("starter task %q names channel %q; it should be homeless so the broker routes it to the owner's DM", task.Title, task.Channel)
			}
		}
	})
}
