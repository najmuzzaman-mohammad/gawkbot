package dataspace

import (
	"sync"
	"testing"
)

// TestConcurrentUpsertKeepsOneRecord is the test the UNIQUE index exists for:
// many callers upserting the same match value at once must end with exactly
// one record, not one per caller that won the check-then-insert race.
func TestConcurrentUpsertKeepsOneRecord(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Investor")
	k.attr(entry.ID, AttributeInput{Name: "Email", Type: TypeEmail, IsUnique: true})

	const writers = 12
	var wg sync.WaitGroup
	var mu sync.Mutex
	failures := []string{}
	wg.Add(writers)
	for i := 0; i < writers; i++ {
		go func(index int) {
			defer wg.Done()
			result, err := k.store.UpsertRecords(k.ctx, k.actor, k.spaceID, entry.ID, "email",
				[]RecordInput{{Values: map[string]any{
					"name":  "Mirela " + itoa(index),
					"email": "MIRELA@tidewrack.example",
				}}})
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failures = append(failures, err.Error())
				return
			}
			if result.Failed != 0 {
				failures = append(failures, result.Entries[0].Error)
			}
		}(i)
	}
	wg.Wait()
	if len(failures) != 0 {
		t.Fatalf("upserts failed: %v", failures)
	}
	if got := k.readType(entry.ID).RecordCount; got != 1 {
		t.Fatalf("record count = %d, want 1", got)
	}
}

// TestConcurrentUniqueAcrossStores drives two Store instances at one directory,
// which have separate locks, so only the UNIQUE index can stop a duplicate.
func TestConcurrentUniqueAcrossStores(t *testing.T) {
	root := t.TempDir()
	first := newKitAt(t, root)
	entry := first.typ("Investor")
	first.attr(entry.ID, AttributeInput{Name: "Email", Type: TypeEmail, IsUnique: true})

	opened, err := Open(root)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })

	const writers = 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	succeeded := 0
	wg.Add(writers)
	for i := 0; i < writers; i++ {
		target := Store(first.store)
		if i%2 == 1 {
			target = opened
		}
		go func(store Store, index int) {
			defer wg.Done()
			result, createErr := store.CreateRecords(first.ctx, first.actor, first.spaceID, entry.ID,
				[]RecordInput{{Values: map[string]any{
					"name":  "Mirela " + itoa(index),
					"email": "mirela@tidewrack.example",
				}}})
			mu.Lock()
			defer mu.Unlock()
			if createErr != nil {
				t.Errorf("CreateRecords: %v", createErr)
				return
			}
			if result.Failed == 0 {
				succeeded++
				return
			}
			if !contains(result.Entries[0].Error, "must be unique") {
				t.Errorf("unexpected failure: %s", result.Entries[0].Error)
			}
		}(target, i)
	}
	wg.Wait()
	if succeeded != 1 {
		t.Fatalf("%d writers succeeded, want exactly 1", succeeded)
	}
	if got := first.readType(entry.ID).RecordCount; got != 1 {
		t.Fatalf("record count = %d, want 1", got)
	}
}

// TestConcurrentReadsAndWrites is a race-detector exercise over mixed traffic.
func TestConcurrentReadsAndWrites(t *testing.T) {
	k := newKit(t)
	entry := k.typ("Thing")
	k.attr(entry.ID, AttributeInput{Name: "Memo", Type: TypeText})

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func(index int) {
			defer wg.Done()
			if _, err := k.store.CreateRecords(k.ctx, k.actor, k.spaceID, entry.ID,
				[]RecordInput{{Values: map[string]any{"name": "Row " + itoa(index)}}}); err != nil {
				t.Errorf("CreateRecords: %v", err)
			}
		}(i)
		go func() {
			defer wg.Done()
			if _, err := k.store.QueryRecords(k.ctx, k.actor, k.spaceID, Query{ObjectType: entry.ID}); err != nil {
				t.Errorf("QueryRecords: %v", err)
			}
			if _, err := k.store.ListSpaces(k.ctx, k.actor); err != nil {
				t.Errorf("ListSpaces: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := k.readType(entry.ID).RecordCount; got != 8 {
		t.Fatalf("record count = %d, want 8", got)
	}
}
