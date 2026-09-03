package operations

import (
	"testing"
)

func TestSynthesizeBlueprintDerivesGenericPlanFromDirectiveProfileAndCapabilities(t *testing.T) {
	blueprint := SynthesizeBlueprint(SynthesisInput{
		Directive: "Build a GTM engine for enterprise sales using email and Slack.",
		Profile: CompanyProfile{
			Name:        "Acme Labs",
			Industry:    "B2B SaaS",
			Description: "A company that needs repeatable growth operations.",
			Audience:    "enterprise buyers",
			Offer:       "pipeline generation",
		},
		Integrations: []RuntimeIntegration{
			{Name: "Gmail", Provider: "gmail", Connected: true, Purpose: "Outbound communication"},
			{Name: "Slack", Provider: "slack", Connected: false},
			{Name: "Google Drive", Provider: "google-drive", Connected: true},
		},
		Capabilities: []RuntimeCapability{
			{Key: "tmux", Name: "tmux", Category: "runtime", Lifecycle: "ready", Detail: "tmux is installed."},
			{Key: "codex", Name: "Codex", Category: "runtime", Lifecycle: "ready", Detail: "Codex is available."},
		},
	})

	if got, want := blueprint.ID, "acme-labs"; got != want {
		t.Fatalf("unexpected blueprint id: got %q want %q", got, want)
	}
	if got, want := blueprint.Kind, "gtm"; got != want {
		t.Fatalf("unexpected kind: got %q want %q", got, want)
	}
	if got := blueprint.Name; got == "" || got == "Operations Blueprint" {
		t.Fatalf("expected profile-derived name, got %q", got)
	}
	if got := blueprint.Objective; got == "" {
		t.Fatalf("expected objective to be populated")
	}
	if blueprint.Starter.LeadSlug != "operator" {
		t.Fatalf("unexpected lead slug: %+v", blueprint.Starter)
	}
	// The lead plus one owner per connected integration. It used to be "at
	// least 5" because planner/executor/reviewer were seeded on every
	// blueprint; that trio is retired, so the only bots left are the lead
	// and the ones the integrations actually justify.
	if len(blueprint.Starter.Bots) < 2 {
		t.Fatalf("expected the lead plus integration owners, got %+v", blueprint.Starter.Bots)
	}
	for _, bot := range blueprint.Starter.Bots {
		switch bot.Slug {
		case "planner", "executor", "reviewer":
			t.Fatalf("blueprint resurrected the retired built-in %q: %+v", bot.Slug, blueprint.Starter.Bots)
		}
	}
	// No channels: every room type is retired, so a blueprint declares none.
	if len(blueprint.Starter.Channels) != 0 {
		t.Fatalf("expected no channels while rooms are retired, got %+v", blueprint.Starter.Channels)
	}
	if len(blueprint.Starter.Tasks) < 2 {
		t.Fatalf("expected baseline starter tasks, got %+v", blueprint.Starter.Tasks)
	}
	// Homeless on purpose: the broker routes a task with no channel to its
	// owner's DM, which is the only conversation that exists now.
	for _, task := range blueprint.Starter.Tasks {
		if task.Channel != "" {
			t.Fatalf("starter task %q names a channel %q; blueprints no longer have rooms", task.Title, task.Channel)
		}
	}
	if blueprint.BootstrapConfig.ChannelSlug != "acme-labs" {
		t.Fatalf("unexpected channel slug: %+v", blueprint.BootstrapConfig)
	}
	if len(blueprint.Stages) != 5 {
		t.Fatalf("expected 5 generic stages, got %+v", blueprint.Stages)
	}
	if len(blueprint.Artifacts) < 4 {
		t.Fatalf("expected generic artifacts, got %+v", blueprint.Artifacts)
	}
	if len(blueprint.Capabilities) < 7 {
		t.Fatalf("expected runtime + integration capabilities, got %+v", blueprint.Capabilities)
	}
	if len(blueprint.Connections) != 3 {
		t.Fatalf("expected one connection per integration, got %+v", blueprint.Connections)
	}
	if len(blueprint.Workflows) != 4 {
		t.Fatalf("expected one intake workflow plus one per integration, got %+v", blueprint.Workflows)
	}
	if len(blueprint.ApprovalRules) < 2 {
		t.Fatalf("expected live action plus outbound approval rules, got %+v", blueprint.ApprovalRules)
	}
	if got := blueprint.QueueSeed; len(got) != 4 {
		t.Fatalf("expected base queue plus integration setup item, got %+v", got)
	}
	if got := blueprint.MonetizationLadder; len(got) != 4 {
		t.Fatalf("expected gtm ladder, got %+v", got)
	}
}

func TestSynthesizeBlueprintFallsBackToBlankOperationsShape(t *testing.T) {
	blueprint := SynthesizeBlueprint(SynthesisInput{})

	if blueprint.ID != "operations-blueprint" {
		t.Fatalf("unexpected fallback id: %+v", blueprint.ID)
	}
	if blueprint.Name != "Operations Blueprint" {
		t.Fatalf("unexpected fallback name: %+v", blueprint.Name)
	}
	if blueprint.Kind != "general" {
		t.Fatalf("unexpected fallback kind: %+v", blueprint.Kind)
	}
	if blueprint.Objective == "" {
		t.Fatal("expected fallback objective")
	}
	if blueprint.Starter.LeadSlug != "operator" {
		t.Fatalf("unexpected fallback lead slug: %+v", blueprint.Starter)
	}
	// None, not three. #general went first, then the named working lanes
	// (planning, execution, review) followed it into retirement, so the
	// fallback blueprint declares no rooms at all.
	if len(blueprint.Starter.Channels) != 0 {
		t.Fatalf("expected no channels in fallback blueprint while rooms are retired, got %+v", blueprint.Starter.Channels)
	}
	if len(blueprint.Stages) != 5 {
		t.Fatalf("expected 5 generic stages in fallback blueprint, got %+v", blueprint.Stages)
	}
	if len(blueprint.ApprovalRules) != 1 {
		t.Fatalf("expected only the generic live-side-effects approval in fallback blueprint, got %+v", blueprint.ApprovalRules)
	}
}
