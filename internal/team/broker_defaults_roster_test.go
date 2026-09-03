package team

import (
	"testing"

	"github.com/nex-crm/wuphf/internal/onboarding"
)

// The wizard's contract since the packs/CEO removal: blueprint "" plus an
// explicit empty bots list seeds an office with NO bots. No synthesis, no
// DefaultManifest fallback, no lead to tag. These tests pin that contract; the
// legacy nil-bots synthesis path keeps its own coverage in
// broker_onboarding_wiki_test.go.

func TestEnsureDefaultOfficeMembersSkipsOnboardedEmptyOffice(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WUPHF_RUNTIME_HOME", tmpHome)

	if err := onboarding.Save(&onboarding.State{
		CompletedAt: "2026-07-01T00:00:00Z",
		Version:     2,
		Phase:       "complete",
	}); err != nil {
		t.Fatalf("save onboarding state: %v", err)
	}

	b := newTestBroker(t)
	b.mu.Lock()
	b.members = nil
	b.ensureDefaultOfficeMembersLocked()
	got := len(b.members)
	b.mu.Unlock()

	if got != 0 {
		t.Fatalf("expected the onboarded empty office to stay empty, got %d default members", got)
	}
}

// The load-time normalization must not resurrect built-ins either: the Pam /
// App Builder back-fill and the ceo channel pin only apply to rosters that
// have bots. An intentionally empty office survives a broker restart empty.
func TestNormalizeLoadedStateKeepsEmptyOfficeEmpty(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WUPHF_RUNTIME_HOME", tmpHome)

	if err := onboarding.Save(&onboarding.State{
		CompletedAt: "2026-07-01T00:00:00Z",
		Version:     2,
		Phase:       "complete",
	}); err != nil {
		t.Fatalf("save onboarding state: %v", err)
	}

	b := newTestBroker(t)
	b.mu.Lock()
	b.members = nil
	b.channels = []teamChannel{{
		Slug:        "team",
		Name:        "team",
		Description: "Primary coordination channel.",
		Members:     []string{},
	}}
	b.ensureDefaultOfficeMembersLocked()
	b.normalizeLoadedStateLocked()
	members := len(b.members)
	var generalMembers []string
	for _, ch := range b.channels {
		if ch.Slug == "team" {
			generalMembers = ch.Members
		}
	}
	b.mu.Unlock()

	if members != 0 {
		t.Fatalf("expected the empty office to stay empty across normalization, got %d members", members)
	}
	for _, slug := range generalMembers {
		if slug == "ceo" {
			t.Fatal("expected no ceo ghost pinned into #team membership")
		}
	}
}

// Before onboarding completes, zero members still means corrupted/never-seeded
// state and the recovery roster must keep firing.
func TestEnsureDefaultOfficeMembersStillRecoversPreOnboarding(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WUPHF_RUNTIME_HOME", tmpHome)

	b := newTestBroker(t)
	b.mu.Lock()
	b.members = nil
	b.ensureDefaultOfficeMembersLocked()
	got := len(b.members)
	b.mu.Unlock()

	if got == 0 {
		t.Fatal("expected the recovery roster for a never-onboarded zero-member office")
	}
}
