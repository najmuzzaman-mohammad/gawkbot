package dataspace

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// These tests are about the failures that do not announce themselves: a file
// that was replaced, a build that is older than its data, two processes on one
// home, a delete that half happened. Each one used to end in something that
// looked like success.

// openSpaceFileDirectly opens one space database behind the store's back, the
// way a backup, a sync client or another process would.
func openSpaceFileDirectly(t *testing.T, root, spaceID string) *sql.DB {
	t.Helper()
	db, err := openDB(context.Background(), filepath.Join(root, spaceID+".db"))
	if err != nil {
		t.Fatalf("open %s directly: %v", spaceID, err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// wipeSpaceFile truncates a space database to nothing and removes its WAL, the
// end state of a kill during file creation, a cloud-sync placeholder, or a
// partial restore.
func wipeSpaceFile(t *testing.T, root, spaceID string) {
	t.Helper()
	base := filepath.Join(root, spaceID+".db")
	for _, name := range []string{base + "-wal", base + "-shm"} {
		if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("remove %s: %v", name, err)
		}
	}
	if err := os.Truncate(base, 0); err != nil {
		t.Fatalf("truncate %s: %v", base, err)
	}
	if size := fileSize(base); size != 0 {
		t.Fatalf("%s is %d bytes after truncation", base, size)
	}
}

// TestTruncatedSpaceFileIsRefusedNotReinitialised is the silent-data-loss
// test. A zero-length space file reports schema version 0, which is also what
// a brand new space reports, so the v1 DDL used to run over it and hand the
// caller a working EMPTY space — while the index still counted the records
// that were in it, and the UI rendered its honest "no records yet" state over
// the loss. Nothing in that sequence is an error, which is why it needed a
// test of its own.
func TestTruncatedSpaceFileIsRefusedNotReinitialised(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	thing := k.typ("Thing")
	k.create(thing.ID, map[string]any{"name": "One"})
	k.create(thing.ID, map[string]any{"name": "Two"})
	spaceID := k.spaceID
	if err := k.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	wipeSpaceFile(t, root, spaceID)

	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open must survive one broken space: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })

	// The space index still lists it: the row is intact, only the file is not.
	spaces, err := opened.ListSpaces(context.Background(), testOwner)
	if err != nil {
		t.Fatalf("ListSpaces: %v", err)
	}
	if len(spaces) != 1 || spaces[0].ID != spaceID {
		t.Fatalf("spaces = %+v", spaces)
	}

	_, err = opened.GetSchema(context.Background(), testOwner, spaceID)
	if err == nil {
		t.Fatalf("a wiped space read as a working empty one")
	}
	for _, want := range []string{"no schema version", "Refusing to initialise"} {
		if !contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err.Error(), want)
		}
	}
	// Refusing is not enough on its own: the file must still be untouched, so
	// a backup can be dropped back in place.
	if size := fileSize(filepath.Join(root, spaceID+".db")); size != 0 {
		t.Fatalf("the refusal wrote to the file: it is now %d bytes", size)
	}
	// Every other entry point refuses the same way rather than reading empty.
	if _, err := opened.QueryRecords(context.Background(), testOwner, spaceID,
		Query{ObjectType: thing.ID}); err == nil {
		t.Fatalf("QueryRecords served a wiped space")
	}
}

// TestIndexCountAndFileDisagreeIsRefused covers the other shape of the same
// loss: a valid v1 file with nothing in it at all, which is what a sync
// client's conflict copy or a restore taken before the space had any schema
// leaves behind. There is no version to complain about, so the witness is the
// index still counting records while the file holds no records AND no schema.
func TestIndexCountAndFileDisagreeIsRefused(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	thing := k.typ("Thing")
	k.create(thing.ID, map[string]any{"name": "One"})
	spaceID := k.spaceID
	if err := k.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Dropping the object types cascades the attributes and the records, which
	// is the state a replaced file arrives in: valid, and empty of everything.
	direct := openSpaceFileDirectly(t, root, spaceID)
	if _, err := direct.Exec(`DELETE FROM object_types`); err != nil {
		t.Fatalf("empty the file: %v", err)
	}
	if err := direct.Close(); err != nil {
		t.Fatalf("close direct handle: %v", err)
	}

	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	_, err = opened.GetSchema(context.Background(), testOwner, spaceID)
	if err == nil {
		t.Fatalf("a space whose contents vanished read as empty")
	}
	if !contains(err.Error(), "is not intact") || !contains(err.Error(), "no schema at all") {
		t.Fatalf("error = %q", err.Error())
	}
}

// TestDeletedRecordsWithSchemaIntactRepairTheCount is the other side of that
// judgement, and the reason the refusal is not simply "the file has no
// records". Deleting every record and losing the process before the second
// transaction writes the new count leaves exactly that state, and the user did
// nothing wrong; refusing there bricked a healthy space permanently. The
// schema is what separates the two, because a record cannot exist without the
// object type that shaped it, so a file that ever held records still holds one.
func TestDeletedRecordsWithSchemaIntactRepairTheCount(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	thing := k.typ("Thing")
	k.attr(thing.ID, AttributeInput{Name: "Code", Type: TypeText})
	k.create(thing.ID, map[string]any{"name": "One", "code": "a"})
	k.create(thing.ID, map[string]any{"name": "Two", "code": "b"})
	spaceID := k.spaceID

	// The delete committed to the space file...
	db, err := k.store.spaceDB(k.ctx, spaceID)
	if err != nil {
		t.Fatalf("spaceDB: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM records`); err != nil {
		t.Fatalf("delete the records: %v", err)
	}
	// ...and the process died before the index caught up.
	if _, err := k.store.index.Exec(
		`UPDATE spaces SET record_count = 2 WHERE id = ?`, spaceID); err != nil {
		t.Fatalf("leave the count behind: %v", err)
	}
	if err := k.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })

	schema, err := opened.GetSchema(context.Background(), testOwner, spaceID)
	if err != nil {
		t.Fatalf("a healthy space that was emptied refused to open: %v", err)
	}
	if len(schema.ObjectTypes) != 1 || schema.ObjectTypes[0].ID != thing.ID {
		t.Fatalf("the schema did not survive: %+v", schema.ObjectTypes)
	}
	if got := len(schema.ObjectTypes[0].Attributes); got != 2 {
		t.Fatalf("attributes = %d, want 2 (name and code)", got)
	}
	if schema.Space.RecordCount != 0 {
		t.Fatalf("record count = %d, want 0", schema.Space.RecordCount)
	}
	// The repair is durable, not just what this read computed.
	spaces, err := opened.ListSpaces(context.Background(), testOwner)
	if err != nil {
		t.Fatalf("ListSpaces: %v", err)
	}
	if len(spaces) != 1 || spaces[0].RecordCount != 0 {
		t.Fatalf("the stale count was not repaired: %+v", spaces)
	}
	// And the space still works.
	if _, err := opened.CreateRecords(context.Background(), testOwner, spaceID, thing.ID,
		[]RecordInput{{Values: map[string]any{"name": "Three", "code": "c"}}}); err != nil {
		t.Fatalf("the repaired space does not accept writes: %v", err)
	}
}

// TestNewerSchemaIsRefusedNotDowngraded. The CLI ships through npx and people
// pin older versions freely, so an old binary meeting a new file is ordinary.
// It used to restamp the version DOWNWARD and read the file with the old
// assumptions; the damage landed later, on the next upgrade, when migrations
// re-ran over rows that already had them.
func TestNewerSchemaIsRefusedNotDowngraded(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	k.typ("Thing")
	spaceID := k.spaceID
	if err := k.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	direct := openSpaceFileDirectly(t, root, spaceID)
	if _, err := direct.Exec(
		`UPDATE meta SET value = '2' WHERE key = 'schema_version'`); err != nil {
		t.Fatalf("stamp a newer version: %v", err)
	}
	if err := direct.Close(); err != nil {
		t.Fatalf("close direct handle: %v", err)
	}

	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	_, err = opened.GetSchema(context.Background(), testOwner, spaceID)
	if err == nil {
		t.Fatalf("an older build opened a newer file")
	}
	for _, want := range []string{"newer wuphf", "version 2", "understands 1"} {
		if !contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err.Error(), want)
		}
	}
	// The point of the refusal: the file is left as it was found.
	check := openSpaceFileDirectly(t, root, spaceID)
	var version string
	if err := check.QueryRow(
		`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&version); err != nil {
		t.Fatalf("read version back: %v", err)
	}
	if version != "2" {
		t.Fatalf("the version was restamped to %q; a downgrade must not write", version)
	}
}

// TestTwoStoresWriteTheSameSpace is the two-brokers-one-home case: several
// worktrees plus a prod office on one machine is the normal configuration
// here. A deferred BEGIN that upgrades a read snapshot returns
// SQLITE_BUSY_SNAPSHOT immediately, without consulting busy_timeout, and every
// write path in this package reads (loadSchema) before it writes — so roughly
// half of all writes failed, as a 500, whenever two processes overlapped.
func TestTwoStoresWriteTheSameSpace(t *testing.T) {
	root := t.TempDir()
	first := newKitAt(t, root)
	thing := first.typ("Thing")
	spaceID := first.spaceID

	second, err := Open(root)
	if err != nil {
		t.Fatalf("Open a second store on the same home: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	const perWriter = 25
	stores := []Store{first.store, second}
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		failed []error
	)
	for index, store := range stores {
		wg.Add(1)
		go func(index int, store Store) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				_, err := store.CreateRecords(context.Background(), testOwner, spaceID, thing.ID,
					[]RecordInput{{Values: map[string]any{
						"name": strings.Repeat("x", index+1) + string(rune('a'+i%26)),
					}}})
				if err != nil {
					mu.Lock()
					failed = append(failed, err)
					mu.Unlock()
					return
				}
			}
		}(index, store)
	}
	wg.Wait()
	if len(failed) > 0 {
		t.Fatalf("%d writer(s) failed against a shared home; first: %v", len(failed), failed[0])
	}
	page, err := second.QueryRecords(context.Background(), testOwner, spaceID,
		Query{ObjectType: thing.ID, Limit: 1})
	if err != nil {
		t.Fatalf("QueryRecords: %v", err)
	}
	if page.Total != len(stores)*perWriter {
		t.Fatalf("total = %d, want %d", page.Total, len(stores)*perWriter)
	}
}

// TestDeleteLeavesNoFileBehind. The row used to be dropped before the file was
// unlinked, so a crash or a read-only directory in that window left a full
// space database that nothing pointed at and nothing ever enumerated.
func TestDeleteLeavesNoFileBehind(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	thing := k.typ("Thing")
	k.create(thing.ID, map[string]any{"name": "One"})
	preview, err := k.store.PreviewDelete(k.ctx, k.actor, k.spaceID, DeleteSpace, []string{k.spaceID})
	if err != nil {
		t.Fatalf("PreviewDelete: %v", err)
	}
	if _, err := k.store.ExecuteDelete(k.ctx, k.actor, k.spaceID, preview.Token); err != nil {
		t.Fatalf("ExecuteDelete: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read root: %v", err)
	}
	for _, entry := range entries {
		if entry.Name() == indexFile {
			continue
		}
		if strings.HasPrefix(entry.Name(), indexFile) {
			// spaces.db-wal / -shm.
			continue
		}
		t.Fatalf("%s survived the delete", entry.Name())
	}
	// And the mutex the space held is gone with it.
	if _, ok := k.store.locks.Load(k.spaceID); ok {
		t.Fatalf("the deleted space still holds a mutex")
	}
}

// TestOneBrokenSpaceDoesNotBlockTheOthers. Open touches every indexed space to
// reconcile its counts, so "a broken file is isolated" stopped being something
// to reason about and became something to check.
//
// The load-bearing assertion is that Open ITSELF succeeds. Healthy spaces open
// on demand whether or not the startup pass reached them, so their working is
// necessary but not sufficient; if the pass returned its error instead of
// logging it, one wiped file would take the entire store down at startup and
// every space would be unreachable. The reconcile counters pin the other half:
// the pass stepped over the broken space and kept going.
func TestOneBrokenSpaceDoesNotBlockTheOthers(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	ids := []string{k.spaceID}
	for i := 0; i < 2; i++ {
		space, err := k.store.CreateSpace(k.ctx, testOwner, "Another", "", Access{Scope: ScopePrivate})
		if err != nil {
			t.Fatalf("CreateSpace: %v", err)
		}
		ids = append(ids, space.ID)
	}
	healthy := ids[1:]
	for _, id := range healthy {
		result, err := k.store.CreateObjectTypes(k.ctx, testOwner, id, []ObjectTypeInput{{Name: "Thing"}})
		if err != nil || result.Failed != 0 {
			t.Fatalf("CreateObjectTypes on %s: %v %+v", id, err, result.Entries)
		}
	}
	broken := ids[0]
	if err := k.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	wipeSpaceFile(t, root, broken)

	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open must survive one broken space, it took the whole store down: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })

	// The startup pass reached every healthy space despite the broken one
	// sitting somewhere in the (unordered) list.
	concrete, ok := opened.(*store)
	if !ok {
		t.Fatalf("Open returned %T, want *store", opened)
	}
	reconciled, gaveUp := concrete.reconcileCounts(context.Background())
	if gaveUp {
		t.Fatalf("the startup pass gave up rather than stepping over the broken space")
	}
	if reconciled != len(healthy) {
		t.Fatalf("the pass reconciled %d spaces, want %d: it stopped at the broken one "+
			"instead of continuing", reconciled, len(healthy))
	}

	for _, id := range healthy {
		schema, schemaErr := opened.GetSchema(context.Background(), testOwner, id)
		if schemaErr != nil {
			t.Fatalf("a healthy space %s was taken down by a broken sibling: %v", id, schemaErr)
		}
		if len(schema.ObjectTypes) != 1 {
			t.Fatalf("space %s lost its schema: %+v", id, schema.ObjectTypes)
		}
		if _, err := opened.CreateRecords(context.Background(), testOwner, id,
			schema.ObjectTypes[0].ID,
			[]RecordInput{{Values: map[string]any{"name": "One"}}}); err != nil {
			t.Fatalf("a healthy space %s cannot be written: %v", id, err)
		}
	}
	if _, err := opened.GetSchema(context.Background(), testOwner, broken); err == nil {
		t.Fatalf("the broken space opened after all")
	}
}

// TestStartupReconcileIsBounded. The startup pass is the one place that
// touches every space on disk, so a file on a stalled mount could hold up the
// whole broker — a store that cannot finish opening is worse than a space that
// cannot open. A cancelled context stands in for the stall: the pass must give
// up rather than work through the list.
func TestStartupReconcileIsBounded(t *testing.T) {
	k := newKit(t)
	for i := 0; i < 3; i++ {
		if _, err := k.store.CreateSpace(k.ctx, testOwner, "Another", "", Access{Scope: ScopePrivate}); err != nil {
			t.Fatalf("CreateSpace: %v", err)
		}
	}
	k.store.mu.Lock()
	for id, db := range k.store.dbs {
		_ = db.Close()
		delete(k.store.dbs, id)
		delete(k.store.used, id)
	}
	k.store.mu.Unlock()

	// A healthy run reaches every space, so the counters mean something.
	if reconciled, gaveUp := k.store.reconcileCounts(context.Background()); gaveUp || reconciled != 4 {
		t.Fatalf("a healthy pass reconciled %d spaces (gaveUp=%v), want 4 and false",
			reconciled, gaveUp)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	type outcome struct {
		done   int
		gaveUp bool
	}
	result := make(chan outcome, 1)
	go func() {
		done, gaveUp := k.store.reconcileCounts(ctx)
		result <- outcome{done, gaveUp}
	}()
	var got outcome
	select {
	case got = <-result:
	case <-time.After(5 * time.Second):
		t.Fatalf("reconcileCounts ignored a cancelled context; a stalled file would hang startup")
	}
	// Bailing at the loop guard and grinding through every space one failure at
	// a time both finish instantly here, and only the first bounds a real
	// stall — so the distinction is the assertion.
	if !got.gaveUp {
		t.Fatalf("the pass worked through the whole list on a cancelled context " +
			"instead of giving up; nothing would bound a stalled file")
	}
	if got.done != 0 {
		t.Fatalf("the pass reconciled %d spaces after its budget was spent", got.done)
	}
	// Giving up early must leave the store usable: the spaces it did not reach
	// are reconciled by the first call that opens them.
	if _, err := k.store.GetSchema(k.ctx, testOwner, k.spaceID); err != nil {
		t.Fatalf("the store is unusable after an abandoned reconcile: %v", err)
	}
}

// TestAnInterruptedDeleteDoesNotStrandTheFile drives the window the ordering
// exists for: a delete that cannot unlink. Dropping the row first meant the
// row went, the unlink failed, and a full space database stayed on disk with
// nothing pointing at it — unreachable, and never enumerated by anything.
// Retiring the file first makes the same failure recoverable: either the whole
// delete happens or the space is still there.
func TestAnInterruptedDeleteDoesNotStrandTheFile(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	thing := k.typ("Thing")
	k.create(thing.ID, map[string]any{"name": "One"})
	path := k.store.spacePath(k.spaceID)
	if fileSize(path) <= 0 {
		t.Fatalf("no space file to begin with")
	}
	// A home that has gone read-only: the rows can still be written, the
	// directory entries cannot.
	if err := os.Chmod(root, 0o500); err != nil {
		t.Fatalf("chmod %s: %v", root, err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, dirMode) })
	if err := os.WriteFile(filepath.Join(root, "probe"), []byte("x"), fileMode); err == nil {
		t.Skip("the directory is still writable (running as root?), so this cannot be driven")
	}

	err := k.store.removeSpace(k.ctx, k.spaceID)
	if err == nil {
		t.Fatalf("removeSpace reported success on a read-only directory")
	}
	// Whatever failed, the space must be in one piece: file present AND listed.
	if got := fileSize(path); got <= 0 {
		t.Fatalf("the space file is gone or retired (%d bytes)", got)
	}
	spaces, listErr := k.store.ListSpaces(k.ctx, testOwner)
	if listErr != nil {
		t.Fatalf("ListSpaces: %v", listErr)
	}
	if len(spaces) != 1 || spaces[0].ID != k.spaceID {
		t.Fatalf("the row was dropped while %s is still on disk: the space is now "+
			"unreachable and nothing will ever enumerate it (spaces = %+v)", path, spaces)
	}
}

// TestOpenSweepsTombstonesAndReportsOrphans. A tombstone is a delete that was
// interrupted after its row was dropped, so the bytes are already unreachable
// and clearing them is safe. A space file with no row is not the same thing —
// it might be a restore in progress — so it is reported and left alone.
func TestOpenSweepsTombstonesAndReportsOrphans(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	if err := k.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	tomb := filepath.Join(root, "space_0011223344556677.db.deleted-20260918T120000.000")
	orphan := filepath.Join(root, "space_8899aabbccddeeff.db")
	for _, path := range []string{tomb, orphan} {
		if err := os.WriteFile(path, []byte("not really a database"), fileMode); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	if fileSize(tomb) >= 0 {
		t.Fatalf("the tombstone survived the sweep")
	}
	if fileSize(orphan) < 0 {
		t.Fatalf("the sweep deleted an orphan; unreachable data is still data")
	}
}

// TestStaleCountsAreRepaired. The denormalized counts are written in a second
// transaction after the space's own, so a crash in that window left
// ListSpaces serving a wrong number with nothing to repair it.
func TestStaleCountsAreRepaired(t *testing.T) {
	root := t.TempDir()
	k := newKitAt(t, root)
	thing := k.typ("Thing")
	k.create(thing.ID, map[string]any{"name": "One"})
	k.create(thing.ID, map[string]any{"name": "Two"})
	spaceID := k.spaceID
	// The shape a crash between the two commits leaves: the file moved on, the
	// index did not.
	if _, err := k.store.index.Exec(
		`UPDATE spaces SET record_count = 9, object_type_count = 4 WHERE id = ?`, spaceID); err != nil {
		t.Fatalf("stale the counts: %v", err)
	}
	if err := k.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	spaces, err := opened.ListSpaces(context.Background(), testOwner)
	if err != nil {
		t.Fatalf("ListSpaces: %v", err)
	}
	if len(spaces) != 1 {
		t.Fatalf("spaces = %+v", spaces)
	}
	if spaces[0].RecordCount != 2 || spaces[0].ObjectTypeCount != 1 {
		t.Fatalf("counts = %d types / %d records, want 1 / 2",
			spaces[0].ObjectTypeCount, spaces[0].RecordCount)
	}
	_ = thing
}

// TestDeniedCallsDoNotGrowTheMutexMap. lockFor allocates on the raw id it is
// handed, so taking the lock before checking access meant a run of denied
// calls on ids that name nothing left one mutex behind each, forever.
func TestDeniedCallsDoNotGrowTheMutexMap(t *testing.T) {
	k := newKit(t)
	for i := 0; i < 500; i++ {
		id := "space_" + strings.Repeat("0", 15) + string(rune('a'+i%16))
		if _, err := k.store.GetSchema(k.ctx, "stranger", id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("GetSchema on %s = %v, want ErrNotFound", id, err)
		}
	}
	// Denied calls on a space that DOES exist must not grow it either.
	for i := 0; i < 500; i++ {
		if _, err := k.store.GetSchema(k.ctx, "stranger", k.spaceID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("GetSchema = %v, want ErrNotFound", err)
		}
	}
	held := 0
	k.store.locks.Range(func(key, _ any) bool {
		held++
		if key != k.spaceID {
			t.Errorf("a mutex is held for %v, which no caller may see", key)
		}
		return true
	})
	if held > 1 {
		t.Fatalf("%d mutexes held after 1000 denied calls, want at most 1", held)
	}
}

// TestAbandonedPreviewsAreReclaimed. A preview is how a bot finds out what a
// delete would cost; most are never executed, and only executing that exact
// token used to remove its binding.
func TestAbandonedPreviewsAreReclaimed(t *testing.T) {
	d := newDeleteKit(t)
	for i := 0; i < 20; i++ {
		d.mustPreview(DeleteRecords, d.m1)
	}
	if got := len(d.store.tokens); got != 20 {
		t.Fatalf("live tokens = %d, want 20", got)
	}
	// Past the window, the next preview clears them.
	d.clock.advance(DeleteTokenTTL + time.Minute)
	d.mustPreview(DeleteRecords, d.m1)
	if got := len(d.store.tokens); got != 1 {
		t.Fatalf("live tokens = %d after expiry, want 1", got)
	}
}

// TestLivePreviewsAreCapped drives the pruning directly. Expiry alone is not a
// bound — nothing stops a caller previewing faster than tokens age out — so
// the cap has to hold on live ones too, and the oldest are the ones to drop.
// The end-to-end path is covered by TestAbandonedPreviewsAreReclaimed above;
// filling the map here keeps this about the rule and not about 1050
// transactions.
func TestLivePreviewsAreCapped(t *testing.T) {
	k := newKit(t)
	base := k.store.now().UTC()
	newest := ""
	for i := 0; i < MaxLiveDeleteTokens+50; i++ {
		token := newID(prefixToken)
		if i == MaxLiveDeleteTokens+49 {
			newest = token
		}
		k.store.tokens[token] = deleteBinding{
			spaceID:   k.spaceID,
			kind:      DeleteRecords,
			expiresAt: base.Add(time.Duration(i) * time.Second).Add(DeleteTokenTTL),
		}
	}
	k.store.tokenMu.Lock()
	k.store.pruneTokensLocked()
	k.store.tokenMu.Unlock()

	if got := len(k.store.tokens); got >= MaxLiveDeleteTokens {
		t.Fatalf("live tokens = %d, want under the %d cap so the next preview fits",
			got, MaxLiveDeleteTokens)
	}
	// Dropping the oldest is the point: a token someone is about to present
	// must outlive one abandoned twenty minutes ago.
	if _, ok := k.store.tokens[newest]; !ok {
		t.Fatalf("the newest preview was dropped instead of the oldest")
	}
	// And an expired token goes regardless of the cap.
	expired := newID(prefixToken)
	k.store.tokens[expired] = deleteBinding{spaceID: k.spaceID, expiresAt: base.Add(-time.Second)}
	k.store.tokenMu.Lock()
	k.store.pruneTokensLocked()
	k.store.tokenMu.Unlock()
	if _, ok := k.store.tokens[expired]; ok {
		t.Fatalf("an expired token survived the sweep")
	}
}

// TestOpenHandlesAreCapped. Each cached handle costs three descriptors — the
// database, its WAL and its SHM — and nothing gave one back.
func TestOpenHandlesAreCapped(t *testing.T) {
	k := newKit(t)
	for i := 0; i < maxOpenSpaceDBs+8; i++ {
		space, err := k.store.CreateSpace(k.ctx, testOwner, "Space", "", Access{Scope: ScopePrivate})
		if err != nil {
			t.Fatalf("CreateSpace %d: %v", i, err)
		}
		if _, err := k.store.GetSchema(k.ctx, testOwner, space.ID); err != nil {
			t.Fatalf("GetSchema %d: %v", i, err)
		}
	}
	k.store.mu.Lock()
	open := len(k.store.dbs)
	k.store.mu.Unlock()
	if open > maxOpenSpaceDBs {
		t.Fatalf("%d handles open, want at most %d", open, maxOpenSpaceDBs)
	}
	// Evicting must not lose anything: an evicted space reopens and reads.
	spaces, err := k.store.ListSpaces(k.ctx, testOwner)
	if err != nil {
		t.Fatalf("ListSpaces: %v", err)
	}
	if _, err := k.store.GetSchema(k.ctx, testOwner, spaces[0].ID); err != nil {
		t.Fatalf("the first space did not reopen: %v", err)
	}
}

// TestQueryAndValueCaps. Every filter is evaluated against every record and
// the needle against every text-like value, so an uncapped request pins the
// space lock; an uncapped value costs every later read of that record.
func TestQueryAndValueCaps(t *testing.T) {
	k := newKit(t)
	thing := k.typ("Thing")
	k.attr(thing.ID, AttributeInput{Name: "Notes", Type: TypeText})

	filters := make([]Filter, 0, MaxFiltersPerQuery+1)
	for i := 0; i <= MaxFiltersPerQuery; i++ {
		filters = append(filters, Filter{Attribute: "name", Operator: OpContains, Value: "x"})
	}
	_, err := k.store.QueryRecords(k.ctx, k.actor, k.spaceID,
		Query{ObjectType: thing.ID, Filters: filters})
	requireValidation(t, err, "at most 20 filters")

	_, err = k.store.QueryRecords(k.ctx, k.actor, k.spaceID,
		Query{ObjectType: thing.ID, Search: strings.Repeat("n", MaxSearchBytes+1)})
	requireValidation(t, err, "at most 256 characters")

	// Just inside both caps still works.
	if _, err := k.store.QueryRecords(k.ctx, k.actor, k.spaceID, Query{
		ObjectType: thing.ID,
		Filters:    filters[:MaxFiltersPerQuery],
		Search:     strings.Repeat("n", MaxSearchBytes),
	}); err != nil {
		t.Fatalf("a query inside the caps failed: %v", err)
	}

	failed := k.createError(thing.ID, map[string]any{
		"name":  "Big",
		"notes": strings.Repeat("z", MaxValueBytes+1),
	})
	requireEntryError(t, failed, "one value holds at most")
	if failed.Attribute != "notes" {
		t.Fatalf("entry = %+v", failed)
	}
	if got := k.readType(thing.ID).RecordCount; got != 0 {
		t.Fatalf("an over-size value still wrote a record: %d", got)
	}
}

// TestBatchSequencesStayOrdered guards the hoist behind writeCursor: the
// record count and the next sequence number are read once per transaction now
// instead of once per row, so a batch must still number its rows the way a run
// of single writes would.
func TestBatchSequencesStayOrdered(t *testing.T) {
	k := newKit(t)
	thing := k.typ("Thing")
	inputs := make([]RecordInput, 0, 8)
	for i := 0; i < 8; i++ {
		inputs = append(inputs, RecordInput{Values: map[string]any{
			"name": string(rune('a' + i)),
		}})
	}
	result, err := k.store.CreateRecords(k.ctx, k.actor, k.spaceID, thing.ID, inputs)
	if err != nil {
		t.Fatalf("CreateRecords: %v", err)
	}
	if result.Failed != 0 {
		t.Fatalf("entries = %+v", result.Entries)
	}
	// A second batch continues where the first stopped, and one more single
	// write after that continues again: the cursor is per transaction, so the
	// next one has to re-read the maximum rather than restart from zero.
	if _, err := k.store.CreateRecords(k.ctx, k.actor, k.spaceID, thing.ID, inputs); err != nil {
		t.Fatalf("second batch: %v", err)
	}
	k.create(thing.ID, map[string]any{"name": "last"})

	db, err := k.store.spaceDB(k.ctx, k.spaceID)
	if err != nil {
		t.Fatalf("spaceDB: %v", err)
	}
	rows, err := db.Query(`SELECT seq FROM records ORDER BY seq`)
	if err != nil {
		t.Fatalf("read seqs: %v", err)
	}
	defer closeRows(rows)
	seen := []int{}
	for rows.Next() {
		var seq int
		if err := rows.Scan(&seq); err != nil {
			t.Fatalf("scan seq: %v", err)
		}
		seen = append(seen, seq)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read seqs: %v", err)
	}
	if len(seen) != 17 {
		t.Fatalf("%d records, want 17", len(seen))
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] <= seen[i-1] {
			t.Fatalf("seq %d is not above %d: a batch reused a sequence number",
				seen[i], seen[i-1])
		}
	}
	if got := k.readType(thing.ID).RecordCount; got != 17 {
		t.Fatalf("record count = %d, want 17", got)
	}
}
