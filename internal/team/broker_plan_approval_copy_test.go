package team

import (
	"strings"
	"testing"
)

// TestHumanReadablePlanSummary pins the approval card's contract with the
// person reading it: keep the substance, drop what only the bot needs, and
// never publish where files live on the operator's machine.
func TestHumanReadablePlanSummary(t *testing.T) {
	raw := "DUNDE-72 Smoke Check Plan\n\n1. Baseline — snapshot before anything is created\n2. Canary — create a minimal test task\n\nThe plan file is at `/Users/najmuzzaman/.claude/plans/runtime-this-office.md`. Approve to run."
	got := humanReadablePlanSummary(raw)

	if strings.Contains(got, "/Users/") {
		t.Errorf("summary must not leak a local path: %q", got)
	}
	if !strings.Contains(got, "the plan file") {
		t.Errorf("the path should be replaced with a neutral phrase, got %q", got)
	}
	if !strings.Contains(got, "Baseline") {
		t.Errorf("substance must survive, got %q", got)
	}
	if strings.Contains(got, "\n") {
		t.Errorf("summary should be collapsed to one skimmable block, got %q", got)
	}
	if len([]rune(got)) > 520 {
		t.Errorf("summary should stay short, got %d runes", len([]rune(got)))
	}
	if humanReadablePlanSummary("   ") != "" {
		t.Error("an empty plan must yield an empty summary, not filler")
	}
}

// TestOwnerLabelForPlan pins who the card says is asking.
func TestOwnerLabelForPlan(t *testing.T) {
	for in, want := range map[string]string{"": "The team", "office": "The team", "ceo": "@ceo", " pm ": "@pm"} {
		if got := ownerLabelForPlan(in); got != want {
			t.Errorf("ownerLabelForPlan(%q) = %q, want %q", in, got, want)
		}
	}
}
