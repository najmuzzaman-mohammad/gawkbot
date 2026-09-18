package dataspace

import (
	"math"
	"reflect"
	"testing"
)

// valueKit is one object type carrying one attribute of every kind, so a
// coercion case is a slug plus a raw value.
type valueKit struct {
	*kit
	typeID string
}

func newValueKit(t *testing.T) *valueKit {
	t.Helper()
	k := newKit(t)
	entry := k.typ("Sample")
	inputs := []AttributeInput{
		{Name: "Memo", Type: TypeText},
		{Name: "Count", Type: TypeNumber},
		{Name: "Amount", Type: TypeCurrency},
		{Name: "Score", Type: TypeRating},
		{Name: "Due", Type: TypeDate},
		{Name: "Done", Type: TypeToggle},
		{Name: "Email", Type: TypeEmail},
		{Name: "Site", Type: TypeURL},
		{Name: "Phone", Type: TypePhone},
		{Name: "Priority", Type: TypeSelect, Options: []string{"low", "medium", "high"}},
		{Name: "Stage", Type: TypeStatus, Options: []string{"Intro", "Pitched"}},
		{Name: "Skills", Type: TypeSelect, IsMultivalue: true, Options: []string{"Go", "SQL"}},
		{Name: "Aliases", Type: TypeEmail, IsMultivalue: true},
	}
	result, err := k.store.AddAttributes(k.ctx, k.actor, k.spaceID, entry.ID, inputs)
	if err != nil {
		t.Fatalf("AddAttributes: %v", err)
	}
	if result.Failed != 0 {
		t.Fatalf("AddAttributes: %+v", result.Entries)
	}
	return &valueKit{kit: k, typeID: entry.ID}
}

func (v *valueKit) store1(slug string, raw any) (Value, Entry) {
	v.t.Helper()
	result, err := v.store.CreateRecords(v.ctx, v.actor, v.spaceID, v.typeID,
		[]RecordInput{{Values: map[string]any{"name": "row", slug: raw}}})
	if err != nil {
		v.t.Fatalf("CreateRecords: %v", err)
	}
	entry := result.Entries[0]
	if entry.Status == StatusFailed {
		return nil, entry
	}
	return v.record(entry.ID).Values[slug], entry
}

func TestValueCoercionAccepts(t *testing.T) {
	cases := []struct {
		slug string
		raw  any
		want Value
	}{
		{"memo", "  padded  ", "  padded  "},
		{"count", 12.5, 12.5},
		{"count", " 42 ", 42.0},
		{"count", "-3e2", -300.0},
		{"count", 7, 7.0},
		{"amount", "250000", 250000.0},
		{"score", 5, 5.0},
		{"score", "1", 1.0},
		{"due", "2026-10-01", "2026-10-01"},
		{"due", "2026-10-01T23:30:00-07:00", "2026-10-01"},
		{"due", "2026-02-28T00:00:00.123Z", "2026-02-28"},
		{"done", true, true},
		{"done", "FALSE", false},
		{"done", " true ", true},
		{"email", " mira@tidewrack.example ", "mira@tidewrack.example"},
		{"site", "https://tidewrack.example/team", "https://tidewrack.example/team"},
		{"phone", " +1 415 555 0112 ", "+1 415 555 0112"},
		{"aliases", "a@x.example", []string{"a@x.example"}},
		{"aliases", []any{"a@x.example", "A@X.example", "b@x.example"},
			[]string{"a@x.example", "b@x.example"}},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			v := newValueKit(t)
			got, entry := v.store1(tc.slug, tc.raw)
			if entry.Status == StatusFailed {
				t.Fatalf("unexpected failure: %s", entry.Error)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("stored %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestValueCoercionRefuses(t *testing.T) {
	cases := []struct {
		slug string
		raw  any
		want string
	}{
		{"memo", 12, "must be text"},
		{"count", "twelve", "must be a number"},
		{"count", math.NaN(), "must be a number"},
		{"amount", true, "must be a number"},
		{"score", 7, "whole number from 1 to 5; got 7"},
		{"score", 0, "whole number from 1 to 5"},
		{"score", 2.5, "whole number from 1 to 5"},
		{"due", "10/01/2026", "YYYY-MM-DD"},
		{"due", "2026-02-30", "YYYY-MM-DD"},
		{"due", 20261001, "YYYY-MM-DD"},
		{"done", "yes", "true or false"},
		{"done", 1, "true or false"},
		{"email", "not-an-email", "email address"},
		{"site", "tidewrack.example", "http:// or https://"},
		{"site", "ftp://tidewrack.example", "http:// or https://"},
		{"priority", []any{"low"}, "single value"},
		{"stage", "Closed", "Valid options: Intro, Pitched."},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			v := newValueKit(t)
			_, entry := v.store1(tc.slug, tc.raw)
			requireEntryError(t, entry, tc.want)
			if entry.Attribute != tc.slug {
				t.Fatalf("entry attribute = %q, want %q", entry.Attribute, tc.slug)
			}
			if got := v.space().RecordCount; got != 0 {
				t.Fatalf("a rejected record landed: count = %d", got)
			}
		})
	}
}

func TestOptionMatching(t *testing.T) {
	v := newValueKit(t)
	high := v.optionID(v.typeID, "priority", "high")
	for _, raw := range []any{high, "  HIGH ", "high"} {
		got, entry := v.store1("priority", raw)
		if entry.Status == StatusFailed {
			t.Fatalf("option %v rejected: %s", raw, entry.Error)
		}
		if got != high {
			t.Fatalf("stored %v, want %v", got, high)
		}
	}
}

func TestOptionErrorListsValidNames(t *testing.T) {
	v := newValueKit(t)
	_, entry := v.store1("priority", "urgent")
	want := `"urgent" is not a valid option for Priority. Valid options: low, medium, high.`
	if entry.Error != want {
		t.Fatalf("error = %q, want %q", entry.Error, want)
	}
}

func TestOptionErrorCapsAt25(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Thing")
	options := make([]string, 0, 30)
	for i := 1; i <= 30; i++ {
		options = append(options, "opt"+itoa(i))
	}
	k.attr(entry.ID, AttributeInput{Name: "Pick", Type: TypeSelect, Options: options})
	failed := k.createError(entry.ID, map[string]any{"name": "x", "pick": "zzz"})
	if !contains(failed.Error, "opt25, and 5 more.") {
		t.Fatalf("error = %q", failed.Error)
	}
	if contains(failed.Error, "opt26") {
		t.Fatalf("error lists opt26: %q", failed.Error)
	}
}

func TestMultivalueAcceptsScalarAndDeduplicates(t *testing.T) {
	v := newValueKit(t)
	goID := v.optionID(v.typeID, "skills", "Go")
	sqlID := v.optionID(v.typeID, "skills", "SQL")

	got, entry := v.store1("skills", "go")
	if entry.Status == StatusFailed {
		t.Fatalf("scalar rejected: %s", entry.Error)
	}
	if !reflect.DeepEqual(got, []string{goID}) {
		t.Fatalf("stored %#v", got)
	}

	got, entry = v.store1("skills", []any{"Go", goID, "sql", "SQL "})
	if entry.Status == StatusFailed {
		t.Fatalf("list rejected: %s", entry.Error)
	}
	if !reflect.DeepEqual(got, []string{goID, sqlID}) {
		t.Fatalf("stored %#v", got)
	}

	got, entry = v.store1("skills", []any{})
	if entry.Status == StatusFailed {
		t.Fatalf("empty list rejected: %s", entry.Error)
	}
	if got != nil {
		t.Fatalf("empty list stored %#v, want nothing", got)
	}
}

// ── record validation ────────────────────────────────────────────

type recordKit struct {
	*kit
	firm     string
	investor string
}

func newRecordKit(t *testing.T) *recordKit {
	t.Helper()
	k := newKit(t)
	firm := k.typ("Firm")
	investor := k.typ("Investor")
	k.attr(investor.ID, AttributeInput{Name: "Email", Type: TypeEmail, IsUnique: true})
	k.attr(investor.ID, AttributeInput{Name: "Notes", Type: TypeText})
	k.relate(investor.ID, "Firm", firm.ID, CardinalityManyToOne, "Investors")
	return &recordKit{kit: k, firm: firm.ID, investor: investor.ID}
}

func TestPrimaryIsRequiredAndCannotBeCleared(t *testing.T) {
	r := newRecordKit(t)
	missing := r.createError(r.investor, map[string]any{"notes": "hi"})
	if missing.Error != "Name is required." || missing.Attribute != "name" {
		t.Fatalf("entry = %+v", missing)
	}
	record := r.create(r.investor, map[string]any{"name": "Mirela"})
	for _, cleared := range []any{nil, "", "   "} {
		_, err := r.store.UpdateRecord(r.ctx, r.actor, r.spaceID, record.ID,
			map[string]any{"name": cleared})
		invalid := requireValidation(t, err, "Name is required and cannot be cleared.")
		if invalid.Attribute != "name" {
			t.Fatalf("attribute = %q", invalid.Attribute)
		}
	}
}

func TestClearOptionalValue(t *testing.T) {
	r := newRecordKit(t)
	record := r.create(r.investor, map[string]any{
		"name": "Mirela", "notes": "warm intro", "email": "mirela@tidewrack.example",
	})
	next := r.update(record.ID, map[string]any{"notes": nil})
	if len(next.Values) != 2 || next.Values["name"] != "Mirela" ||
		next.Values["email"] != "mirela@tidewrack.example" {
		t.Fatalf("values = %#v", next.Values)
	}
	if !(next.UpdatedAt > record.UpdatedAt) {
		t.Fatalf("updatedAt did not move: %q -> %q", record.UpdatedAt, next.UpdatedAt)
	}
}

func TestUniqueIsCaseInsensitiveAndNamesTheRecord(t *testing.T) {
	r := newRecordKit(t)
	first := r.create(r.investor, map[string]any{"name": "Mirela", "email": "mirela@tidewrack.example"})
	second := r.create(r.investor, map[string]any{"name": "Tobias"})

	onCreate := r.createError(r.investor, map[string]any{
		"name": "Copy", "email": "MIRELA@Tidewrack.example",
	})
	if !contains(onCreate.Error, first.ID) || onCreate.Attribute != "email" {
		t.Fatalf("entry = %+v", onCreate)
	}
	_, err := r.store.UpdateRecord(r.ctx, r.actor, r.spaceID, second.ID,
		map[string]any{"email": "mirela@tidewrack.example"})
	requireValidation(t, err, first.ID)

	// Re-saving a record's own value is not a conflict.
	if _, err := r.store.UpdateRecord(r.ctx, r.actor, r.spaceID, first.ID,
		map[string]any{"email": "mirela@tidewrack.example"}); err != nil {
		t.Fatalf("own value rejected: %v", err)
	}
}

func TestUnknownAttributeNamesValidSlugs(t *testing.T) {
	r := newRecordKit(t)
	failed := r.createError(r.investor, map[string]any{"name": "x", "stage": "y"})
	want := `"stage" is not an attribute of Investor. Valid attributes: name, email, notes.`
	if failed.Error != want {
		t.Fatalf("error = %q, want %q", failed.Error, want)
	}
}

func TestRelationshipSlugInValuesPointsAtLink(t *testing.T) {
	r := newRecordKit(t)
	failed := r.createError(r.investor, map[string]any{"name": "x", "firm": "rec_1"})
	if !contains(failed.Error, "set by linking records") || failed.Attribute != "firm" {
		t.Fatalf("entry = %+v", failed)
	}
}

func TestOneBadValueWritesNothing(t *testing.T) {
	r := newRecordKit(t)
	record := r.create(r.investor, map[string]any{"name": "Mirela"})
	_, err := r.store.UpdateRecord(r.ctx, r.actor, r.spaceID, record.ID,
		map[string]any{"notes": "saved?", "email": "broken"})
	requireValidation(t, err, "email address")
	reread := r.record(record.ID)
	if len(reread.Values) != 1 || reread.Values["name"] != "Mirela" {
		t.Fatalf("values = %#v", reread.Values)
	}
}

func TestRecordCountsStayCorrect(t *testing.T) {
	r := newRecordKit(t)
	r.create(r.investor, map[string]any{"name": "A"})
	r.create(r.investor, map[string]any{"name": "B"})
	r.create(r.firm, map[string]any{"name": "F"})
	if got := r.readType(r.investor).RecordCount; got != 2 {
		t.Fatalf("investor count = %d", got)
	}
	if got := r.readType(r.firm).RecordCount; got != 1 {
		t.Fatalf("firm count = %d", got)
	}
	if got := r.space().RecordCount; got != 3 {
		t.Fatalf("space count = %d", got)
	}
}

func TestValuesAcceptAttributeNamesToo(t *testing.T) {
	r := newRecordKit(t)
	record := r.create(r.investor, map[string]any{"Name": "Mirela", "Email": "m@x.example"})
	if record.Values["name"] != "Mirela" || record.Values["email"] != "m@x.example" {
		t.Fatalf("values = %#v", record.Values)
	}
}

// ── upsert ───────────────────────────────────────────────────────

func TestUpsertMatchesOnUniqueAttribute(t *testing.T) {
	r := newRecordKit(t)
	first, err := r.store.UpsertRecords(r.ctx, r.actor, r.spaceID, r.investor, "email",
		[]RecordInput{
			{Values: map[string]any{"name": "Mirela", "email": "mirela@tidewrack.example"}},
			{Values: map[string]any{"name": "Tobias", "email": "tobias@tidewrack.example"}},
		})
	if err != nil {
		t.Fatalf("UpsertRecords: %v", err)
	}
	if first.Succeeded != 2 || first.Failed != 0 {
		t.Fatalf("result = %+v", first)
	}
	second, err := r.store.UpsertRecords(r.ctx, r.actor, r.spaceID, r.investor, "email",
		[]RecordInput{
			{Values: map[string]any{"name": "Mirela Okonjo-Hart", "email": "MIRELA@tidewrack.example", "notes": nil}},
		})
	if err != nil {
		t.Fatalf("UpsertRecords: %v", err)
	}
	if second.Entries[0].ID != first.Entries[0].ID {
		t.Fatalf("upsert created a second record")
	}
	if got := r.readType(r.investor).RecordCount; got != 2 {
		t.Fatalf("record count = %d, want 2", got)
	}
	if got := r.record(first.Entries[0].ID).Values["name"]; got != "Mirela Okonjo-Hart" {
		t.Fatalf("name = %v", got)
	}
}

func TestUpsertSkipsNilValues(t *testing.T) {
	r := newRecordKit(t)
	created := r.create(r.investor, map[string]any{
		"name": "Mirela", "email": "mirela@tidewrack.example", "notes": "keep me",
	})
	if _, err := r.store.UpsertRecords(r.ctx, r.actor, r.spaceID, r.investor, "email",
		[]RecordInput{{Values: map[string]any{"email": "mirela@tidewrack.example", "notes": nil}}}); err != nil {
		t.Fatalf("UpsertRecords: %v", err)
	}
	if got := r.record(created.ID).Values["notes"]; got != "keep me" {
		t.Fatalf("nil cleared the value: %v", got)
	}
}

func TestUpsertRequiresAUniqueMatchAttribute(t *testing.T) {
	r := newRecordKit(t)
	_, err := r.store.UpsertRecords(r.ctx, r.actor, r.spaceID, r.investor, "notes", nil)
	requireValidation(t, err, "is not unique")
	requireValidation(t, err, "Unique attributes on Investor: email.")

	_, err = r.store.UpsertRecords(r.ctx, r.actor, r.spaceID, r.investor, "nope", nil)
	requireValidation(t, err, "cannot match an upsert")

	_, err = r.store.UpsertRecords(r.ctx, r.actor, r.spaceID, r.investor, "", nil)
	requireValidation(t, err, "needs a matching attribute")
}

func TestUpsertNeedsTheMatchValue(t *testing.T) {
	r := newRecordKit(t)
	result, err := r.store.UpsertRecords(r.ctx, r.actor, r.spaceID, r.investor, "email",
		[]RecordInput{{Values: map[string]any{"name": "No email"}}})
	if err != nil {
		t.Fatalf("UpsertRecords: %v", err)
	}
	requireEntryError(t, result.Entries[0], "needs a value for Email")
}

func TestPerCallRecordLimit(t *testing.T) {
	r := newRecordKit(t)
	inputs := make([]RecordInput, MaxRecordsPerCall+1)
	for i := range inputs {
		inputs[i] = RecordInput{Values: map[string]any{"name": "row"}}
	}
	_, err := r.store.CreateRecords(r.ctx, r.actor, r.spaceID, r.investor, inputs)
	requireValidation(t, err, "Split the call")
	if got := r.space().RecordCount; got != 0 {
		t.Fatalf("a rejected call wrote %d records", got)
	}
}

func TestBatchKeepsRequestOrderAndIsolatesFailures(t *testing.T) {
	r := newRecordKit(t)
	result, err := r.store.CreateRecords(r.ctx, r.actor, r.spaceID, r.investor, []RecordInput{
		{Values: map[string]any{"name": "Good"}},
		{Values: map[string]any{"notes": "no name"}},
		{Values: map[string]any{"name": "Also good"}},
	})
	if err != nil {
		t.Fatalf("CreateRecords: %v", err)
	}
	if result.Succeeded != 2 || result.Failed != 1 || len(result.Entries) != 3 {
		t.Fatalf("result = %+v", result)
	}
	for index, entry := range result.Entries {
		if entry.Index != index {
			t.Fatalf("entry %d has index %d", index, entry.Index)
		}
	}
	if result.Entries[1].Status != StatusFailed || result.Entries[1].Attribute != "name" {
		t.Fatalf("failed entry = %+v", result.Entries[1])
	}
	if result.Entries[0].Identifier != "Good" || result.Entries[2].Identifier != "Also good" {
		t.Fatalf("identifiers = %q, %q", result.Entries[0].Identifier, result.Entries[2].Identifier)
	}
	if got := r.readType(r.investor).RecordCount; got != 2 {
		t.Fatalf("record count = %d", got)
	}
}
