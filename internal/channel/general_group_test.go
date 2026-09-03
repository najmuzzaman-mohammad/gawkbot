package channel

import (
	"errors"
	"testing"
)

// Group DMs are being retired with #general: a group DM is a channel by
// another name, so it reproduces the several-bots-in-one-room shape the
// switch exists to stop.
//
// The two halves of this test are the whole contract. Creation must REFUSE,
// and it must refuse with an error rather than a nil channel — a silent nil
// reads as "nothing to do" and lets a caller carry on as though the surface
// existed. Reading must still WORK, because the rule is create/route/list
// gating and never delete: a group row already on disk has to stay reachable
// so a revive finds it intact.
func TestGetOrCreateGroupRespectsKillSwitch(t *testing.T) {
	members := []string{"human", "engineering", "design"}

	t.Run("switch on: creates, as today", func(t *testing.T) {
		defer SetGroupDMsEnabledForTest(true)()
		s := NewStore()
		ch, err := s.GetOrCreateGroup(members, "human")
		if err != nil {
			t.Fatalf("switch on: creation failed, so this test cannot prove the gate: %v", err)
		}
		if ch == nil || ch.Type != ChannelTypeGroup {
			t.Fatalf("expected a group channel, got %+v", ch)
		}
	})

	t.Run("switch off: refuses with an error, never a silent nil", func(t *testing.T) {
		defer SetGroupDMsEnabledForTest(false)()
		s := NewStore()
		ch, err := s.GetOrCreateGroup(members, "human")
		if err == nil {
			t.Fatal("switch off: GetOrCreateGroup created a group DM")
		}
		if !errors.Is(err, ErrGroupDMsDisabled) {
			t.Errorf("expected ErrGroupDMsDisabled, got %v", err)
		}
		if ch != nil {
			t.Errorf("expected a nil channel alongside the error, got %+v", ch)
		}
		// Nothing may be left behind by the refusal.
		if _, ok := s.GetBySlug(GroupSlug(members)); ok {
			t.Error("a refused group DM was still written to the store")
		}
	})

	t.Run("switch off: an existing group row still loads and reads", func(t *testing.T) {
		// Stand up the group while the switch is on, the way a workspace that
		// predates the retirement would have.
		restoreOn := SetGroupDMsEnabledForTest(true)
		s := NewStore()
		created, err := s.GetOrCreateGroup(members, "human")
		if err != nil {
			t.Fatalf("seed group: %v", err)
		}
		id, slug := created.ID, created.Slug
		restoreOn()

		defer SetGroupDMsEnabledForTest(false)()

		// Reachable by slug and by id.
		got, ok := s.GetBySlug(slug)
		if !ok {
			t.Fatal("an existing group row became unreachable by slug; the switch must never delete")
		}
		if got.Type != ChannelTypeGroup {
			t.Errorf("existing row lost its type: got %q", got.Type)
		}
		if _, ok := s.Get(id); !ok {
			t.Error("an existing group row became unreachable by id")
		}
		// Membership still reads.
		if n := len(s.Members(id)); n != len(members) {
			t.Errorf("existing group lost members: got %d, want %d", n, len(members))
		}
		// And the get-half of GetOrCreateGroup still returns it rather than
		// refusing — reopening a conversation that already exists must work.
		reopened, err := s.GetOrCreateGroup(members, "human")
		if err != nil {
			t.Fatalf("reopening an existing group was refused: %v", err)
		}
		if reopened == nil || reopened.ID != id {
			t.Errorf("reopening returned a different channel: %+v", reopened)
		}
	})
}
