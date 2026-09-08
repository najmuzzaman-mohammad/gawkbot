package team

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateLegacyLeadSlug(t *testing.T) {
	cases := map[string]string{
		`"ceo"`:                    `"cos"`,
		`"ceo__human"`:             `"cos__human"`,
		`"human__ceo"`:             `"human__cos"`,
		`"ceo__designer"`:          `"cos__designer"`,
		`"@ceo please scope this"`: `"@cos please scope this"`,
		`"#ceo__human"`:            `"#cos__human"`,
		`"ceo ceo"`:                `"cos cos"`,
		`"ceo_checklist"`:          `"ceo_checklist"`, // a card kind, not the slug
		`"ceo-card"`:               `"ceo-card"`,      // a css class, not the slug
		`"ceoMessagePayload"`:      `"ceoMessagePayload"`,
		`"CEO"`:                    `"CEO"`,
		`"the ceo's office"`:       `"the cos's office"`,
		`"task-follow-up:ceo--human:task-skill-31"`:                   `"task-follow-up:cos--human:task-skill-31"`,
		`"task-follow-up:human--ceo:task-1"`:                          `"task-follow-up:human--cos:task-1"`,
		`{"from":"ceo","channel":"ceo__human","tagged":["ceo","pm"]}`: `{"from":"cos","channel":"cos__human","tagged":["cos","pm"]}`,
	}
	for in, want := range cases {
		if got := migrateLegacyLeadSlug(in); got != want {
			t.Errorf("migrateLegacyLeadSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalisersAliasTheLegacyLeadSlug(t *testing.T) {
	if got := normalizeActorSlug("ceo"); got != LeadSlug {
		t.Fatalf("normalizeActorSlug(ceo) = %q, want %q", got, LeadSlug)
	}
	if got := normalizeActorSlug("CEO "); got != LeadSlug {
		t.Fatalf("normalizeActorSlug(CEO ) = %q, want %q", got, LeadSlug)
	}
	if got := normalizeChannelSlug("#ceo__human"); got != "cos__human" {
		t.Fatalf("normalizeChannelSlug(#ceo__human) = %q, want cos__human", got)
	}
	if got := normalizeChannelSlug("designer__ceo"); got != "designer__cos" {
		t.Fatalf("normalizeChannelSlug(designer__ceo) = %q, want designer__cos", got)
	}
	if got := normalizeChannelSlug("team"); got != "team" {
		t.Fatalf("normalizeChannelSlug(team) = %q", got)
	}
}

// A state file written before the rename loads with every slug moved.
func TestLoadStateMigratesLegacyLeadSlug(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "broker-state.json")
	legacy := `{"members":[{"slug":"ceo","name":"Chief of Staff"}],` +
		`"channels":[{"slug":"ceo__human","name":"DM: human & ceo","members":["human","ceo"]}],` +
		`"messages":[{"id":"m1","from":"ceo","channel":"ceo__human","content":"@ceo scoped it","tagged":["ceo"]}],` +
		`"tasks":[{"id":"t1","owner":"ceo","created_by":"ceo","channel":"ceo__human","title":"x"}]}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := loadBrokerStateFile(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(state.Members) != 1 || state.Members[0].Slug != LeadSlug {
		t.Fatalf("member slug not migrated: %+v", state.Members)
	}
	if state.Channels[0].Slug != "cos__human" || state.Channels[0].Members[1] != LeadSlug {
		t.Fatalf("channel not migrated: %+v", state.Channels[0])
	}
	m := state.Messages[0]
	if m.From != LeadSlug || m.Channel != "cos__human" || m.Content != "@cos scoped it" || m.Tagged[0] != LeadSlug {
		t.Fatalf("message not migrated: %+v", m)
	}
	if state.Tasks[0].Owner != LeadSlug || state.Tasks[0].CreatedBy != LeadSlug || state.Tasks[0].Channel != "cos__human" {
		t.Fatalf("task not migrated: %+v", state.Tasks[0])
	}
}

func TestMigrateLegacyLeadSlugDir(t *testing.T) {
	parent := t.TempDir()
	if err := os.MkdirAll(filepath.Join(parent, "ceo"), 0o700); err != nil {
		t.Fatal(err)
	}
	migrateLegacyLeadSlugDir(parent)
	if _, err := os.Stat(filepath.Join(parent, "cos")); err != nil {
		t.Fatalf("cos dir missing after migration: %v", err)
	}
	if _, err := os.Stat(filepath.Join(parent, "ceo")); !os.IsNotExist(err) {
		t.Fatalf("ceo dir still present after migration")
	}
	// Idempotent, and never clobbers an existing cos dir.
	if err := os.MkdirAll(filepath.Join(parent, "ceo"), 0o700); err != nil {
		t.Fatal(err)
	}
	migrateLegacyLeadSlugDir(parent)
	if _, err := os.Stat(filepath.Join(parent, "ceo")); err != nil {
		t.Fatalf("a second ceo dir must be left alone when cos exists: %v", err)
	}
}
