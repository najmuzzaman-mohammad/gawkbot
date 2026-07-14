package team

// Tests for the Apps prompt blocks. The App Builder block carries the
// generated OpenUI component/tool contract and the validate-before-publish
// workflow. The non-builder awareness block must not carry builder-only tools.

import (
	"strings"
	"testing"
)

// containsFold reports whether s contains substr, case-insensitively.
func containsFold(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(substr))
}

func TestAppBuilderPromptBlock_HasOpenUIValidationGuidance(t *testing.T) {
	block := appBuilderPromptBlock()

	for _, phrase := range []string{
		"OpenUI Lang", "root = App", "validate_app", "register_app",
		"openui_lang", "expected_version", "wuphf_list_tasks", "wuphf_create_task",
	} {
		if !containsFold(block, phrase) {
			t.Errorf("appBuilderPromptBlock missing OpenUI phrase %q", phrase)
		}
	}
	for _, forbidden := range []string{"bun run verify", "tsc --noEmit", "vite build"} {
		if containsFold(block, forbidden) {
			t.Errorf("appBuilderPromptBlock still contains legacy frontend phrase %q", forbidden)
		}
	}
}

func TestAppsAwarenessPromptBlock_OmitsVerifyGate(t *testing.T) {
	block := appsAwarenessPromptBlock()

	// The gate is App-Builder-only. The awareness block (every other agent)
	// must not carry build/type-check gate language.
	for _, phrase := range []string{"bun run verify", "tsc --noEmit", "register_app"} {
		if containsFold(block, phrase) {
			t.Errorf("appsAwarenessPromptBlock should not contain builder-only phrase %q", phrase)
		}
	}
}
