package team

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/channel"
	"github.com/nex-crm/wuphf/internal/onboarding"
)

// enableGeneralForTest turns #general back on for the duration of one test and
// makes sure the given broker actually has the channel, so a fixture that
// depends on a shared room can opt back in with a single line:
//
//	b := newRawTestBroker(t)
//	enableGeneralForTest(t, b)
//
// It exists for the stage where generalChannelEnabled starts returning false:
// dozens of existing fixtures assume a #general to post into, and rewriting
// them all in one change would bury the behaviour change in churn. Opting a
// fixture in is a deliberate statement that the test is about the shared room,
// not that it has not been migrated yet.
//
// The flip is package-level state shared across the whole test binary, so the
// restore is registered with t.Cleanup rather than left to the caller.
func enableGeneralForTest(t *testing.T, b *Broker) {
	t.Helper()
	t.Cleanup(channel.SetGeneralEnabledForTest(true))
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	// The broker was constructed while the switch may have been off, so the
	// boot-time ensure would have skipped general. Re-run it now that the
	// switch is on.
	b.ensureDefaultChannelsLocked()
}

// hasChannel reports whether the broker currently holds the given slug.
func hasChannel(t *testing.T, b *Broker, slug string) bool {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.channels {
		if b.channels[i].Slug == slug {
			return true
		}
	}
	return false
}

// isolateRuntimeHome pins HOME so a test's broker, config, and manifest never
// touch the developer's real ~/.wuphf.
func isolateRuntimeHome(t *testing.T) {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("WUPHF_RUNTIME_HOME", tmp)
}

// TestGeneralChannelKillSwitchHasNoResurrectionPath is the proof that every
// gate is threaded. #general is minted from seven independent places, and a
// single missed one self-heals the channel on the next boot — which is the
// most likely way this whole change fails silently. So rather than unit-test
// the gates one by one, this drives each mint path with the switch off and
// asserts the channel never appears.
//
// Each subtest first proves the path DOES produce general with the switch on.
// Without that, a subtest would still pass if the path stopped producing
// channels entirely for some unrelated reason, and the gate would look
// threaded when it was really just dead.
func TestGeneralChannelKillSwitchHasNoResurrectionPath(t *testing.T) {
	t.Run("gates 1-3: a full Load cycle on a fresh broker", func(t *testing.T) {
		isolateRuntimeHome(t)

		withSwitch(t, true, func() {
			b := newRawTestBroker(t)
			if !hasChannel(t, b, GeneralChannelSlug) {
				t.Fatal("switch on: boot did not create #general, so this subtest cannot prove the gate")
			}
		})
		withSwitch(t, false, func() {
			b := newRawTestBroker(t)
			if hasChannel(t, b, GeneralChannelSlug) {
				t.Error("switch off: boot resurrected #general (gate 1 ensureDefaultChannelsLocked, gate 2 defaultTeamChannels, or gate 3 company manifest)")
			}
		})
	})

	t.Run("gates 4-5: the blueprint seed and its zero-channel fallback", func(t *testing.T) {
		isolateRuntimeHome(t)
		ensureOperationsFallbackFS(t)

		const task = "Audit the CRM"
		withSwitch(t, true, func() {
			b := newRawTestBroker(t)
			if err := b.onboardingCompleteFn(task, false, "", []string{}, "Co"); err != nil {
				t.Fatalf("seed: %v", err)
			}
			if !hasChannel(t, b, GeneralChannelSlug) {
				t.Fatal("switch on: the seed did not create #general, so this subtest cannot prove the gate")
			}
		})
		withSwitch(t, false, func() {
			b := newRawTestBroker(t)
			if err := b.onboardingCompleteFn(task, false, "", []string{}, "Co"); err != nil {
				t.Fatalf("seed: %v", err)
			}
			if hasChannel(t, b, GeneralChannelSlug) {
				t.Error("switch off: the blueprint seed resurrected #general (gate 4 blankSlateOfficeChannelsFromBlueprint or gate 5 the zero-channel fallback)")
			}
		})
	})

	t.Run("gate 6: the minimal scratch seed", func(t *testing.T) {
		isolateRuntimeHome(t)

		seed := func() *Broker {
			b := newRawTestBroker(t)
			b.mu.Lock()
			defer b.mu.Unlock()
			if err := b.seedMinimalScratchLocked(&onboarding.State{}); err != nil {
				t.Fatalf("scratch seed: %v", err)
			}
			return b
		}
		withSwitch(t, true, func() {
			if !hasChannel(t, seed(), GeneralChannelSlug) {
				t.Fatal("switch on: the scratch seed did not create #general, so this subtest cannot prove the gate")
			}
		})
		withSwitch(t, false, func() {
			if hasChannel(t, seed(), GeneralChannelSlug) {
				t.Error("switch off: the scratch seed resurrected #general (gate 6 seedMinimalScratchLocked)")
			}
		})
	})
}

// TestGeneralChannelKillSwitchNeverDeletes pins the constraint that makes the
// switch reversible. The founder asked to "keep the code for general so that
// we can bring it back whenever we want" — which only holds if the history is
// still there when it comes back. A gate that removed the persisted row
// instead of declining to create one would pass every test above and quietly
// destroy the thing the switch is supposed to preserve.
func TestGeneralChannelKillSwitchNeverDeletes(t *testing.T) {
	isolateRuntimeHome(t)

	restore := channel.SetGeneralEnabledForTest(false)
	defer restore()

	b := newRawTestBroker(t)
	// Stand in for a workspace that used #general before the switch was
	// thrown: the row and its history are already on disk.
	b.mu.Lock()
	b.channels = append(b.channels, teamChannel{
		Slug:    GeneralChannelSlug,
		Name:    GeneralChannelSlug,
		Members: []string{"ceo"},
	})
	b.messages = append(b.messages, channelMessage{
		ID: "msg-1", From: "human", Channel: GeneralChannelSlug, Content: "the old room",
	})
	b.ensureDefaultChannelsLocked()
	b.normalizeLoadedStateLocked()
	b.mu.Unlock()

	if !hasChannel(t, b, GeneralChannelSlug) {
		t.Error("an existing #general row was removed; the switch must decline to create, never delete")
	}
	b.mu.Lock()
	kept := 0
	for i := range b.messages {
		if b.messages[i].Channel == GeneralChannelSlug {
			kept++
		}
	}
	b.mu.Unlock()
	if kept == 0 {
		t.Error("#general history was dropped; flipping the switch back must find it intact")
	}
}

// TestHomeChannelForHasExactlyThreeOutcomes pins the no-leak router. The third
// case is the point of the whole function: with #general gone, an actor that
// cannot be resolved has nowhere real to post, and inventing a destination
// would put messages in a channel nobody reads.
func TestHomeChannelForHasExactlyThreeOutcomes(t *testing.T) {
	isolateRuntimeHome(t)

	t.Run("switch on: always general", func(t *testing.T) {
		defer channel.SetGeneralEnabledForTest(true)()
		b := newRawTestBroker(t)
		b.mu.Lock()
		defer b.mu.Unlock()
		// Even an actor who is not on the roster gets general while it exists.
		got, err := b.homeChannelForLocked("nobody-at-all")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != GeneralChannelSlug {
			t.Errorf("got %q, want %q", got, GeneralChannelSlug)
		}
	})

	t.Run("switch off: a roster member routes to their DM", func(t *testing.T) {
		defer channel.SetGeneralEnabledForTest(false)()
		b := newRawTestBroker(t)
		b.mu.Lock()
		defer b.mu.Unlock()
		b.members = []officeMember{{Slug: "ceo", Name: "CEO", BuiltIn: true}}
		b.rebuildMemberIndexLocked()

		got, err := b.homeChannelForLocked("ceo")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got == GeneralChannelSlug || got == "" {
			t.Fatalf("expected a DM slug, got %q", got)
		}
		if DMTargetBot(got) != "ceo" {
			t.Errorf("routed to %q, which is not the CEO's DM", got)
		}
		// The DM must actually exist afterwards, not just be named.
		if !hasChannelLocked(b, got) {
			t.Errorf("homeChannelForLocked named %q but did not create it", got)
		}
	})

	t.Run("switch off: an unresolvable actor is an error, never a slug", func(t *testing.T) {
		defer channel.SetGeneralEnabledForTest(false)()
		b := newRawTestBroker(t)
		b.mu.Lock()
		defer b.mu.Unlock()
		b.members = nil
		b.rebuildMemberIndexLocked()

		for _, actor := range []string{"", "   ", "not-a-member"} {
			got, err := b.homeChannelForLocked(actor)
			if err == nil {
				t.Errorf("actor %q: expected an error, got channel %q", actor, got)
			}
			if got != "" {
				t.Errorf("actor %q: returned slug %q alongside an error; callers must get nothing to fall back to", actor, got)
			}
		}
	})
}

// hasChannelLocked is the b.mu-held variant of hasChannel, for assertions made
// from inside a locked section.
func hasChannelLocked(b *Broker, slug string) bool {
	for i := range b.channels {
		if b.channels[i].Slug == slug {
			return true
		}
	}
	return false
}

// withSwitch runs fn with the #general switch pinned to `enabled`, restoring
// the previous value afterwards even if fn calls t.Fatal.
func withSwitch(t *testing.T, enabled bool, fn func()) {
	t.Helper()
	restore := channel.SetGeneralEnabledForTest(enabled)
	defer restore()
	fn()
}

// TestGroupDMKillSwitchRefusesAtTheAPI covers the HTTP surface of the group-DM
// retirement: the two routes into a group (explicit type:"group", and the
// >2-members request that silently upgrades itself into one) must both be
// refused, and refused as a 409 rather than a 400 — asking for a group is a
// conflict with the workspace's shape, not a malformed request.
func TestGroupDMKillSwitchRefusesAtTheAPI(t *testing.T) {
	isolateRuntimeHome(t)

	b := newRawTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()

	postDM := func(t *testing.T, payload map[string]any) *http.Response {
		t.Helper()
		body, _ := json.Marshal(payload)
		req, _ := http.NewRequest(http.MethodPost,
			fmt.Sprintf("http://%s/channels/dm", b.Addr()), bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+b.Token())
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST /channels/dm: %v", err)
		}
		return resp
	}

	group := []string{"human", "ceo", "librarian"}

	t.Run("switch on: a group DM is created", func(t *testing.T) {
		defer channel.SetGroupDMsEnabledForTest(true)()
		resp := postDM(t, map[string]any{"members": group, "type": "group"})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			raw, _ := io.ReadAll(resp.Body)
			t.Fatalf("switch on: group create returned %d (%s), so this test cannot prove the gate", resp.StatusCode, raw)
		}
	})

	t.Run("switch off: both routes into a group 409", func(t *testing.T) {
		defer channel.SetGroupDMsEnabledForTest(false)()
		// A fresh member set, so the exemption for already-existing groups
		// (which the subtest above created) does not mask the refusal.
		fresh := []string{"human", "ceo", "app-builder"}
		for _, payload := range []map[string]any{
			{"members": fresh, "type": "group"},  // explicit
			{"members": fresh, "type": "direct"}, // the >2-members upgrade
			{"members": fresh},                   // no type at all
		} {
			resp := postDM(t, payload)
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusConflict {
				t.Errorf("payload %v: got status %d, want 409; body %s", payload, resp.StatusCode, raw)
			}
			if !strings.Contains(string(raw), "group DMs are retired") {
				t.Errorf("payload %v: 409 body does not say why: %s", payload, raw)
			}
		}
	})

	t.Run("switch off: a 1:1 DM is unaffected", func(t *testing.T) {
		defer channel.SetGroupDMsEnabledForTest(false)()
		// Both spellings of a two-participant request. type:"group" with only
		// two members has always produced a plain 1:1 DM, and must keep doing
		// so — the refusal is keyed on the member count, not on the label,
		// because two participants is exactly what the new model wants.
		for _, payload := range []map[string]any{
			{"members": []string{"human", "ceo"}, "type": "direct"},
			{"members": []string{"human", "ceo"}, "type": "group"},
		} {
			resp := postDM(t, payload)
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("payload %v: retiring group DMs broke a 1:1 DM: status %d, body %s", payload, resp.StatusCode, raw)
			}
		}
	})
}

// TestGroupDMKillSwitchWithholdsFromListing pins the list half, and with it
// the target end state: no surface where three or more participants share a
// conversation the human reads. The row itself must survive — withheld from
// the listing, not deleted — so a revive finds it intact.
func TestGroupDMKillSwitchWithholdsFromListing(t *testing.T) {
	isolateRuntimeHome(t)

	b := newRawTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()

	b.mu.Lock()
	b.channels = append(b.channels,
		teamChannel{Slug: "abc123groupslug", Name: "Group DM", Type: "dm",
			Members: []string{"human", "ceo", "librarian"}},
		teamChannel{Slug: DMSlugFor("ceo"), Name: "CEO", Type: "dm",
			Members: []string{"human", "ceo"}},
	)
	b.mu.Unlock()

	// Drive the real GET /channels?type=dm handler. Reimplementing its filter
	// here would test the test: it would still pass if the handler had no gate
	// at all.
	listDMs := func(t *testing.T) []teamChannel {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet,
			fmt.Sprintf("http://%s/channels?type=dm", b.Addr()), nil)
		req.Header.Set("Authorization", "Bearer "+b.Token())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET /channels: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			raw, _ := io.ReadAll(resp.Body)
			t.Fatalf("GET /channels status %d: %s", resp.StatusCode, raw)
		}
		var payload struct {
			Channels []teamChannel `json:"channels"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			t.Fatalf("decode channels: %v", err)
		}
		return payload.Channels
	}

	withGroupSwitch(t, true, func() {
		found := false
		for _, ch := range listDMs(t) {
			if ch.Slug == "abc123groupslug" {
				found = true
			}
		}
		if !found {
			t.Fatal("switch on: the group DM was not listed, so this test cannot prove the gate")
		}
	})

	withGroupSwitch(t, false, func() {
		for _, ch := range listDMs(t) {
			if len(ch.Members) > 2 {
				t.Errorf("a conversation with %d participants is still listed: %s", len(ch.Members), ch.Slug)
			}
			if ch.Slug == "abc123groupslug" {
				t.Error("the group DM is still listed")
			}
		}
		// The 1:1 must survive the filter.
		if len(listDMs(t)) == 0 {
			t.Error("withholding group DMs also withheld the 1:1 DM")
		}
	})

	// Never deleted: the row is still in the broker's state either way.
	b.mu.Lock()
	defer b.mu.Unlock()
	if !hasChannelLocked(b, "abc123groupslug") {
		t.Error("the group DM row was removed; the switch must withhold from the listing, never delete")
	}
}

// withGroupSwitch runs fn with the group-DM switch pinned, restoring after.
func withGroupSwitch(t *testing.T, enabled bool, fn func()) {
	t.Helper()
	restore := channel.SetGroupDMsEnabledForTest(enabled)
	defer restore()
	fn()
}

// TestNamedChannelRetirementKeepsBridgesAndAppThreads is mostly a test of the
// CARVE-OUTS. That named rooms disappear is the easy half; the half that breaks
// the product if it is wrong is what must survive:
//
//   - Slack and Telegram bridge channels are how EXTERNAL messages arrive, not
//     rooms bots chat in. Hide one and every message that came in through it
//     is stranded.
//   - app-<id> edit threads are hidden plumbing that apps need to be editable.
//   - DMs are the surface the whole change exists to move everything onto.
func TestNamedChannelRetirementKeepsBridgesAndAppThreads(t *testing.T) {
	isolateRuntimeHome(t)

	b := newRawTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()

	b.mu.Lock()
	b.channels = append(b.channels,
		teamChannel{Slug: "product", Name: "product", Members: []string{"ceo"}},
		teamChannel{Slug: "slack-sales", Name: "slack-sales", Members: []string{"ceo"},
			Surface: &channelSurface{Provider: "slack", RemoteID: "C123"}},
		teamChannel{Slug: appEditChannelPrefix + "abc", Name: "app build", Members: []string{"ceo"}},
		teamChannel{Slug: DMSlugFor("ceo"), Name: "CEO", Type: "dm", Members: []string{"human", "ceo"}},
	)
	b.mu.Unlock()

	listRooms := func(t *testing.T) map[string]bool {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet,
			fmt.Sprintf("http://%s/channels", b.Addr()), nil)
		req.Header.Set("Authorization", "Bearer "+b.Token())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET /channels: %v", err)
		}
		defer resp.Body.Close()
		var payload struct {
			Channels []teamChannel `json:"channels"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			t.Fatalf("decode: %v", err)
		}
		out := map[string]bool{}
		for _, ch := range payload.Channels {
			out[ch.Slug] = true
		}
		return out
	}

	t.Run("switch on: the named room is listed", func(t *testing.T) {
		defer channel.SetNamedChannelsEnabledForTest(true)()
		if !listRooms(t)["product"] {
			t.Fatal("switch on: #product was not listed, so this test cannot prove the gate")
		}
	})

	t.Run("switch off: the named room goes, the bridge stays", func(t *testing.T) {
		defer channel.SetNamedChannelsEnabledForTest(false)()
		got := listRooms(t)
		if got["product"] {
			t.Error("#product is still listed")
		}
		if !got["slack-sales"] {
			t.Error("the Slack bridge channel was hidden — external messages arriving through it " +
				"would be stranded. Bridges are explicitly out of scope for this retirement")
		}
	})

	t.Run("switch off: creating a named channel 409s", func(t *testing.T) {
		defer channel.SetNamedChannelsEnabledForTest(false)()
		body, _ := json.Marshal(map[string]any{
			"action": "create", "slug": "gtm", "name": "gtm", "created_by": "human",
		})
		req, _ := http.NewRequest(http.MethodPost,
			fmt.Sprintf("http://%s/channels", b.Addr()), bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+b.Token())
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST /channels: %v", err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusConflict {
			t.Errorf("got %d, want 409; body %s", resp.StatusCode, raw)
		}
		if !strings.Contains(string(raw), "named channels are retired") {
			t.Errorf("the 409 does not say why: %s", raw)
		}
	})

	t.Run("nothing was deleted", func(t *testing.T) {
		defer channel.SetNamedChannelsEnabledForTest(false)()
		b.mu.Lock()
		defer b.mu.Unlock()
		if !hasChannelLocked(b, "product") {
			t.Error("the #product row was removed; the switch must withhold from the listing, never delete")
		}
	})
}

// TestBlueprintAndSynthesisChannelsRespectTheSwitch covers the two SEED paths.
// They matter separately from the listing gate: a seed that still mints
// #product would put the row back on every fresh workspace, so the listing gate
// would be hiding a channel the office keeps re-creating.
func TestBlueprintAndSynthesisChannelsRespectTheSwitch(t *testing.T) {
	isolateRuntimeHome(t)
	ensureOperationsFallbackFS(t)

	seed := func(t *testing.T) map[string]bool {
		t.Helper()
		b := newRawTestBroker(t)
		if err := b.onboardingCompleteFn("Audit the CRM", false, "", []string{}, "Co"); err != nil {
			t.Fatalf("seed: %v", err)
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		out := map[string]bool{}
		for i := range b.channels {
			out[b.channels[i].Slug] = true
		}
		return out
	}

	withSwitch(t, true, func() {
		defer channel.SetNamedChannelsEnabledForTest(true)()
		if got := seed(t); !got["product"] && !got["gtm"] {
			t.Fatal("switch on: the scratch blueprint seeded no named rooms, so this test cannot prove the gate")
		}
	})

	withSwitch(t, true, func() {
		defer channel.SetNamedChannelsEnabledForTest(false)()
		got := seed(t)
		for _, slug := range []string{"product", "gtm"} {
			if got[slug] {
				t.Errorf("the seed still minted #%s", slug)
			}
		}
		// #general has its own switch and is still on here, so it must survive:
		// the two retirements are independent and must not fold into each other.
		if !got[GeneralChannelSlug] {
			t.Error("retiring named channels also took #general, whose own switch is still on")
		}
	})
}
