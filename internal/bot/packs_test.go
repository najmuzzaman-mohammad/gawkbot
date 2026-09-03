package bot

import "testing"

func TestPacksRegistered(t *testing.T) {
	packs := ListLegacyPacks()
	if len(packs) != 5 {
		t.Fatalf("expected 5 packs, got %d", len(packs))
	}
	founding := LookupLegacyPack("founding-team")
	if founding == nil {
		t.Fatal("founding-team pack not found")
	}
	if founding.LeadSlug != "ceo" {
		t.Errorf("expected lead slug 'ceo', got '%s'", founding.LeadSlug)
	}
	if len(founding.Bots) != 8 {
		t.Errorf("expected 8 bots in founding team, got %d", len(founding.Bots))
	}
	foundAI := false
	for _, a := range founding.Bots {
		if a.Slug == "ai" && a.Name == "AI Engineer" {
			foundAI = true
			break
		}
	}
	if !foundAI {
		t.Error("expected founding team to include AI Engineer")
	}
}

func TestGetPackReturnsNilForUnknown(t *testing.T) {
	if LookupLegacyPack("nonexistent") != nil {
		t.Error("expected nil for unknown pack")
	}
}

func TestAllPacksHaveLeadInBots(t *testing.T) {
	for _, pack := range ListLegacyPacks() {
		found := false
		for _, a := range pack.Bots {
			if a.Slug == pack.LeadSlug {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("pack %s: lead slug %s not found in bots", pack.Slug, pack.LeadSlug)
		}
	}
}

func TestCodingTeamPack(t *testing.T) {
	p := LookupLegacyPack("coding-team")
	if p == nil {
		t.Fatal("coding-team pack not found")
	}
	if p.LeadSlug != "ceo" {
		t.Errorf("expected lead 'ceo', got '%s'", p.LeadSlug)
	}
	if len(p.Bots) != 4 {
		t.Errorf("expected 4 bots, got %d", len(p.Bots))
	}
}

func TestLeadGenAgencyPack(t *testing.T) {
	p := LookupLegacyPack("lead-gen-agency")
	if p == nil {
		t.Fatal("lead-gen-agency pack not found")
	}
	if p.LeadSlug != "ceo" {
		t.Errorf("expected lead 'ceo', got '%s'", p.LeadSlug)
	}
	if len(p.Bots) != 4 {
		t.Errorf("expected 4 bots, got %d", len(p.Bots))
	}
}

func TestRevOpsPack(t *testing.T) {
	p := LookupLegacyPack("revops")
	if p == nil {
		t.Fatal("revops pack not found")
	}
	if p.LeadSlug != "ceo" {
		t.Errorf("expected lead 'ceo', got '%s'", p.LeadSlug)
	}
	if len(p.Bots) != 5 {
		t.Errorf("expected 5 bots, got %d", len(p.Bots))
	}
	// CEO (Chief Revenue Officer) must be present so the broker's CEO-routed
	// delegation and hardcoded "ceo" checks keep working.
	hasCEO := false
	for _, a := range p.Bots {
		if a.Slug == "ceo" {
			hasCEO = true
			break
		}
	}
	if !hasCEO {
		t.Error("revops pack missing required 'ceo' bot")
	}
}
