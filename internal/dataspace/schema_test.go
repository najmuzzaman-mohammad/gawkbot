package dataspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSlugify(t *testing.T) {
	cases := []struct{ name, want string }{
		{"Check size", "check_size"},
		{"  E-mail (work)  ", "e_mail_work"},
		{"__Due__date__", "due_date"},
		{"ARR 2026", "arr_2026"},
		{"!!!", "field"},
		{"", "field"},
		{"öps", "ps"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := slugify(tc.name, "field")
			if got != tc.want {
				t.Fatalf("slugify(%q) = %q, want %q", tc.name, got, tc.want)
			}
			if got[0] == '_' {
				t.Fatalf("slug %q starts with an underscore", got)
			}
		})
	}
}

func TestUniqueSlug(t *testing.T) {
	taken := map[string]bool{"name": true, "name_2": true}
	if got := uniqueSlug("name", taken); got != "name_3" {
		t.Fatalf("uniqueSlug = %q, want name_3", got)
	}
	if got := uniqueSlug("email", taken); got != "email" {
		t.Fatalf("uniqueSlug = %q, want email", got)
	}
}

func TestCreateObjectTypeAddsPrimary(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Investor")
	if entry.Slug != "investor" || entry.NamePlural != "Investors" {
		t.Fatalf("got slug %q plural %q", entry.Slug, entry.NamePlural)
	}
	if entry.CreatedBy != string(testOwner) || entry.RecordCount != 0 {
		t.Fatalf("got createdBy %q count %d", entry.CreatedBy, entry.RecordCount)
	}
	if entry.Icon != DefaultObjectTypeIcon {
		t.Fatalf("got icon %q", entry.Icon)
	}
	if len(entry.Attributes) != 1 {
		t.Fatalf("got %d attributes, want 1", len(entry.Attributes))
	}
	primary := entry.Attributes[0]
	if primary.Slug != "name" || primary.Type != TypeText || !primary.IsPrimary || !primary.IsRequired {
		t.Fatalf("primary attribute is %+v", primary)
	}
}

func TestCreateObjectTypeKeepsPluralAndUniquifiesSlug(t *testing.T) {
	k := newKit(t)
	first := k.typeWith(ObjectTypeInput{Name: "Company", NamePlural: "Companies"})
	second := k.typ("Company!")
	if first.NamePlural != "Companies" {
		t.Fatalf("plural = %q", first.NamePlural)
	}
	if first.Slug != "company" || second.Slug != "company_2" {
		t.Fatalf("slugs = %q, %q", first.Slug, second.Slug)
	}
}

func TestCreateObjectTypeRejectsEmptyAndDuplicate(t *testing.T) {
	k := newKit(t)
	k.typ("Deliverable")
	requireEntryError(t, k.typeError(ObjectTypeInput{Name: "  "}), "needs a name")
	requireEntryError(t, k.typeError(ObjectTypeInput{Name: "deliverable"}), "already exists")
	requireEntryError(t, k.typeError(ObjectTypeInput{Name: "deliverable"}), "Add attributes to it instead")
	if len(k.schema().ObjectTypes) != 1 {
		t.Fatalf("a failed create left a type behind")
	}
}

func TestRenameObjectTypeKeepsSlug(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Investor")
	name, plural := "Backer", "Backers"
	renamed, err := k.store.UpdateObjectType(k.ctx, k.actor, k.spaceID, entry.ID,
		ObjectTypePatch{Name: &name, NamePlural: &plural})
	if err != nil {
		t.Fatalf("UpdateObjectType: %v", err)
	}
	if renamed.Name != "Backer" || renamed.Slug != "investor" {
		t.Fatalf("renamed = %+v", renamed)
	}
}

func TestObjectTypeCountOnSpace(t *testing.T) {
	k := newKit(t)
	k.typ("A")
	k.typ("B")
	if got := k.space().ObjectTypeCount; got != 2 {
		t.Fatalf("objectTypeCount = %d, want 2", got)
	}
}

func TestObjectTypeLimit(t *testing.T) {
	k := newKit(t)
	inputs := make([]ObjectTypeInput, 0, MaxObjectTypesPerSpace)
	for i := 0; i < MaxObjectTypesPerSpace; i++ {
		inputs = append(inputs, ObjectTypeInput{Name: "Type " + string(rune('A'+i%26)) + string(rune('a'+i/26))})
	}
	result, err := k.store.CreateObjectTypes(k.ctx, k.actor, k.spaceID, inputs)
	if err != nil {
		t.Fatalf("CreateObjectTypes: %v", err)
	}
	if result.Failed != 0 {
		t.Fatalf("expected 50 types, got %+v", result.Entries[result.Failed])
	}
	requireEntryError(t, k.typeError(ObjectTypeInput{Name: "One too many"}), "at most 50 object types")

	_, err = k.store.CreateObjectTypes(k.ctx, k.actor, k.spaceID, append(inputs, ObjectTypeInput{Name: "x"}))
	requireValidation(t, err, "Split the call")
}

func TestAddAttributeSlugUniqueness(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Investor")
	got := []string{}
	for _, name := range []string{"Check size", "Check-size", "check.size"} {
		got = append(got, k.attr(entry.ID, AttributeInput{Name: name, Type: TypeText}).Slug)
	}
	if !equalStrings(got, []string{"check_size", "check_size_2", "check_size_3"}) {
		t.Fatalf("slugs = %v", got)
	}
}

func TestAddAttributeOptionColors(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Task")
	names := []string{"a", "b", "c", "d", "e", "f", "g"}
	attr := k.attr(entry.ID, AttributeInput{Name: "Label", Type: TypeSelect, Options: names})
	gotNames := []string{}
	gotColors := []string{}
	ids := map[string]bool{}
	for _, option := range attr.Options {
		gotNames = append(gotNames, option.Name)
		gotColors = append(gotColors, option.Color)
		ids[option.ID] = true
	}
	if !equalStrings(gotNames, names) {
		t.Fatalf("option names = %v", gotNames)
	}
	if len(ids) != 7 {
		t.Fatalf("option ids are not unique: %v", ids)
	}
	want := append(append([]string{}, OptionColors...), OptionColors[0])
	if !equalStrings(gotColors, want) {
		t.Fatalf("colors = %v, want %v", gotColors, want)
	}
}

func TestStatusDefaultsAndCurrency(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Deal")
	status := k.attr(entry.ID, AttributeInput{Name: "State", Type: TypeStatus})
	names := []string{}
	for _, option := range status.Options {
		names = append(names, option.Name)
	}
	if !equalStrings(names, DefaultStatusOptions) {
		t.Fatalf("status defaults = %v", names)
	}
	usd := k.attr(entry.ID, AttributeInput{Name: "Amount", Type: TypeCurrency})
	eur := k.attr(entry.ID, AttributeInput{Name: "Fee", Type: TypeCurrency, CurrencyCode: "eur"})
	text := k.attr(entry.ID, AttributeInput{Name: "Memo", Type: TypeText})
	if usd.CurrencyCode != "USD" || eur.CurrencyCode != "EUR" || text.CurrencyCode != "" {
		t.Fatalf("currency codes = %q %q %q", usd.CurrencyCode, eur.CurrencyCode, text.CurrencyCode)
	}
}

func TestAddAttributeRejections(t *testing.T) {
	cases := []struct {
		label string
		input AttributeInput
		want  string
	}{
		{"select without options", AttributeInput{Name: "Tier", Type: TypeSelect}, "at least one option"},
		{"multivalue status", AttributeInput{Name: "State", Type: TypeStatus, IsMultivalue: true}, "exactly one value"},
		{"multivalue text", AttributeInput{Name: "Tags", Type: TypeText, IsMultivalue: true}, "only select, email, url"},
		{"multivalue phone", AttributeInput{Name: "Phones", Type: TypePhone, IsMultivalue: true}, "only select, email, url"},
		{"unique multivalue", AttributeInput{Name: "Emails", Type: TypeEmail, IsMultivalue: true, IsUnique: true}, "unique attribute cannot hold multiple"},
		{"unique toggle", AttributeInput{Name: "Flag", Type: TypeToggle, IsUnique: true}, "cannot be unique"},
		{"duplicate options", AttributeInput{Name: "Tier", Type: TypeSelect, Options: []string{"Gold", " gold "}}, "listed twice"},
		{"options on text", AttributeInput{Name: "Memo", Type: TypeText, Options: []string{"x"}}, "only valid for select"},
		{"bad currency", AttributeInput{Name: "Fee", Type: TypeCurrency, CurrencyCode: "EURO"}, "currency code"},
		{"empty name", AttributeInput{Name: " ", Type: TypeText}, "needs a name"},
		{"duplicate name", AttributeInput{Name: "NAME", Type: TypeText}, "already has an attribute"},
		{"relationship without target", AttributeInput{Name: "Firm", Type: TypeRelationship}, "needs a target"},
		{"unknown type", AttributeInput{Name: "Thing", Type: AttributeType("blob")}, "is not an attribute type"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			k := newKit(t)
			entry := k.typ("Thing")
			requireEntryError(t, k.attrError(entry.ID, tc.input), tc.want)
			if got := k.attrSlugs(entry.ID); len(got) != 1 {
				t.Fatalf("a failed attribute landed: %v", got)
			}
		})
	}
}

func TestMultivalueAllowedTypes(t *testing.T) {
	for _, kind := range []AttributeType{TypeSelect, TypeEmail, TypeURL} {
		t.Run(string(kind), func(t *testing.T) {
			k := newKit(t)
			entry := k.typ("Thing")
			input := AttributeInput{Name: "Many", Type: kind, IsMultivalue: true}
			if kind == TypeSelect {
				input.Options = []string{"x"}
			}
			if attr := k.attr(entry.ID, input); !attr.IsMultivalue {
				t.Fatalf("isMultivalue not kept")
			}
		})
	}
}

func TestAttributeLimit(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Wide")
	inputs := make([]AttributeInput, 0, MaxAttributesPerType-1)
	for i := 0; i < MaxAttributesPerType-1; i++ {
		inputs = append(inputs, AttributeInput{Name: "Field " + itoa(i), Type: TypeText})
	}
	result, err := k.store.AddAttributes(k.ctx, k.actor, k.spaceID, entry.ID, inputs)
	if err != nil {
		t.Fatalf("AddAttributes: %v", err)
	}
	if result.Failed != 0 {
		t.Fatalf("unexpected failure: %+v", result.Entries)
	}
	requireEntryError(t, k.attrError(entry.ID, AttributeInput{Name: "One more", Type: TypeText}),
		"already has 100 attributes")
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	digits := ""
	for i > 0 {
		digits = string(rune('0'+i%10)) + digits
		i /= 10
	}
	return digits
}

// ── relationships ────────────────────────────────────────────────

func TestRelationshipPairIsAtomic(t *testing.T) {
	k := newKit(t)
	firm := k.typ("Firm")
	investor := k.typ("Investor")
	owning := k.relate(investor.ID, "Firm", firm.ID, CardinalityManyToOne, "Investors")

	var mirrored *Attribute
	for _, attr := range k.readType(firm.ID).Attributes {
		if attr.Slug == "investors" {
			copied := attr
			mirrored = &copied
		}
	}
	if mirrored == nil {
		t.Fatalf("mirrored attribute missing")
	}
	if owning.Relationship.TargetTypeID != firm.ID ||
		owning.Relationship.Cardinality != CardinalityManyToOne ||
		owning.Relationship.InverseAttributeID != mirrored.ID {
		t.Fatalf("owning relationship = %+v", owning.Relationship)
	}
	if mirrored.Relationship.RelationshipID != owning.Relationship.RelationshipID ||
		mirrored.Relationship.TargetTypeID != investor.ID ||
		mirrored.Relationship.Cardinality != CardinalityOneToMany ||
		mirrored.Relationship.InverseAttributeID != owning.ID {
		t.Fatalf("mirrored relationship = %+v", mirrored.Relationship)
	}
	if len(k.schema().Relationships) != 1 {
		t.Fatalf("expected one relationship row")
	}
}

func TestRelationshipCardinalityMirror(t *testing.T) {
	cases := []struct{ own, flipped Cardinality }{
		{CardinalityOneToOne, CardinalityOneToOne},
		{CardinalityManyToOne, CardinalityOneToMany},
		{CardinalityOneToMany, CardinalityManyToOne},
		{CardinalityManyToMany, CardinalityManyToMany},
	}
	for _, tc := range cases {
		t.Run(string(tc.own), func(t *testing.T) {
			k := newKit(t)
			a := k.typ("A")
			b := k.typ("B")
			k.relate(a.ID, "Bs", b.ID, tc.own, "As")
			mirrored := k.readType(b.ID).Attributes[1]
			if mirrored.Relationship.Cardinality != tc.flipped {
				t.Fatalf("mirror = %s, want %s", mirrored.Relationship.Cardinality, tc.flipped)
			}
		})
	}
}

func TestRelationshipWithoutInverse(t *testing.T) {
	k := newKit(t)
	a := k.typ("A")
	b := k.typ("B")
	owning := k.relate(a.ID, "B", b.ID, CardinalityManyToOne, "  ")
	if owning.Relationship.InverseAttributeID != "" {
		t.Fatalf("inverse id = %q, want empty", owning.Relationship.InverseAttributeID)
	}
	if got := k.attrSlugs(b.ID); len(got) != 1 {
		t.Fatalf("target gained an attribute: %v", got)
	}
}

func TestRelationshipRejectsSelfAndDuplicates(t *testing.T) {
	k := newKit(t)
	a := k.typ("A")
	b := k.typ("B")
	requireEntryError(t, k.relateError(a.ID, "Parent", a.ID, CardinalityManyToOne, "Children"), "itself")

	k.relate(a.ID, "Partner", b.ID, CardinalityManyToMany, "")
	requireEntryError(t, k.relateError(a.ID, "partner", b.ID, CardinalityManyToOne, ""), "already")
	requireEntryError(t, k.relateError(b.ID, "PARTNER", a.ID, CardinalityManyToOne, ""), "already related")
	// A second relationship under a different name is fine.
	k.relate(a.ID, "Backup partner", b.ID, CardinalityManyToOne, "")
}

func TestRelationshipRollsBackWhenInverseCollides(t *testing.T) {
	k := newKit(t)
	a := k.typ("A")
	b := k.typ("B")
	k.attr(b.ID, AttributeInput{Name: "Owners", Type: TypeText})
	requireEntryError(t, k.relateError(a.ID, "B", b.ID, CardinalityManyToOne, "owners"), "already has an attribute")
	if got := k.attrSlugs(a.ID); len(got) != 1 {
		t.Fatalf("owning attribute landed anyway: %v", got)
	}
	if got := k.attrSlugs(b.ID); len(got) != 2 {
		t.Fatalf("target changed: %v", got)
	}
	if len(k.schema().Relationships) != 0 {
		t.Fatalf("a relationship row survived the rollback")
	}
}

func TestRelationshipRejectsBadCardinalityAndFlags(t *testing.T) {
	k := newKit(t)
	a := k.typ("A")
	b := k.typ("B")
	requireEntryError(t, k.relateError(a.ID, "B", b.ID, Cardinality("sometimes"), ""), "is not a cardinality")
	requireEntryError(t, k.attrError(a.ID, AttributeInput{
		Name: "B", Type: TypeRelationship, IsRequired: true,
		Relationship: &RelationshipInput{Target: b.ID, Cardinality: CardinalityManyToOne},
	}), "do not take required")
	requireEntryError(t, k.relateError(a.ID, "Nowhere", "type_nope", CardinalityManyToOne, ""), "Unknown object type")
}

func TestCreateObjectTypesResolvesTargetInSameCall(t *testing.T) {
	k := newKit(t)
	result, err := k.store.CreateObjectTypes(k.ctx, k.actor, k.spaceID, []ObjectTypeInput{
		{Name: "Firm", Attributes: []AttributeInput{{Name: "Domain", Type: TypeText, IsUnique: true}}},
		{Name: "Investor", Attributes: []AttributeInput{
			{Name: "Email", Type: TypeEmail, IsUnique: true},
			{Name: "Firm", Type: TypeRelationship, Relationship: &RelationshipInput{
				Target: "Firm", Cardinality: CardinalityManyToOne, InverseName: "Investors",
			}},
		}},
	})
	if err != nil {
		t.Fatalf("CreateObjectTypes: %v", err)
	}
	if result.Succeeded != 2 || result.Failed != 0 {
		t.Fatalf("result = %+v", result)
	}
	firm := k.readType(result.Entries[0].ID)
	investor := k.readType(result.Entries[1].ID)
	if !equalStrings(k.attrSlugs(firm.ID), []string{"name", "domain", "investors"}) {
		t.Fatalf("firm slugs = %v", k.attrSlugs(firm.ID))
	}
	if !equalStrings(k.attrSlugs(investor.ID), []string{"name", "email", "firm"}) {
		t.Fatalf("investor slugs = %v", k.attrSlugs(investor.ID))
	}
}

func TestCreateObjectTypesOneBadEntryDoesNotStopTheRest(t *testing.T) {
	k := newKit(t)
	result, err := k.store.CreateObjectTypes(k.ctx, k.actor, k.spaceID, []ObjectTypeInput{
		{Name: "Good"},
		{Name: "Bad", Attributes: []AttributeInput{{Name: "Tier", Type: TypeSelect}}},
		{Name: "Also good"},
	})
	if err != nil {
		t.Fatalf("CreateObjectTypes: %v", err)
	}
	if result.Succeeded != 2 || result.Failed != 1 {
		t.Fatalf("result = %+v", result)
	}
	if result.Entries[1].Status != StatusFailed || result.Entries[1].Index != 1 {
		t.Fatalf("entry = %+v", result.Entries[1])
	}
	names := []string{}
	for _, entry := range k.schema().ObjectTypes {
		names = append(names, entry.Name)
	}
	if !equalStrings(names, []string{"Good", "Also good"}) {
		t.Fatalf("types = %v", names)
	}
}

// ── updateAttribute ──────────────────────────────────────────────

func TestUpdateAttributeRenameKeepsSlug(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Meeting")
	date := k.attr(entry.ID, AttributeInput{Name: "Date", Type: TypeDate})
	name, description, required := "Held on", "When it happened", true
	renamed, err := k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID, date.ID,
		AttributePatch{Name: &name, Description: &description, IsRequired: &required})
	if err != nil {
		t.Fatalf("UpdateAttribute: %v", err)
	}
	if renamed.Name != "Held on" || renamed.Slug != "date" ||
		renamed.Description != "When it happened" || !renamed.IsRequired {
		t.Fatalf("renamed = %+v", renamed)
	}
	title := "Title"
	primary, err := k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID,
		entry.Attributes[0].ID, AttributePatch{Name: &title})
	if err != nil {
		t.Fatalf("UpdateAttribute(primary): %v", err)
	}
	if primary.Name != "Title" || primary.Slug != "name" || !primary.IsPrimary {
		t.Fatalf("primary = %+v", primary)
	}
}

func TestUpdateAttributeOptions(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Deliverable")
	attr := k.attr(entry.ID, AttributeInput{
		Name: "Priority", Type: TypeSelect, Options: []string{"low", "medium"},
	})
	added, err := k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID, attr.ID,
		AttributePatch{AddOptions: []string{"MEDIUM", "high", "High"}})
	if err != nil {
		t.Fatalf("UpdateAttribute: %v", err)
	}
	names := []string{}
	for _, option := range added.Options {
		names = append(names, option.Name)
	}
	if !equalStrings(names, []string{"low", "medium", "high"}) {
		t.Fatalf("options = %v", names)
	}
	if added.Options[2].Color != OptionColors[2] {
		t.Fatalf("color = %q", added.Options[2].Color)
	}
	if added.Options[0] != attr.Options[0] || added.Options[1] != attr.Options[1] {
		t.Fatalf("existing options were rewritten")
	}

	record := k.create(entry.ID, map[string]any{"name": "Copy deck", "priority": "high"})
	renamed, err := k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID, attr.ID,
		AttributePatch{RenameOption: &struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{ID: added.Options[2].ID, Name: "urgent"}})
	if err != nil {
		t.Fatalf("rename option: %v", err)
	}
	if renamed.Options[2].ID != added.Options[2].ID || renamed.Options[2].Name != "urgent" {
		t.Fatalf("renamed option = %+v", renamed.Options[2])
	}
	if got := k.record(record.ID).Values["priority"]; got != added.Options[2].ID {
		t.Fatalf("record was rewritten: %v", got)
	}
}

func TestUpdateAttributeOptionErrors(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Deliverable")
	attr := k.attr(entry.ID, AttributeInput{
		Name: "Priority", Type: TypeSelect, Options: []string{"low", "high"},
	})
	_, err := k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID, attr.ID,
		AttributePatch{RenameOption: &struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{ID: attr.Options[0].ID, Name: "HIGH"}})
	requireValidation(t, err, "already has an option")

	_, err = k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID, attr.ID,
		AttributePatch{RenameOption: &struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{ID: "opt_nope", Name: "x"}})
	requireValidation(t, err, "no option with id")

	text := k.attr(entry.ID, AttributeInput{Name: "Memo", Type: TypeText})
	_, err = k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID, text.ID,
		AttributePatch{AddOptions: []string{"x"}})
	requireValidation(t, err, "has no options")
}

func TestUpdateAttributeKeepsPrimaryRequired(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Thing")
	required := false
	_, err := k.store.UpdateAttribute(k.ctx, k.actor, k.spaceID, entry.ID,
		entry.Attributes[0].ID, AttributePatch{IsRequired: &required})
	requireValidation(t, err, "always required")
}

// ── on disk ──────────────────────────────────────────────────────

func TestPersistenceAcrossOpen(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Investor")
	k.attr(entry.ID, AttributeInput{Name: "Email", Type: TypeEmail, IsUnique: true})
	firm := k.typ("Firm")
	k.relate(entry.ID, "Firm", firm.ID, CardinalityManyToOne, "Investors")
	investor := k.create(entry.ID, map[string]any{"name": "Mirela", "email": "m@tidewrack.example"})
	tidewrack := k.create(firm.ID, map[string]any{"name": "Tidewrack"})
	k.mustLink(investor.ID, "firm", tidewrack.ID, false)

	next := k.reopen()
	schema := next.schema()
	if len(schema.ObjectTypes) != 2 || len(schema.Relationships) != 1 {
		t.Fatalf("schema after reopen = %+v", schema)
	}
	if !equalStrings(next.attrSlugs(entry.ID), []string{"name", "email", "firm"}) {
		t.Fatalf("slugs after reopen = %v", next.attrSlugs(entry.ID))
	}
	reread := next.record(investor.ID)
	if reread.Values["email"] != "m@tidewrack.example" {
		t.Fatalf("value after reopen = %v", reread.Values["email"])
	}
	if !equalStrings(next.linkNames(investor.ID, "firm"), []string{"Tidewrack"}) {
		t.Fatalf("links after reopen = %v", next.linkNames(investor.ID, "firm"))
	}
	if got := next.space().RecordCount; got != 2 {
		t.Fatalf("record count after reopen = %d", got)
	}
	// The unique index survives too.
	requireEntryError(t, next.createError(entry.ID,
		map[string]any{"name": "Copy", "email": "M@Tidewrack.example"}), "must be unique")
}

func TestNewUsesTheRuntimeHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("WUPHF_RUNTIME_HOME", home)
	opened, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = opened.Close() }()
	want := filepath.Join(home, ".wuphf", "data", indexFile)
	if _, statErr := os.Stat(want); statErr != nil {
		t.Fatalf("expected the index at %s: %v", want, statErr)
	}
}

func TestMigrationIsIdempotentAndRecorded(t *testing.T) {
	k := newKit(t)
	k.typ("Thing")
	db, err := k.store.spaceDB(k.ctx, k.spaceID)
	if err != nil {
		t.Fatalf("spaceDB: %v", err)
	}
	var version, spaceID string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&version); err != nil {
		t.Fatalf("schema_version: %v", err)
	}
	if version != "1" {
		t.Fatalf("schema_version = %q, want 1", version)
	}
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = 'space_id'`).Scan(&spaceID); err != nil {
		t.Fatalf("space_id: %v", err)
	}
	if spaceID != k.spaceID {
		t.Fatalf("space_id = %q, want %q", spaceID, k.spaceID)
	}
	// Re-running the migration on an existing database changes nothing. The
	// file exists and is non-empty, which is exactly the shape migrateSpace
	// refuses at version 0; at the current version it returns before that.
	path := k.store.spacePath(k.spaceID)
	if err := migrateSpace(k.ctx, db, k.spaceID, path, fileSize(path)); err != nil {
		t.Fatalf("migrateSpace again: %v", err)
	}
	if len(k.schema().ObjectTypes) != 1 {
		t.Fatalf("a second migration disturbed the schema")
	}
}

func TestFilePermissions(t *testing.T) {
	root := t.TempDir()
	inner := filepath.Join(root, "data")
	k := newKitAt(t, inner)
	k.typ("Thing")

	info, err := os.Stat(inner)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if info.Mode().Perm() != dirMode {
		t.Fatalf("directory mode = %v, want %v", info.Mode().Perm(), dirMode)
	}
	for _, name := range []string{indexFile, k.spaceID + ".db"} {
		stat, statErr := os.Stat(filepath.Join(inner, name))
		if statErr != nil {
			t.Fatalf("stat %s: %v", name, statErr)
		}
		if stat.Mode().Perm() != fileMode {
			t.Fatalf("%s mode = %v, want %v", name, stat.Mode().Perm(), fileMode)
		}
	}
}
