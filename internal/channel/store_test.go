// internal/channel/store_test.go
package channel

import (
	"testing"
)

func TestStoreCreateAndGet(t *testing.T) {
	s := NewStore()
	ch, err := s.Create(Channel{Name: "general", Slug: "general", Type: ChannelTypePublic})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ch.ID == "" {
		t.Error("expected UUID to be generated")
	}
	got, ok := s.Get(ch.ID)
	if !ok || got.Slug != "general" {
		t.Error("Get by ID failed")
	}
	got2, ok := s.GetBySlug("general")
	if !ok || got2.ID != ch.ID {
		t.Error("GetBySlug failed")
	}
}

func TestStoreCreateRejectsDuplicateSlug(t *testing.T) {
	s := NewStore()
	s.Create(Channel{Slug: "general", Type: ChannelTypePublic})
	_, err := s.Create(Channel{Slug: "general", Type: ChannelTypePublic})
	if err == nil {
		t.Error("expected error on duplicate slug")
	}
}

func TestStoreDelete(t *testing.T) {
	s := NewStore()
	ch, _ := s.Create(Channel{Slug: "temp", Type: ChannelTypePublic})
	if err := s.Delete(ch.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	_, ok := s.Get(ch.ID)
	if ok {
		t.Error("channel should be gone after delete")
	}
}

func TestStoreListFilterByType(t *testing.T) {
	s := NewStore()
	s.Create(Channel{Slug: "general", Type: ChannelTypePublic})
	s.Create(Channel{Slug: "human__eng", Type: ChannelTypeDirect})
	pubs := s.List(ChannelFilter{Type: ChannelTypePublic})
	if len(pubs) != 1 || pubs[0].Slug != "general" {
		t.Errorf("expected 1 public channel, got %d", len(pubs))
	}
	dms := s.List(ChannelFilter{Type: ChannelTypeDirect})
	if len(dms) != 1 {
		t.Errorf("expected 1 direct channel, got %d", len(dms))
	}
}

func TestStoreGetOrCreateDirect(t *testing.T) {
	s := NewStore()
	ch1, err := s.GetOrCreateDirect("human", "engineering")
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if ch1.Type != ChannelTypeDirect {
		t.Errorf("expected type D, got %s", ch1.Type)
	}
	if ch1.Slug != DirectSlug("human", "engineering") {
		t.Errorf("expected deterministic slug, got %s", ch1.Slug)
	}
	// Idempotent: second call returns same channel
	ch2, _ := s.GetOrCreateDirect("engineering", "human")
	if ch2.ID != ch1.ID {
		t.Error("GetOrCreateDirect should be idempotent")
	}
}

func TestStoreGetOrCreateDirectAddsMembersWithAllNotify(t *testing.T) {
	s := NewStore()
	ch, _ := s.GetOrCreateDirect("human", "engineering")
	members := s.Members(ch.ID)
	if len(members) != 2 {
		t.Fatalf("expected 2 members, got %d", len(members))
	}
	for _, m := range members {
		if m.NotifyLevel != "all" {
			t.Errorf("DM members should default to notify=all, got %s for %s", m.NotifyLevel, m.Slug)
		}
	}
}

func TestGetOrCreateDirectRejectsSelfDM(t *testing.T) {
	s := NewStore()
	_, err := s.GetOrCreateDirect("human", "human")
	if err == nil {
		t.Error("expected error for self-DM (a == b)")
	}
	_, err = s.GetOrCreateDirect("", "engineering")
	if err == nil {
		t.Error("expected error for empty member slug")
	}
	_, err = s.GetOrCreateDirect("human", "")
	if err == nil {
		t.Error("expected error for empty member slug")
	}
}

// Group DMs are retired: a group DM is a channel wearing a different label,
// and every conversation is now 1:1 with a single bot. The store REFUSING is
// the contract, so this asserts the refusal rather than the old happy path.
func TestStoreGetOrCreateGroupIsRefusedWhileRetired(t *testing.T) {
	if GroupDMsEnabled() {
		t.Skip("group DMs are still enabled; the refusal is what this pins")
	}
	s := NewStore()
	if _, err := s.GetOrCreateGroup([]string{"human", "engineering", "design"}, "human"); err == nil {
		t.Fatal("expected group DM creation to be refused while groupDMsEnabled is false")
	}
}

func TestStoreGetOrCreateGroup(t *testing.T) {
	restore := SetGroupDMsEnabledForTest(true)
	defer restore()
	s := NewStore()
	ch, err := s.GetOrCreateGroup([]string{"human", "engineering", "design"}, "human")
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	if ch.Type != ChannelTypeGroup {
		t.Errorf("expected type G, got %s", ch.Type)
	}
	members := s.Members(ch.ID)
	if len(members) != 3 {
		t.Errorf("expected 3 members, got %d", len(members))
	}
}
