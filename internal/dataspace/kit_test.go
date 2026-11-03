package dataspace

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// testClock advances a second every time it is read, so timestamps in a test
// are strictly increasing the way the TypeScript mock's test clock makes them.
type testClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(time.Second)
	return c.at
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

// kit is a store on a fresh directory with one empty space owned by "cos",
// mirroring createTestKit() in web/src/api/dataspaces.mock.testkit.ts.
type kit struct {
	t       *testing.T
	ctx     context.Context
	store   *store
	clock   *testClock
	root    string
	spaceID string
	actor   Actor
}

const testOwner Actor = "cos"

func newKit(t *testing.T) *kit {
	t.Helper()
	return newKitAt(t, t.TempDir())
}

func newKitAt(t *testing.T, root string) *kit {
	t.Helper()
	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	concrete, ok := opened.(*store)
	if !ok {
		t.Fatalf("Open returned %T, want *store", opened)
	}
	clock := &testClock{at: time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)}
	concrete.now = clock.now
	k := &kit{
		t: t, ctx: context.Background(), store: concrete,
		clock: clock, root: root, actor: testOwner,
	}
	t.Cleanup(func() { _ = concrete.Close() })
	space, err := opened.CreateSpace(k.ctx, testOwner, "Test space", "", Access{Scope: ScopePrivate})
	if err != nil {
		t.Fatalf("CreateSpace: %v", err)
	}
	k.spaceID = space.ID
	return k
}

// reopen closes the store and opens a new one on the same directory, which is
// how the tests prove a space survives a restart.
func (k *kit) reopen() *kit {
	k.t.Helper()
	if err := k.store.Close(); err != nil {
		k.t.Fatalf("Close: %v", err)
	}
	opened, err := Open(k.root)
	if err != nil {
		k.t.Fatalf("reopen: %v", err)
	}
	concrete, ok := opened.(*store)
	if !ok {
		k.t.Fatalf("Open returned %T, want *store", opened)
	}
	concrete.now = k.clock.now
	next := &kit{
		t: k.t, ctx: k.ctx, store: concrete, clock: k.clock,
		root: k.root, spaceID: k.spaceID, actor: k.actor,
	}
	k.t.Cleanup(func() { _ = concrete.Close() })
	return next
}

func (k *kit) typ(name string) ObjectType {
	k.t.Helper()
	return k.typeWith(ObjectTypeInput{Name: name})
}

func (k *kit) typeWith(input ObjectTypeInput) ObjectType {
	k.t.Helper()
	result, err := k.store.CreateObjectTypes(k.ctx, k.actor, k.spaceID, []ObjectTypeInput{input})
	if err != nil {
		k.t.Fatalf("CreateObjectTypes(%q): %v", input.Name, err)
	}
	if result.Failed != 0 {
		k.t.Fatalf("CreateObjectTypes(%q): %s", input.Name, result.Entries[0].Error)
	}
	return k.readType(result.Entries[0].ID)
}

// typeError expects the single entry of a CreateObjectTypes call to fail.
func (k *kit) typeError(input ObjectTypeInput) Entry {
	k.t.Helper()
	result, err := k.store.CreateObjectTypes(k.ctx, k.actor, k.spaceID, []ObjectTypeInput{input})
	if err != nil {
		k.t.Fatalf("CreateObjectTypes: unexpected call error: %v", err)
	}
	if result.Failed != 1 {
		k.t.Fatalf("CreateObjectTypes(%q): expected a failure, got %+v", input.Name, result)
	}
	return result.Entries[0]
}

func (k *kit) attr(typeID string, input AttributeInput) Attribute {
	k.t.Helper()
	result, err := k.store.AddAttributes(k.ctx, k.actor, k.spaceID, typeID, []AttributeInput{input})
	if err != nil {
		k.t.Fatalf("AddAttributes(%q): %v", input.Name, err)
	}
	if result.Failed != 0 {
		k.t.Fatalf("AddAttributes(%q): %s", input.Name, result.Entries[0].Error)
	}
	attr := k.findAttr(typeID, result.Entries[0].ID)
	if attr == nil {
		k.t.Fatalf("AddAttributes(%q): attribute not in schema", input.Name)
	}
	return *attr
}

// attrError expects the single entry of an AddAttributes call to fail.
func (k *kit) attrError(typeID string, input AttributeInput) Entry {
	k.t.Helper()
	result, err := k.store.AddAttributes(k.ctx, k.actor, k.spaceID, typeID, []AttributeInput{input})
	if err != nil {
		k.t.Fatalf("AddAttributes: unexpected call error: %v", err)
	}
	if result.Failed != 1 {
		k.t.Fatalf("AddAttributes(%q): expected a failure, got %+v", input.Name, result)
	}
	return result.Entries[0]
}

func (k *kit) relate(typeID, name, target string, cardinality Cardinality, inverse string) Attribute {
	k.t.Helper()
	return k.attr(typeID, AttributeInput{
		Name: name, Type: TypeRelationship,
		Relationship: &RelationshipInput{Target: target, Cardinality: cardinality, InverseName: inverse},
	})
}

func (k *kit) relateError(typeID, name, target string, cardinality Cardinality, inverse string) Entry {
	k.t.Helper()
	return k.attrError(typeID, AttributeInput{
		Name: name, Type: TypeRelationship,
		Relationship: &RelationshipInput{Target: target, Cardinality: cardinality, InverseName: inverse},
	})
}

func (k *kit) schema() Schema {
	k.t.Helper()
	schema, err := k.store.GetSchema(k.ctx, k.actor, k.spaceID)
	if err != nil {
		k.t.Fatalf("GetSchema: %v", err)
	}
	return schema
}

func (k *kit) readType(typeID string) ObjectType {
	k.t.Helper()
	for _, entry := range k.schema().ObjectTypes {
		if entry.ID == typeID {
			return entry
		}
	}
	k.t.Fatalf("object type %s not in schema", typeID)
	return ObjectType{}
}

func (k *kit) findAttr(typeID, attributeID string) *Attribute {
	k.t.Helper()
	entry := k.readType(typeID)
	for index := range entry.Attributes {
		if entry.Attributes[index].ID == attributeID {
			return &entry.Attributes[index]
		}
	}
	return nil
}

func (k *kit) attrSlugs(typeID string) []string {
	k.t.Helper()
	entry := k.readType(typeID)
	slugs := make([]string, 0, len(entry.Attributes))
	for _, attr := range entry.Attributes {
		slugs = append(slugs, attr.Slug)
	}
	return slugs
}

func (k *kit) optionID(typeID, slug, name string) string {
	k.t.Helper()
	for _, attr := range k.readType(typeID).Attributes {
		if attr.Slug != slug {
			continue
		}
		for _, option := range attr.Options {
			if option.Name == name {
				return option.ID
			}
		}
	}
	k.t.Fatalf("no option %q on %s.%s", name, typeID, slug)
	return ""
}

func (k *kit) create(typeID string, values map[string]any) Record {
	k.t.Helper()
	result, err := k.store.CreateRecords(k.ctx, k.actor, k.spaceID, typeID, []RecordInput{{Values: values}})
	if err != nil {
		k.t.Fatalf("CreateRecords: %v", err)
	}
	if result.Failed != 0 {
		k.t.Fatalf("CreateRecords: %s", result.Entries[0].Error)
	}
	return k.record(result.Entries[0].ID)
}

// createError expects the single entry of a CreateRecords call to fail.
func (k *kit) createError(typeID string, values map[string]any) Entry {
	k.t.Helper()
	result, err := k.store.CreateRecords(k.ctx, k.actor, k.spaceID, typeID, []RecordInput{{Values: values}})
	if err != nil {
		k.t.Fatalf("CreateRecords: unexpected call error: %v", err)
	}
	if result.Failed != 1 {
		k.t.Fatalf("CreateRecords: expected a failure, got %+v", result)
	}
	return result.Entries[0]
}

func (k *kit) record(recordID string) Record {
	k.t.Helper()
	record, err := k.store.GetRecord(k.ctx, k.actor, k.spaceID, recordID)
	if err != nil {
		k.t.Fatalf("GetRecord(%s): %v", recordID, err)
	}
	return record
}

func (k *kit) update(recordID string, values map[string]any) Record {
	k.t.Helper()
	record, err := k.store.UpdateRecord(k.ctx, k.actor, k.spaceID, recordID, values)
	if err != nil {
		k.t.Fatalf("UpdateRecord(%s): %v", recordID, err)
	}
	return record
}

func (k *kit) link(recordID, attribute, target string, replace bool) Entry {
	k.t.Helper()
	result, err := k.store.Link(k.ctx, k.actor, k.spaceID, []LinkInput{
		{Record: recordID, Attribute: attribute, Target: target, Replace: replace},
	})
	if err != nil {
		k.t.Fatalf("Link: unexpected call error: %v", err)
	}
	return result.Entries[0]
}

func (k *kit) mustLink(recordID, attribute, target string, replace bool) Entry {
	k.t.Helper()
	entry := k.link(recordID, attribute, target, replace)
	if entry.Status == StatusFailed {
		k.t.Fatalf("Link(%s, %s, %s): %s", recordID, attribute, target, entry.Error)
	}
	return entry
}

func (k *kit) unlink(recordID, attribute, target string) Entry {
	k.t.Helper()
	result, err := k.store.Unlink(k.ctx, k.actor, k.spaceID, []LinkInput{
		{Record: recordID, Attribute: attribute, Target: target},
	})
	if err != nil {
		k.t.Fatalf("Unlink: unexpected call error: %v", err)
	}
	return result.Entries[0]
}

func (k *kit) linkNames(recordID, slug string) []string {
	k.t.Helper()
	refs := k.record(recordID).Links[slug]
	names := make([]string, 0, len(refs))
	for _, ref := range refs {
		names = append(names, ref.Name)
	}
	return names
}

func (k *kit) space() Space {
	k.t.Helper()
	spaces, err := k.store.ListSpaces(k.ctx, k.actor)
	if err != nil {
		k.t.Fatalf("ListSpaces: %v", err)
	}
	for _, space := range spaces {
		if space.ID == k.spaceID {
			return space
		}
	}
	k.t.Fatalf("space %s not listed", k.spaceID)
	return Space{}
}

// ── assertions ───────────────────────────────────────────────────

func requireValidation(t *testing.T, err error, want string) *ValidationError {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a validation error containing %q, got nil", want)
	}
	var invalid *ValidationError
	if !errors.As(err, &invalid) {
		t.Fatalf("expected *ValidationError containing %q, got %T: %v", want, err, err)
	}
	if want != "" && !contains(invalid.Message, want) {
		t.Fatalf("error %q does not contain %q", invalid.Message, want)
	}
	return invalid
}

func requireEntryError(t *testing.T, entry Entry, want string) {
	t.Helper()
	if entry.Status != StatusFailed {
		t.Fatalf("expected a failed entry, got %+v", entry)
	}
	if want != "" && !contains(entry.Error, want) {
		t.Fatalf("entry error %q does not contain %q", entry.Error, want)
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
