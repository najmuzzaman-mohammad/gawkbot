package dataspace

import (
	"path/filepath"
	"testing"
)

// TestAwkwardRootPath pins the DSN escaping: "#" ends a URI, so a directory
// named with one used to open a database with no tables and no pragmas.
func TestAwkwardRootPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data #1 (live)")
	k := newKitAt(t, root)
	entry := k.typ("Thing")
	record := k.create(entry.ID, map[string]any{"name": "Works"})
	if k.record(record.ID).Values["name"] != "Works" {
		t.Fatalf("record did not round trip")
	}
	db, err := k.store.spaceDB(k.ctx, k.spaceID)
	if err != nil {
		t.Fatalf("spaceDB: %v", err)
	}
	var journal string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journal); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if journal != "wal" {
		t.Fatalf("journal_mode = %q, want wal", journal)
	}
	var foreignKeys int
	if err := db.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if foreignKeys != 1 {
		t.Fatalf("foreign_keys = %d, want 1", foreignKeys)
	}
}

// linkKit is two related types with two records each, the shape every
// cardinality case is checked against.
type linkKit struct {
	*kit
	candidate      string
	role           string
	a1, a2, b1, b2 string
}

func newLinkKit(t *testing.T, cardinality Cardinality) *linkKit {
	t.Helper()
	k := newKit(t)
	candidate := k.typ("Candidate")
	role := k.typ("Role")
	k.attr(candidate.ID, AttributeInput{Name: "Email", Type: TypeEmail})
	k.relate(candidate.ID, "Role", role.ID, cardinality, "Candidates")
	make := func(typeID, name string) string {
		return k.create(typeID, map[string]any{"name": name}).ID
	}
	return &linkKit{
		kit: k, candidate: candidate.ID, role: role.ID,
		a1: make(candidate.ID, "Freya"), a2: make(candidate.ID, "Kofi"),
		b1: make(role.ID, "Designer"), b2: make(role.ID, "Engineer"),
	}
}

func TestLinkValidation(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	requireEntryError(t, s.link(s.a1, "email", s.b1, false), "not a relationship")
	requireEntryError(t, s.link(s.a1, "team", s.b1, false), "Relationship attributes: role")
	requireEntryError(t, s.link(s.a1, "role", s.a2, false), "links to Role records")
	requireEntryError(t, s.link(s.a1, "role", "rec_nope", false), "Unknown record")
}

func TestLinksMapCarriesEveryRelationshipSlug(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	record := s.record(s.a1)
	if len(record.Links) != 1 {
		t.Fatalf("links = %#v", record.Links)
	}
	if refs, ok := record.Links["role"]; !ok || len(refs) != 0 {
		t.Fatalf("links.role = %#v", record.Links["role"])
	}
}

func TestManyToOne(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	s.mustLink(s.a1, "role", s.b1, false)
	s.mustLink(s.a2, "role", s.b1, false)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Designer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	if !equalStrings(s.linkNames(s.b1, "candidates"), []string{"Freya", "Kofi"}) {
		t.Fatalf("b1.candidates = %v", s.linkNames(s.b1, "candidates"))
	}

	failed := s.link(s.a1, "role", s.b2, false)
	requireEntryError(t, failed, "Freya is already linked to Designer")
	requireEntryError(t, failed, "Pass replace")
	if failed.Attribute != "role" {
		t.Fatalf("attribute = %q", failed.Attribute)
	}
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Designer"}) {
		t.Fatalf("a failed link changed state")
	}

	s.mustLink(s.a1, "role", s.b2, true)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Engineer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	if !equalStrings(s.linkNames(s.b1, "candidates"), []string{"Kofi"}) {
		t.Fatalf("b1.candidates = %v", s.linkNames(s.b1, "candidates"))
	}
	if !equalStrings(s.linkNames(s.b2, "candidates"), []string{"Freya"}) {
		t.Fatalf("b2.candidates = %v", s.linkNames(s.b2, "candidates"))
	}
}

func TestManyToOneFromTheInverseSide(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	s.mustLink(s.b1, "candidates", s.a1, false)
	s.mustLink(s.b1, "candidates", s.a2, false)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Designer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	requireEntryError(t, s.link(s.b2, "candidates", s.a1, false), "Freya is already linked to Designer")
	s.mustLink(s.b2, "candidates", s.a1, true)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Engineer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	if !equalStrings(s.linkNames(s.b1, "candidates"), []string{"Kofi"}) {
		t.Fatalf("b1.candidates = %v", s.linkNames(s.b1, "candidates"))
	}
}

func TestOneToMany(t *testing.T) {
	s := newLinkKit(t, CardinalityOneToMany)
	s.mustLink(s.a1, "role", s.b1, false)
	s.mustLink(s.a1, "role", s.b2, false)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Designer", "Engineer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	requireEntryError(t, s.link(s.a2, "role", s.b1, false), "Designer is already linked to Freya")
	s.mustLink(s.a2, "role", s.b1, true)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Engineer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	if !equalStrings(s.linkNames(s.b1, "candidates"), []string{"Kofi"}) {
		t.Fatalf("b1.candidates = %v", s.linkNames(s.b1, "candidates"))
	}
}

func TestOneToOne(t *testing.T) {
	s := newLinkKit(t, CardinalityOneToOne)
	s.mustLink(s.a1, "role", s.b1, false)
	s.mustLink(s.a2, "role", s.b2, false)
	requireEntryError(t, s.link(s.a1, "role", s.b2, false), "already linked")
	requireEntryError(t, s.link(s.b1, "candidates", s.a2, false), "already linked")
	s.mustLink(s.a1, "role", s.b2, true)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Engineer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	if len(s.linkNames(s.a2, "role")) != 0 {
		t.Fatalf("a2.role = %v", s.linkNames(s.a2, "role"))
	}
	if len(s.linkNames(s.b1, "candidates")) != 0 {
		t.Fatalf("b1.candidates = %v", s.linkNames(s.b1, "candidates"))
	}
	if !equalStrings(s.linkNames(s.b2, "candidates"), []string{"Freya"}) {
		t.Fatalf("b2.candidates = %v", s.linkNames(s.b2, "candidates"))
	}
}

func TestManyToManyNeverConflicts(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToMany)
	s.mustLink(s.a1, "role", s.b1, false)
	s.mustLink(s.a1, "role", s.b2, false)
	s.mustLink(s.a2, "role", s.b1, false)
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Designer", "Engineer"}) {
		t.Fatalf("a1.role = %v", s.linkNames(s.a1, "role"))
	}
	if !equalStrings(s.linkNames(s.b1, "candidates"), []string{"Freya", "Kofi"}) {
		t.Fatalf("b1.candidates = %v", s.linkNames(s.b1, "candidates"))
	}
}

func TestLinkIsIdempotent(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	s.mustLink(s.a1, "role", s.b1, false)
	first := s.record(s.a1)

	again := s.link(s.a1, "role", s.b1, false)
	if again.Status != StatusNoop {
		t.Fatalf("repeat link status = %q", again.Status)
	}
	if s.record(s.a1).UpdatedAt != first.UpdatedAt {
		t.Fatalf("a no-op bumped updatedAt")
	}
	inverse := s.link(s.b1, "candidates", s.a1, false)
	if inverse.Status != StatusNoop {
		t.Fatalf("inverse repeat status = %q", inverse.Status)
	}
	if len(s.linkNames(s.b1, "candidates")) != 1 {
		t.Fatalf("link was duplicated")
	}
}

func TestUnlinkIsIdempotent(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	before := s.record(s.a1)
	noop := s.unlink(s.a1, "role", s.b1)
	if noop.Status != StatusNoop {
		t.Fatalf("status = %q", noop.Status)
	}
	if s.record(s.a1).UpdatedAt != before.UpdatedAt {
		t.Fatalf("a no-op unlink bumped updatedAt")
	}

	s.mustLink(s.a1, "role", s.b1, false)
	removed := s.unlink(s.b1, "candidates", s.a1)
	if removed.Status != StatusOK {
		t.Fatalf("status = %q", removed.Status)
	}
	if len(s.linkNames(s.b1, "candidates")) != 0 || len(s.linkNames(s.a1, "role")) != 0 {
		t.Fatalf("link survived on one side")
	}
}

func TestLinkBumpsBothEndsAndTheDisplacedRecord(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	s.mustLink(s.a1, "role", s.b1, false)
	before := map[string]string{}
	for _, id := range []string{s.a1, s.a2, s.b1, s.b2} {
		before[id] = s.record(id).UpdatedAt
	}
	s.mustLink(s.a1, "role", s.b2, true)
	for _, id := range []string{s.a1, s.b1, s.b2} {
		if s.record(id).UpdatedAt <= before[id] {
			t.Fatalf("record %s was not touched", id)
		}
	}
	if s.record(s.a2).UpdatedAt != before[s.a2] {
		t.Fatalf("an uninvolved record was touched")
	}
}

func TestRecordRefNameFollowsThePrimaryValue(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToOne)
	s.mustLink(s.a1, "role", s.b1, false)
	s.update(s.b1, map[string]any{"name": "Staff Designer"})
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Staff Designer"}) {
		t.Fatalf("names = %v", s.linkNames(s.a1, "role"))
	}
	page, err := s.store.QueryRecords(s.ctx, s.actor, s.spaceID, Query{ObjectType: s.candidate})
	if err != nil {
		t.Fatalf("QueryRecords: %v", err)
	}
	if page.Records[0].Links["role"][0].Name != "Staff Designer" {
		t.Fatalf("query ref = %+v", page.Records[0].Links["role"][0])
	}
}

func TestLinkPerCallLimit(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToMany)
	inputs := make([]LinkInput, MaxLinksPerCall+1)
	for i := range inputs {
		inputs[i] = LinkInput{Record: s.a1, Attribute: "role", Target: s.b1}
	}
	_, err := s.store.Link(s.ctx, s.actor, s.spaceID, inputs)
	requireValidation(t, err, "Split the call")
	if len(s.linkNames(s.a1, "role")) != 0 {
		t.Fatalf("a rejected call wrote links")
	}
}

func TestLinkBatchIsolatesFailures(t *testing.T) {
	s := newLinkKit(t, CardinalityManyToMany)
	result, err := s.store.Link(s.ctx, s.actor, s.spaceID, []LinkInput{
		{Record: s.a1, Attribute: "role", Target: s.b1},
		{Record: s.a1, Attribute: "role", Target: "rec_nope"},
		{Record: s.a2, Attribute: "role", Target: s.b2},
	})
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	if result.Succeeded != 2 || result.Failed != 1 {
		t.Fatalf("result = %+v", result)
	}
	if !equalStrings(s.linkNames(s.a1, "role"), []string{"Designer"}) ||
		!equalStrings(s.linkNames(s.a2, "role"), []string{"Engineer"}) {
		t.Fatalf("good entries did not land")
	}
}
