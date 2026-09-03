package team

import (
	"fmt"
	"testing"

	"github.com/nex-crm/wuphf/internal/channel"
)

// The onboarding wizard hides the starter-pack step behind
// ONBOARDING_TEAM_PACKS_ENABLED (web/src/components/onboarding/wizard/
// wizardSteps.ts), so every completion now arrives with the same payload:
// blueprint "" plus an EXPLICITLY empty bots list. The founder's flow
// depends on what that pair seeds — the user is deposited straight into
// #general to talk to the CEO, and the CEO conversation is what decides the
// goal, the first task, and which bots to hire.
//
// The two neighbouring tests each cover half of this pair and neither pins it:
// TestOnboardingCompleteBotsEmptySeedsLeadOnly passes a real blueprint id,
// and TestOnboardingCompleteFromScratchSynthesizes passes nil bots. An
// earlier revision of this package treated exactly this combination as
// "no-team mode" and seeded an office with zero bots, which would leave the
// wizard's only remaining path landing on an empty office with nobody to talk
// to. This test pins the combination itself so that regression cannot return
// unnoticed.
func TestOnboardingCompleteNoPackSeedsCEOAndGeneralChannel(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)

	const task = "Audit our CRM for duplicate accounts and propose a cleanup plan"
	if err := b.onboardingCompleteFn(task, false, "", []string{}, "Dunder HQ"); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	var ceo *officeMember
	for i := range b.members {
		if b.members[i].Slug == "ceo" {
			ceo = &b.members[i]
			break
		}
	}
	if ceo == nil {
		slugs := make([]string, 0, len(b.members))
		for i := range b.members {
			slugs = append(slugs, b.members[i].Slug)
		}
		t.Fatalf("no-pack onboarding seeded no CEO; roster was %v", slugs)
	}

	var general *teamChannel
	for i := range b.channels {
		if b.channels[i].Slug == "general" {
			general = &b.channels[i]
			break
		}
	}
	if !generalChannelEnabled() {
		// #general is retired. The property this test exists for -- "after
		// onboarding the human has somewhere to talk to the lead" -- is now
		// satisfied by the lead's DM, so assert THAT rather than the lobby.
		if general != nil {
			t.Fatalf("#general is retired but onboarding seeded it")
		}
		if b.findChannelLocked(channel.DirectSlug("human", "ceo")) == nil {
			slugs := make([]string, 0, len(b.channels))
			for i := range b.channels {
				slugs = append(slugs, b.channels[i].Slug)
			}
			t.Fatalf("no way to reach the lead after onboarding; channels were %v", slugs)
		}
		return
	}
	if general == nil {
		slugs := make([]string, 0, len(b.channels))
		for i := range b.channels {
			slugs = append(slugs, b.channels[i].Slug)
		}
		t.Fatalf("no-pack onboarding seeded no #general channel; channels were %v", slugs)
	}

	inGeneral := false
	for _, member := range general.Members {
		if member == "ceo" {
			inGeneral = true
			break
		}
	}
	if !inGeneral {
		t.Errorf("CEO is not a member of #general; members were %v", general.Members)
	}

	// The first issue must land in #general tagged to the CEO, so the office
	// opens on a conversation rather than an empty channel.
	tagged := false
	for _, msg := range b.messages {
		if msg.Channel != "general" || msg.Kind != "onboarding_origin" {
			continue
		}
		if msg.Content != task {
			continue
		}
		for _, slug := range msg.Tagged {
			if slug == "ceo" {
				tagged = true
			}
		}
	}
	if !tagged {
		seen := make([]string, 0, len(b.messages))
		for _, msg := range b.messages {
			seen = append(seen, fmt.Sprintf("%s/%s tagged=%v %q", msg.Channel, msg.Kind, msg.Tagged, msg.Content))
		}
		t.Errorf("expected the first issue posted to #general tagged to the CEO, found none; messages were %v", seen)
	}
}

// officeLeadSlugFromMembers used to scan for the first BuiltIn member in
// slug order. The Librarian and the App Builder are BuiltIn service bots in
// every office and "app-builder" sorts ahead of "ceo", so the App Builder won
// every roster — the onboarding kickoff was tagged to it, and the starter
// channels listed it as their lead. Pin the CEO preference that its sibling
// officeLeadSlugFrom (office_targets.go) has always had.
func TestOfficeLeadSlugFromMembersPrefersCEOOverServiceBuiltIns(t *testing.T) {
	now := "2026-08-22T00:00:00Z"
	leadOnly := []officeMember{
		{Slug: "ceo", Name: "CEO", Role: "lead", BuiltIn: true, CreatedAt: now},
		{Slug: LibrarianSlug, Name: "Librarian", BuiltIn: true, CreatedAt: now},
		{Slug: appBuilderSlug, Name: "App Builder", BuiltIn: true, CreatedAt: now},
	}
	if got := officeLeadSlugFromMembers(leadOnly); got != "ceo" {
		t.Errorf("lead-only roster: got lead %q, want ceo", got)
	}

	// Order-independence: the answer must not depend on the caller's snapshot.
	reversed := []officeMember{leadOnly[2], leadOnly[1], leadOnly[0]}
	if got := officeLeadSlugFromMembers(reversed); got != "ceo" {
		t.Errorf("reversed roster: got lead %q, want ceo", got)
	}

	// A full roster reaches the same answer.
	full := append(append([]officeMember(nil), leadOnly...),
		officeMember{Slug: "designer", Name: "Designer", CreatedAt: now},
		officeMember{Slug: "gtm-lead", Name: "GTM Lead", CreatedAt: now},
	)
	if got := officeLeadSlugFromMembers(full); got != "ceo" {
		t.Errorf("full roster: got lead %q, want ceo", got)
	}

	// With no CEO the BuiltIn fallback still answers, as it always did.
	noCEO := []officeMember{
		{Slug: "gtm-lead", Name: "GTM Lead", CreatedAt: now},
		{Slug: "operator", Name: "Operator", BuiltIn: true, CreatedAt: now},
	}
	if got := officeLeadSlugFromMembers(noCEO); got != "operator" {
		t.Errorf("roster without a CEO: got lead %q, want operator", got)
	}

	if got := officeLeadSlugFromMembers(nil); got != "" {
		t.Errorf("empty roster: got lead %q, want the empty string", got)
	}
}
