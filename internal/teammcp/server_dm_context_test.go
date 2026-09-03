package teammcp

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// Two DM plumbing bugs, both from treating "dm-" as the DM format when the
// canonical slug is the pair-sorted "<a>__<b>" (channel.DirectSlug):
//
//  1. Tool registration tested the raw prefix, so a bot woken in a
//     canonical DM was not recognised as being in one and kept the tools that
//     let it post its way out.
//  2. Conversation context listed /channels with no type param, and the
//     broker EXCLUDES DMs from that default listing — so a bot standing in
//     a DM could not discover which DM it was in.

func hasTool(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

// escapeTools are the affordances that let a bot post its way out of a DM.
// team_channel creates and joins rooms; team_bridge posts to external
// surfaces. Both are lead-only, so the lead is the actor that makes the DM
// gate observable — for a specialist they are absent either way.
var escapeTools = []string{"team_channel", "team_bridge"}

func TestCanonicalDMSlugGetsTheMinimalToolSet(t *testing.T) {
	names := listRegisteredToolsWithSlug(t, "ceo", "human__ceo", false)

	for _, tool := range escapeTools {
		if hasTool(names, tool) {
			t.Errorf("lead in a canonical DM must not get %q", tool)
		}
	}
	// It still needs a voice and a way to read the conversation.
	for _, want := range []string{"team_broadcast", "team_poll", "human_message"} {
		if !hasTool(names, want) {
			t.Errorf("DM tool set is missing %q; got %v", want, names)
		}
	}
}

func TestBotToBotDMSlugAlsoGetsTheMinimalToolSet(t *testing.T) {
	// "ceo__designer" has no human side. The old canonicalDMTargetBot-based
	// recognition returned "" for it, so it was not a DM at any layer and the
	// lead kept its full structural tool set inside someone's DM.
	names := listRegisteredToolsWithSlug(t, "ceo", "ceo__designer", false)

	for _, tool := range escapeTools {
		if hasTool(names, tool) {
			t.Errorf("lead in a bot-to-bot DM must not get %q", tool)
		}
	}
}

func TestCanonicalDMTrimsASpecialistsOfficeTools(t *testing.T) {
	// A specialist never had the lead's structural tools, so the DM gate shows
	// up for them as the office coordination surface being trimmed away.
	names := listRegisteredToolsWithSlug(t, "pm", "human__pm", false)

	for _, tool := range []string{"team_channels", "team_dm_open", "team_members", "team_task"} {
		if hasTool(names, tool) {
			t.Errorf("specialist in a canonical DM must not get %q; got %v", tool, names)
		}
	}
	if !hasTool(names, "team_broadcast") {
		t.Errorf("specialist in a DM still needs a voice; got %v", names)
	}
}

func TestNonDMChannelKeepsTheFullToolSet(t *testing.T) {
	// The control, same actor: widening DM recognition must not strip tools
	// from a bot working in a real channel.
	names := listRegisteredToolsWithSlug(t, "ceo", "general", false)
	for _, tool := range escapeTools {
		if !hasTool(names, tool) {
			t.Errorf("lead in #general must keep %q; got %v", tool, names)
		}
	}
}

// channelsStub serves GET /channels the way the broker does: `type` is an
// EXCLUSIVE filter, so the default listing omits DMs entirely and ?type=dm
// returns only DMs. Records which variants were asked for.
func channelsStub(t *testing.T, regular, dms []map[string]any) *[]string {
	t.Helper()
	var seen []string
	srv, _ := stubBroker(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/channels" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("type") == "dm" {
			seen = append(seen, "dm")
			_ = json.NewEncoder(w).Encode(map[string]any{"channels": dms})
			return
		}
		seen = append(seen, "regular")
		_ = json.NewEncoder(w).Encode(map[string]any{"channels": regular})
	})
	withBrokerURL(t, srv.URL)
	return &seen
}

func TestFetchAccessibleChannelsFindsTheBotsOwnDM(t *testing.T) {
	seen := channelsStub(t,
		[]map[string]any{
			{"slug": "general", "members": []string{"pm", "ceo"}},
		},
		[]map[string]any{
			{"slug": "human__pm", "members": []string{"human", "pm"}},
		},
	)

	got := fetchAccessibleChannels(context.Background(), "pm")

	slugs := map[string]bool{}
	for _, ch := range got {
		slugs[ch.Slug] = true
	}
	if !slugs["human__pm"] {
		t.Errorf("bot must be able to discover its own DM; got %v", got)
	}
	// Asking for ?type=dm alone would have swapped one blind spot for a worse
	// one — the bot would lose every real channel.
	if !slugs["general"] {
		t.Errorf("regular channels must survive the DM lookup; got %v", got)
	}
	if len(*seen) != 2 {
		t.Errorf("expected both listings to be fetched, got %v", *seen)
	}
}

func TestFetchAccessibleChannelsStillFiltersByMembership(t *testing.T) {
	// Discovering DMs must not hand a bot someone else's DM.
	channelsStub(t,
		[]map[string]any{
			{"slug": "general", "members": []string{"pm"}},
		},
		[]map[string]any{
			{"slug": "human__pm", "members": []string{"human", "pm"}},
			{"slug": "human__eng", "members": []string{"human", "eng"}},
			{"slug": "ceo__designer", "members": []string{"ceo", "designer"}},
		},
	)

	for _, ch := range fetchAccessibleChannels(context.Background(), "pm") {
		if ch.Slug == "human__eng" || ch.Slug == "ceo__designer" {
			t.Errorf("pm must not see a DM it is not a member of: %q", ch.Slug)
		}
	}
}

func TestFetchAccessibleChannelsHonoursDisabled(t *testing.T) {
	channelsStub(t,
		[]map[string]any{},
		[]map[string]any{
			{"slug": "human__pm", "members": []string{"human", "pm"}, "disabled": []string{"pm"}},
		},
	)

	if got := fetchAccessibleChannels(context.Background(), "pm"); len(got) != 0 {
		t.Errorf("a disabled DM must not be listed; got %v", got)
	}
}

func TestFetchAccessibleChannelsSurvivesOneLegFailing(t *testing.T) {
	// A partial view beats blanking the bot's whole world.
	srv, _ := stubBroker(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("type") == "dm" {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"channels": []map[string]any{{"slug": "general", "members": []string{"pm"}}},
		})
	})
	withBrokerURL(t, srv.URL)

	got := fetchAccessibleChannels(context.Background(), "pm")
	if len(got) != 1 || got[0].Slug != "general" {
		t.Errorf("regular channels must survive a failing DM listing; got %v", got)
	}
}

func TestFetchAccessibleChannelsReturnsNilWhenBothLegsFail(t *testing.T) {
	srv, _ := stubBroker(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	withBrokerURL(t, srv.URL)

	if got := fetchAccessibleChannels(context.Background(), "pm"); got != nil {
		t.Errorf("both legs failing must return nil, as callers already handle; got %v", got)
	}
}

func TestFetchAccessibleChannelsDedupesBySlug(t *testing.T) {
	// The two listings are disjoint today, but a handler change must not be
	// able to double-list a channel into the bot's context packet.
	channelsStub(t,
		[]map[string]any{{"slug": "human__pm", "members": []string{"human", "pm"}}},
		[]map[string]any{{"slug": "human__pm", "members": []string{"human", "pm"}}},
	)

	got := fetchAccessibleChannels(context.Background(), "pm")
	if len(got) != 1 {
		t.Errorf("expected the duplicate to be collapsed, got %v", got)
	}
}
