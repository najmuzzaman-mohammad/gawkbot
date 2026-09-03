package team

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The founder retired every default bot except the lead: "planner,executor,
// reviewer always show up as default in a workspace. let's remove them
// completely from everywhere. that concept should now be gone with those bots
// as default. their defintions also shouldn't exist" — after twice asking for
// the Librarian and App Builder to go ("there should be no librarian or app
// builder bot anymore by default").
//
// These tests pin the OUTCOME on a constructed broker, not that a seeding
// function returned early. That distinction is the whole reason this file
// exists: the first removal attempt edited the default roster and looked done,
// while the ensure-style back-fills quietly re-added both bots on every
// load. A test on the seed list alone stayed green through the entire bug.

// A brand-new office is the Chief of Staff alone, reachable in one DM.
// Specialists are created on demand, not preinstalled.
func TestFreshOfficeSeedsOnlyTheChiefOfStaff(t *testing.T) {
	b := NewBrokerAt(filepath.Join(t.TempDir(), "broker-state.json"))
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.members) != 1 {
		slugs := make([]string, 0, len(b.members))
		for _, m := range b.members {
			slugs = append(slugs, m.Slug)
		}
		t.Fatalf("fresh roster = %v, want exactly [ceo]", slugs)
	}
	m := b.members[0]
	if m.Slug != "ceo" {
		t.Fatalf("sole member slug = %q, want \"ceo\"", m.Slug)
	}
	if m.Name != "Chief of Staff" {
		t.Errorf("lead name = %q, want \"Chief of Staff\"", m.Name)
	}
	if !m.BuiltIn {
		t.Error("the lead must stay built-in (undeletable)")
	}

	var dms []string
	for _, c := range b.channels {
		if c.Type == "dm" || IsDMSlug(c.Slug) {
			dms = append(dms, c.Slug)
		}
	}
	if len(dms) != 1 || dms[0] != "ceo__human" {
		t.Errorf("DMs = %v, want exactly [ceo__human]", dms)
	}
}

// The retired bots' definitions are gone from every seed path, and — the
// part that failed last time — nothing re-adds them on load. A roster without
// them stays without them.
func TestLoadDoesNotResurrectRetiredBots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broker-state.json")
	b := NewBrokerAt(path)
	b.mu.Lock()
	if err := b.saveLocked(); err != nil {
		t.Fatalf("save: %v", err)
	}
	b.mu.Unlock()

	// A second boot is where the ensure-style back-fills used to fire.
	b2 := NewBrokerAt(path)
	b2.mu.Lock()
	defer b2.mu.Unlock()
	for _, m := range b2.members {
		switch m.Slug {
		case "librarian", "app-builder", "planner", "executor", "reviewer":
			t.Errorf("reboot resurrected retired bot %q: a back-fill is still live", m.Slug)
		}
	}
	if len(b2.members) != 1 {
		t.Errorf("roster after reboot has %d members, want 1", len(b2.members))
	}
}

// Existing workspaces are the other half of the contract. Their retired
// bots own DMs, tasks, and history on real disks, so they LOAD unchanged —
// except for two reconciliations: the Office-referencing display name
// "Pam the librarian" is rebranded (the founder banned Office references),
// and the retired bots lose BuiltIn so users can finally delete them.
func TestLegacyWorkspaceKeepsItsBotsButDropsTheOfficeName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "broker-state.json")

	legacy := map[string]any{
		"members": []map[string]any{
			{"slug": "ceo", "name": "CEO", "role": "CEO", "built_in": true},
			{"slug": "librarian", "name": "Pam the librarian", "role": "Librarian", "built_in": true},
			{"slug": "app-builder", "name": "App Builder", "role": "App Builder", "built_in": true},
			{"slug": "planner", "name": "Planner", "role": "Planner"},
		},
		"channels": []map[string]any{
			{"slug": "human__librarian", "name": "human__librarian", "type": "dm", "members": []string{"human", "librarian"}},
		},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// The package TestMain sets skipBrokerStateLoadOnConstruct so tests start
	// fresh; this test exists precisely to exercise the disk-load path, so it
	// opts back in (same idiom as TestNewBroker_SkipStateLoadGateRespected —
	// safe while no test here calls t.Parallel()).
	oldGate := skipBrokerStateLoadOnConstruct
	skipBrokerStateLoadOnConstruct = false
	t.Cleanup(func() { skipBrokerStateLoadOnConstruct = oldGate })

	b := NewBrokerAt(path)
	b.mu.Lock()
	defer b.mu.Unlock()

	got := map[string]officeMember{}
	for _, m := range b.members {
		got[m.Slug] = m
	}
	for _, slug := range []string{"ceo", "librarian", "app-builder", "planner"} {
		if _, ok := got[slug]; !ok {
			t.Fatalf("legacy member %q was dropped on load: existing workspaces must keep their bots", slug)
		}
	}
	if name := got["librarian"].Name; name != "Librarian" {
		t.Errorf("librarian name = %q, want \"Librarian\" (Office references are banned)", name)
	}
	if got["librarian"].BuiltIn {
		t.Error("legacy librarian still BuiltIn: users could not delete a bot the product no longer defines")
	}
	if got["app-builder"].BuiltIn {
		t.Error("legacy app-builder still BuiltIn: users could not delete a bot the product no longer defines")
	}
	if !got["ceo"].BuiltIn {
		t.Error("the lead lost BuiltIn on load")
	}
	if got["ceo"].Name != "Chief of Staff" {
		t.Errorf("lead name = %q, want the reconciled \"Chief of Staff\"", got["ceo"].Name)
	}
	if b.findChannelLocked("human__librarian") == nil {
		t.Error("legacy librarian DM was dropped on load")
	}
}

// The founder's onboarding spec, no-task branch: "if no task was kicked off,
// the Chief of Staff should have a first prompt to introduce itself and the
// features and ask for the person's goal to plan the first thing to do."
//
// The regression this pins: the old welcome was posted From "system" with
// copy describing a six-bot office ("the team are online and ready ...
// they'll claim work, argue, and ship"). Landing in a DM only works if
// somebody is actually there, so the OUTCOME asserted is a message in the
// lead's DM, from the lead, that asks for the goal.
func TestSkipTaskOnboardingOpensWithTheChiefOfStaffIntro(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("", true, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	lead := officeLeadSlugFromMembers(b.members)
	if lead == "" {
		t.Fatal("no lead in the seeded roster")
	}
	var intro *channelMessage
	for i := range b.messages {
		if b.messages[i].From == lead {
			intro = &b.messages[i]
			break
		}
	}
	if intro == nil {
		t.Fatal("no message from the lead: the office opens silent, or the intro still speaks as \"system\"")
	}
	if !IsDMSlug(intro.Channel) {
		t.Errorf("intro landed in %q, want the lead's DM", intro.Channel)
	}
	if !strings.Contains(intro.Content, "what are you trying to get done") {
		t.Errorf("intro does not ask for the goal; content = %q", intro.Content)
	}
	for _, banned := range []string{"argue", "the team are online", "bystander"} {
		if strings.Contains(strings.ToLower(intro.Content), banned) {
			t.Errorf("intro still carries retired copy %q", banned)
		}
	}
}
