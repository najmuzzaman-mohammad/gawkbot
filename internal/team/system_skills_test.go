package team

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func newSystemSkillsTestBroker(t *testing.T) *Broker {
	t.Helper()
	b := newTestBroker(t)
	b.mu.Lock()
	b.members = append(b.members,
		officeMember{Slug: "ceo", Name: "Chief of Staff", Role: "lead", BuiltIn: true},
		officeMember{Slug: "writer", Name: "Writer", Role: "specialist"},
	)
	b.rebuildMemberIndexLocked()
	b.ensureSystemSkillsLocked()
	b.mu.Unlock()
	return b
}

func findSystemSkill(t *testing.T, b *Broker, name string) teamSkill {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, sk := range b.skills {
		if skillSlug(sk.Name) == name {
			return sk
		}
	}
	t.Fatalf("system skill %q missing", name)
	return teamSkill{}
}

func TestEnsureSystemSkillsSeedsAndResurrects(t *testing.T) {
	b := newSystemSkillsTestBroker(t)

	for _, name := range []string{systemSkillAppBuilding, systemSkillWikiMaintenance} {
		sk := findSystemSkill(t, b, name)
		if !sk.System {
			t.Errorf("%s: System flag not set", name)
		}
		if sk.Status != "active" {
			t.Errorf("%s: status = %q, want active", name, sk.Status)
		}
	}

	// Idempotent: a second ensure adds nothing.
	b.mu.Lock()
	before := len(b.skills)
	b.ensureSystemSkillsLocked()
	after := len(b.skills)
	b.mu.Unlock()
	if before != after {
		t.Fatalf("ensure not idempotent: %d -> %d skills", before, after)
	}

	// An archived copy on disk resurrects on the next load pass, because a
	// system skill cannot be removed.
	b.mu.Lock()
	for i := range b.skills {
		if skillSlug(b.skills[i].Name) == systemSkillAppBuilding {
			b.skills[i].Status = "archived"
		}
	}
	b.ensureSystemSkillsLocked()
	b.mu.Unlock()
	if sk := findSystemSkill(t, b, systemSkillAppBuilding); sk.Status != "active" {
		t.Fatalf("archived system skill did not resurrect: status = %q", sk.Status)
	}
}

func TestSystemSkillMutationVerbsRefuse(t *testing.T) {
	b := newSystemSkillsTestBroker(t)

	// DELETE /skills
	req := httptest.NewRequest("DELETE", "/skills", strings.NewReader(`{"name":"app-building"}`))
	rec := httptest.NewRecorder()
	b.handleDeleteSkill(rec, req)
	if rec.Code != 403 {
		t.Errorf("delete: code = %d, want 403", rec.Code)
	}

	// POST /skills/{name}/archive
	req = httptest.NewRequest("POST", "/skills/app-building/archive", nil)
	rec = httptest.NewRecorder()
	b.handleSkillArchive(rec, req, "app-building")
	if rec.Code != 403 {
		t.Errorf("archive: code = %d, want 403", rec.Code)
	}

	// POST /skills/{name}/disable (whole-skill)
	req = httptest.NewRequest("POST", "/skills/wiki-maintenance/disable", nil)
	rec = httptest.NewRecorder()
	b.handleSkillDisable(rec, req, "wiki-maintenance")
	if rec.Code != 403 {
		t.Errorf("disable: code = %d, want 403", rec.Code)
	}

	// POST /skills/{name}/reject removes the record entirely — must refuse.
	req = httptest.NewRequest("POST", "/skills/app-building/reject", nil)
	rec = httptest.NewRecorder()
	b.handleSkillReject(rec, req, "app-building")
	if rec.Code != 403 {
		t.Errorf("reject: code = %d, want 403", rec.Code)
	}

	// Nothing above may have removed or deactivated the skills.
	for _, name := range []string{systemSkillAppBuilding, systemSkillWikiMaintenance} {
		if sk := findSystemSkill(t, b, name); sk.Status != "active" {
			t.Errorf("%s: status = %q after refused mutations, want active", name, sk.Status)
		}
	}
}

func TestSystemSkillPerBotToggle(t *testing.T) {
	b := newSystemSkillsTestBroker(t)

	// disable-for records the switch-off without touching OwnerBots.
	req := httptest.NewRequest("POST", "/skills/app-building/disable-for", strings.NewReader(`{"agent":"writer"}`))
	rec := httptest.NewRecorder()
	b.handleSkillDisableForBot(rec, req, "app-building")
	if rec.Code != 200 {
		t.Fatalf("disable-for: code = %d, body %s", rec.Code, rec.Body.String())
	}
	sk := findSystemSkill(t, b, systemSkillAppBuilding)
	if len(sk.DisabledBots) != 1 || sk.DisabledBots[0] != "writer" {
		t.Fatalf("DisabledBots = %v, want [writer]", sk.DisabledBots)
	}
	if b.SystemSkillEnabledFor(systemSkillAppBuilding, "writer") {
		t.Error("writer should be disabled for app-building")
	}
	if !b.SystemSkillEnabledFor(systemSkillAppBuilding, "ceo") {
		t.Error("ceo should stay enabled for app-building")
	}
	if !b.SystemSkillEnabledFor(systemSkillWikiMaintenance, "writer") {
		t.Error("writer should stay enabled for wiki-maintenance")
	}

	// Effective owners in the prompt catalog: roster minus disabled.
	owners := map[string]bool{}
	for _, summary := range b.ListActiveSkillSummaries() {
		if summary.Slug == systemSkillAppBuilding {
			for _, slug := range summary.OwnerBots {
				owners[slug] = true
			}
		}
	}
	if owners["writer"] || !owners["ceo"] {
		t.Errorf("summary owners = %v, want ceo without writer", owners)
	}

	// enable-for lifts the switch-off.
	req = httptest.NewRequest("POST", "/skills/app-building/enable-for", strings.NewReader(`{"agent":"writer"}`))
	rec = httptest.NewRecorder()
	b.handleSkillEnableForBot(rec, req, "app-building")
	if rec.Code != 200 {
		t.Fatalf("enable-for: code = %d, body %s", rec.Code, rec.Body.String())
	}
	if !b.SystemSkillEnabledFor(systemSkillAppBuilding, "writer") {
		t.Error("writer should be re-enabled for app-building")
	}
}

func TestSystemSkillsSurviveSkillListing(t *testing.T) {
	b := newSystemSkillsTestBroker(t)
	req := httptest.NewRequest("GET", "/skills", nil)
	rec := httptest.NewRecorder()
	b.handleSkills(rec, req)
	var body struct {
		Skills []struct {
			Name   string `json:"name"`
			System bool   `json:"system"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode skills: %v", err)
	}
	found := map[string]bool{}
	for _, sk := range body.Skills {
		if sk.System {
			found[sk.Name] = true
		}
	}
	if !found[systemSkillAppBuilding] || !found[systemSkillWikiMaintenance] {
		t.Fatalf("system skills missing from listing: %v", found)
	}
}

// The default roster is the Chief of Staff alone — no App Builder, no
// Librarian, no invented specialists. This locks the founder's onboarding
// contract at the recovery-roster layer too.
func TestDefaultOfficeMembersIsChiefOfStaffOnly(t *testing.T) {
	members := defaultOfficeMembers()
	if len(members) != 1 {
		slugs := make([]string, 0, len(members))
		for _, m := range members {
			slugs = append(slugs, m.Slug)
		}
		t.Fatalf("default roster = %v, want exactly the lead", slugs)
	}
	if members[0].Slug != "ceo" {
		t.Fatalf("default lead slug = %q", members[0].Slug)
	}
}
