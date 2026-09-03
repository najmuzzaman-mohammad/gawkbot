package team

import (
	"fmt"
	"testing"
)

// Tool names are derived from the server key, and those fully-qualified strings
// live in users' permission allowlists, saved skills, and transcripts we cannot
// reach. A rename silently revokes every grant written against the old name,
// with no error naming the cause. So the old key is an ALIAS, forever.

func TestServerKeysIncludeEveryLegacyKey(t *testing.T) {
	keys := ServerKeys()
	if len(keys) == 0 || keys[0] != ServerKey {
		t.Fatalf("the canonical key must come first, got %v", keys)
	}

	have := map[string]bool{}
	for _, k := range keys {
		have[k] = true
	}
	for _, legacy := range LegacyServerKeys {
		if !have[legacy] {
			t.Errorf("legacy key %q must stay registered: a permission granted against it would silently stop matching", legacy)
		}
	}
}

func TestServerKeysAreUniqueAndNonEmpty(t *testing.T) {
	seen := map[string]bool{}
	for _, k := range ServerKeys() {
		if k == "" {
			t.Error("an empty server key would namespace tools as mcp____<tool>")
		}
		if seen[k] {
			t.Errorf("duplicate server key %q: the entry would be registered twice", k)
		}
		seen[k] = true
	}
}

// A name written down before a rename must still be recognised afterwards.
// This is the assertion that fails the moment someone "cleans up" the alias.
func TestAcceptsQualifiedToolNameUnderEveryKey(t *testing.T) {
	for _, key := range ServerKeys() {
		qualified := "mcp__" + key + "__team_task"
		if !AcceptsQualifiedToolName(qualified) {
			t.Errorf("%q must still be recognised; a stale allowlist entry cannot be rewritten remotely", qualified)
		}
	}
}

func TestAcceptsQualifiedToolNameRejectsOtherServers(t *testing.T) {
	for _, other := range []string{
		"mcp__some-other-server__team_task",
		"team_task",
		"",
		"mcp__" + ServerKey + "__", // prefix with no tool is not a tool
	} {
		if AcceptsQualifiedToolName(other) {
			t.Errorf("%q must not be treated as one of ours", other)
		}
	}
}

func TestQualifiedToolNameUsesTheCanonicalKey(t *testing.T) {
	got := QualifiedToolName("team_task")
	want := "mcp__" + ServerKey + "__team_task"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if !AcceptsQualifiedToolName(got) {
		t.Fatal("a name we generate must be a name we accept")
	}
}

// The canonical key must never also appear in the legacy list: ServerKeys()
// de-duplicates, but the overlap would mean someone had "renamed" to the name
// they already had and believed the alias was doing something.
func TestCanonicalKeyIsNotAlsoListedAsLegacy(t *testing.T) {
	for _, legacy := range LegacyServerKeys {
		if legacy == ServerKey {
			t.Fatalf("%q is both the canonical and a legacy key", legacy)
		}
	}
}

// ── the WIRING, not just the helper ─────────────────────────────────────────
//
// ServerKeys() being correct is worth nothing if the config builders ignore it.
// LegacyServerKeys is empty today, so a test that merely calls the builders
// would pass whether or not they consult it — the alias path is unreachable
// until a rename happens, which is exactly when nobody is watching.
//
// These tests therefore INJECT a legacy key and assert the builders honour it.
// That is the mutation the guard exists for: it fails if someone rewrites
// buildMCPServerMap or the opencode wiring back to a bare "wuphf-office"
// literal, which is the change a future rename would otherwise ship silently.
//
// Why it matters more than its size: those tool-name strings live in USERS'
// permission allowlists and saved skills, on their disks, which we cannot
// reach. A rename without the alias revokes granted permissions with no error
// naming the cause.

// withLegacyKeyForTest appends a legacy key for the duration of one test.
func withLegacyKeyForTest(t *testing.T, key string) {
	t.Helper()
	previous := LegacyServerKeys
	LegacyServerKeys = append(append([]string(nil), LegacyServerKeys...), key)
	t.Cleanup(func() { LegacyServerKeys = previous })
}

func TestBuildMCPServerMapRegistersEveryLegacyKey(t *testing.T) {
	const legacy = "wuphf-office-legacy-probe"
	withLegacyKeyForTest(t, legacy)

	l := &Launcher{}
	servers, err := l.buildMCPServerMap()
	if err != nil {
		t.Fatalf("buildMCPServerMap: %v", err)
	}
	canonical, ok := servers[ServerKey]
	if !ok {
		t.Fatalf("canonical key %q missing entirely", ServerKey)
	}
	alias, ok := servers[legacy]
	if !ok {
		t.Fatalf("legacy key %q was not registered — a permission granted under it "+
			"would silently stop matching after a rename", legacy)
	}
	// The SAME entry, not a second server: two divergent entries would mean the
	// alias drifts from the canonical one the moment either is edited.
	if fmt.Sprintf("%p", canonical) != fmt.Sprintf("%p", alias) {
		t.Error("the legacy key points at a different entry than the canonical key")
	}
}

func TestBotMCPServersReturnsEveryLegacyKey(t *testing.T) {
	const legacy = "wuphf-office-legacy-probe"
	withLegacyKeyForTest(t, legacy)

	// Both branches: the DM/coding-bot minimal set and the full set.
	t.Setenv("WUPHF_CHANNEL", DMSlugFor("ceo"))
	dm := botMCPServers("pm")
	if !containsString(dm, ServerKey) || !containsString(dm, legacy) {
		t.Errorf("DM branch returned %v, want both %q and %q", dm, ServerKey, legacy)
	}

	t.Setenv("WUPHF_CHANNEL", "product")
	full := botMCPServers("pm")
	if !containsString(full, ServerKey) || !containsString(full, legacy) {
		t.Errorf("full branch returned %v, want both %q and %q", full, ServerKey, legacy)
	}
	// There is no separate knowledge-graph MCP server any more; the office
	// server owns memory access, so both branches return the same key set.
	if len(full) != len(dm) {
		t.Errorf("full branch should match the DM key set, got %v vs %v", full, dm)
	}
}
