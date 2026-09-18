package dataspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver, no cgo

	"github.com/nex-crm/wuphf/internal/config"
)

// Limits, as the spec states them. Exceeding a per-call limit is one error for
// the whole call; the per-space limits are reported against the entry that hit
// them, so the rest of a batch still lands.
const (
	MaxObjectTypesPerSpace = 50
	MaxAttributesPerType   = 100
	MaxRecordsPerCall      = 1000
	MaxLinksPerCall        = 100
	MaxRecordsPerSpace     = 100000
	// MaxFiltersPerQuery, MaxSearchBytes and MaxValueBytes bound one request's
	// work. Without them a single call can pin the space lock for seconds or
	// hold megabytes per value, which is a denial of service a bot reaches by
	// accident as easily as on purpose.
	MaxFiltersPerQuery = 20
	MaxSearchBytes     = 256
	MaxValueBytes      = 64 * 1024
)

// maxOpenSpaceDBs caps the cached handles. Each one costs three descriptors
// (database, WAL, SHM), so an office that has touched many spaces would
// otherwise run a process out of them and never give one back.
const maxOpenSpaceDBs = 64

// txBeginAttempts is how many times a write transaction re-tries its BEGIN
// when another process holds the write lock. Only the BEGIN is retried:
// nothing has run at that point, so a retry cannot repeat a partial effect.
const txBeginAttempts = 5

// schemaVersion is the current shape of a space database. migrate() walks from
// whatever meta.schema_version says up to this number.
const schemaVersion = 1

// indexFile is the space index; it can never collide with a space database
// because every space id starts with "space_".
const indexFile = "spaces.db"

const (
	dirMode  os.FileMode = 0o700
	fileMode os.FileMode = 0o600
)

// timestampLayout matches Date.toISOString() in the mock, so timestamps sort
// as strings and read the same on both sides of the wire.
const timestampLayout = "2006-01-02T15:04:05.000Z"

// store is the SQLite implementation of Store.
type store struct {
	root string
	now  func() time.Time

	index *sql.DB

	// mu guards dbs and used. A space database is opened once and kept open;
	// the handle pool is capped at one connection, so WAL stays simple, and at
	// maxOpenSpaceDBs handles, so a long-lived process gives descriptors back.
	mu   sync.Mutex
	dbs  map[string]*sql.DB
	used map[string]time.Time

	// locks holds one mutex per space id. Every public call takes its space's
	// lock, which serializes writers inside this process; busy_timeout and the
	// UNIQUE indexes cover writers in another one.
	locks sync.Map // map[string]*sync.Mutex

	// tokens holds the live delete previews. They are deliberately in memory:
	// a token is a 15 minute confirmation handle, not durable state, and a
	// restart should invalidate every outstanding one.
	tokenMu sync.Mutex
	tokens  map[string]deleteBinding
}

// New opens the store under <config.RuntimeHomeDir()>/.wuphf/data.
func New() (Store, error) {
	home := strings.TrimSpace(config.RuntimeHomeDir())
	if home == "" {
		return nil, errors.New("dataspace: no runtime home directory")
	}
	return Open(filepath.Join(home, ".wuphf", "data"))
}

// Open opens (creating it if needed) the store rooted at root.
func Open(root string) (Store, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("dataspace: empty root directory")
	}
	if err := os.MkdirAll(root, dirMode); err != nil {
		return nil, fmt.Errorf("dataspace: create %s: %w", root, err)
	}
	s := &store{
		root:   root,
		now:    func() time.Time { return time.Now().UTC() },
		dbs:    map[string]*sql.DB{},
		used:   map[string]time.Time{},
		tokens: map[string]deleteBinding{},
	}
	// The index is opened unbounded on purpose: without it there is no store
	// at all, so there is nothing to degrade to.
	index, err := openDB(context.Background(), filepath.Join(root, indexFile))
	if err != nil {
		return nil, err
	}
	if err := migrateIndex(context.Background(), index); err != nil {
		_ = index.Close()
		return nil, err
	}
	s.index = index
	// Startup housekeeping. Both report rather than fail: one unreadable space
	// must not take the whole store down, and the space that is actually
	// broken refuses loudly when someone opens it.
	s.sweepOrphans()
	s.reconcileCounts(context.Background())
	return s, nil
}

// sweepOrphans tidies the data directory at startup. A tombstone left by an
// interrupted delete is removed — the row is already gone, so the bytes are
// unreachable — and a space file with no index row is reported, never deleted:
// unreachable data is still data, and only a human can say it is not wanted.
func (s *store) sweepOrphans() {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		log.Printf("dataspace: sweep %s: %v", s.root, err)
		return
	}
	known := s.indexedSpaceIDs()
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case entry.IsDir():
			continue
		case strings.Contains(name, ".db.deleted-"):
			path := filepath.Join(s.root, name)
			if err := os.Remove(path); err != nil {
				log.Printf("dataspace: remove tombstone %s: %v", path, err)
			}
		case strings.HasSuffix(name, ".db") && name != indexFile:
			id := strings.TrimSuffix(name, ".db")
			if known == nil || known[id] {
				continue
			}
			log.Printf("dataspace: %s has no row in %s; it is unreachable and nothing will read it. "+
				"Move it aside or restore the index row.", filepath.Join(s.root, name), indexFile)
		}
	}
}

// indexedSpaceIDs is the id set the index knows about, or nil when it cannot
// be read — in which case the caller must not conclude anything is an orphan.
func (s *store) indexedSpaceIDs() map[string]bool {
	rows, err := s.index.QueryContext(context.Background(), `SELECT id FROM spaces`)
	if err != nil {
		log.Printf("dataspace: list spaces for sweep: %v", err)
		return nil
	}
	defer closeRows(rows)
	known := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			log.Printf("dataspace: scan space id for sweep: %v", err)
			return nil
		}
		known[id] = true
	}
	if err := rows.Err(); err != nil {
		log.Printf("dataspace: list spaces for sweep: %v", err)
		return nil
	}
	return known
}

// startupReconcileBudget bounds the whole startup pass. A store that cannot
// finish opening is a worse failure than a space that cannot open: one file on
// a stalled network mount or held by another process must not keep the broker
// from starting. Spaces the budget does not reach are simply left for the
// first call that opens them, which does the same work.
const startupReconcileBudget = 10 * time.Second

// reconcileCounts repairs the denormalized counts in the index against the
// file, which is the truth. They are written in a second transaction after the
// space's own, so a crash in that window leaves ListSpaces serving a wrong
// number forever; this is the repair.
//
// Every space is independent: one that cannot be opened is logged and the pass
// moves on, so a single broken file cannot stop the others. Handles are closed
// again, so startup does not cost a descriptor per space.
// It returns how many spaces it reconciled and whether it gave up early, which
// is what the startup log reports and what the test asserts on: "gave up after
// zero" and "worked through all of them failing one at a time" look identical
// from the outside otherwise.
func (s *store) reconcileCounts(ctx context.Context) (done int, gaveUp bool) {
	ctx, cancel := context.WithTimeout(ctx, startupReconcileBudget)
	defer cancel()
	ids := s.indexedSpaceIDs()
	for id := range ids {
		if err := ctx.Err(); err != nil {
			log.Printf("dataspace: startup reconcile stopped after %d of %d spaces (%v); "+
				"the rest are reconciled when they are first opened", done, len(ids), err)
			return done, true
		}
		if _, err := s.spaceDB(ctx, id); err != nil {
			// Logged and stepped over, never returned: one unreadable space
			// must not stop the pass, and must not stop Open.
			log.Printf("dataspace: reconcile %s: %v", id, err)
			continue
		}
		s.forgetSpaceDB(id)
		done++
	}
	return done, false
}

// openDB opens one SQLite file with the pragmas this package relies on and
// tightens the permissions of everything SQLite creates alongside it.
func openDB(ctx context.Context, path string) (*sql.DB, error) {
	dsn := "file:" + dsnPath(path) +
		"?_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=foreign_keys(ON)" +
		"&_pragma=synchronous(NORMAL)" +
		// Every write transaction takes the write lock at BEGIN, where
		// busy_timeout applies. A deferred BEGIN that later upgrades a read
		// snapshot returns SQLITE_BUSY_SNAPSHOT (517) immediately instead,
		// without consulting busy_timeout, which failed about half of all
		// writes whenever two brokers shared one home. Read transactions ask
		// for ReadOnly and still get a plain deferred BEGIN.
		"&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("dataspace: open %s: %w", path, err)
	}
	// One connection keeps WAL writers serialized inside the process and makes
	// the pragmas above apply to every statement this handle runs.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("dataspace: open %s: %w", path, err)
	}
	restrict(path)
	return db, nil
}

// dsnPath percent-encodes the characters that would otherwise end the path
// half way through a SQLite URI. A "#" in a directory name — which is legal on
// every platform this runs on — silently truncated the DSN before this, taking
// the pragmas with it and leaving a database opened on the wrong file.
func dsnPath(path string) string {
	var b strings.Builder
	b.Grow(len(path))
	for i := 0; i < len(path); i++ {
		switch c := path[i]; c {
		case '%', '?', '#', ' ':
			fmt.Fprintf(&b, "%%%02X", c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// restrict chmods a database and its WAL sidecars to 0600, best effort: they
// may not exist yet, and a failure here must not fail the call.
func restrict(path string) {
	for _, name := range []string{path, path + "-wal", path + "-shm"} {
		_ = os.Chmod(name, fileMode)
	}
}

// Close releases every open handle.
func (s *store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var firstErr error
	for id, db := range s.dbs {
		if err := db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(s.dbs, id)
	}
	if s.index != nil {
		if err := s.index.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		s.index = nil
	}
	return firstErr
}

// lockSpace is the opening move of every space-scoped call: authorize, take
// the space's lock, authorize again, and hand back the unlock.
//
// The first check is what keeps the mutex map bounded. lockFor allocates on a
// raw caller-supplied id, so checking access only after taking the lock meant
// a run of denied calls on ids that name nothing left one mutex behind each.
// The second check, inside the lock, is the authoritative one: access can
// change between the two, and only the one taken under the lock is serialized
// against the writer that changed it.
func (s *store) lockSpace(ctx context.Context, actor Actor, spaceID string, write bool) (Space, Level, func(), error) {
	if _, _, err := s.authorize(ctx, actor, spaceID, write); err != nil {
		return Space{}, LevelNone, nil, err
	}
	lock := s.lockFor(spaceID)
	lock.Lock()
	space, level, err := s.authorize(ctx, actor, spaceID, write)
	if err != nil {
		lock.Unlock()
		return Space{}, LevelNone, nil, err
	}
	return space, level, lock.Unlock, nil
}

// lockFor returns the mutex guarding one space, creating it on first use.
func (s *store) lockFor(spaceID string) *sync.Mutex {
	value, _ := s.locks.LoadOrStore(spaceID, &sync.Mutex{})
	lock, ok := value.(*sync.Mutex)
	if !ok {
		// Impossible: nothing else is ever stored under a space id.
		return &sync.Mutex{}
	}
	return lock
}

func (s *store) spacePath(spaceID string) string {
	return filepath.Join(s.root, spaceID+".db")
}

// spaceDB opens or returns the cached handle for one space database.
func (s *store) spaceDB(ctx context.Context, spaceID string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dbs == nil {
		return nil, errors.New("dataspace: store is closed")
	}
	if db, ok := s.dbs[spaceID]; ok {
		s.used[spaceID] = s.now()
		return db, nil
	}
	path := s.spacePath(spaceID)
	// Measured before the file is opened: opening one creates it and writes a
	// header, so after that "did this already exist, and with what in it" can
	// no longer be asked.
	existing := fileSize(path)
	if existing == 0 {
		// Unambiguous, and refused without opening: a real SQLite database is
		// never zero bytes, so this is a kill during creation, a cloud-sync
		// placeholder or a partial restore. Not opening it leaves the file
		// exactly as found, which is what a backup gets dropped back onto.
		err := notInitialisableError(spaceID, path, existing)
		log.Printf("dataspace: open %s: %v", spaceID, err)
		return nil, err
	}
	db, err := openDB(ctx, path)
	if err != nil {
		log.Printf("dataspace: open %s: %v", spaceID, err)
		return nil, err
	}
	if err := migrateSpace(ctx, db, spaceID, path, existing); err != nil {
		_ = db.Close()
		log.Printf("dataspace: open %s: %v", spaceID, err)
		return nil, err
	}
	if err := s.checkSpaceFile(ctx, db, spaceID); err != nil {
		_ = db.Close()
		return nil, err
	}
	s.evictLocked(spaceID)
	s.dbs[spaceID] = db
	s.used[spaceID] = s.now()
	return db, nil
}

// fileSize is the size of path in bytes, or -1 when it does not exist.
func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return info.Size()
}

// checkSpaceFile is the guard against a silent empty read, and the repair for
// the counts the index caches.
//
// The index carries a record count; the file carries the records. When they
// disagree, two very different things can be true, and the schema tells them
// apart. A record cannot exist without the object type that shaped it —
// records.type_id references object_types ON DELETE CASCADE, and every type
// carries a server-added primary attribute — so a file that ever held records
// still holds a schema. Therefore:
//
//   - Index claims records, file has NO SCHEMA AT ALL: the file was replaced or
//     restored over, and serving it would render the honest "no records yet"
//     empty state over lost data. Refused, loudly.
//   - Index claims records, file still has its schema: every record was
//     legitimately deleted and the process died before the second transaction
//     wrote the new count. The file is the truth; the count is repaired. This
//     used to be refused too, which bricked a healthy space permanently for a
//     user who did nothing wrong.
//
// The zero-length file is handled earlier, in spaceDB, and never gets here.
func (s *store) checkSpaceFile(ctx context.Context, db *sql.DB, spaceID string) error {
	row, err := s.loadSpaceRow(ctx, spaceID)
	if errors.Is(err, ErrNotFound) {
		// A space being created: the row lands after the file.
		return nil
	}
	if err != nil {
		return err
	}
	var records, types, attributes int
	for _, count := range []struct {
		query string
		into  *int
		noun  string
	}{
		{`SELECT COUNT(*) FROM records`, &records, "records"},
		{`SELECT COUNT(*) FROM object_types`, &types, "object types"},
		{`SELECT COUNT(*) FROM attributes`, &attributes, "attributes"},
	} {
		if err := db.QueryRowContext(ctx, count.query).Scan(count.into); err != nil {
			return fmt.Errorf("dataspace: count %s in %s: %w", count.noun, spaceID, err)
		}
	}
	if row.RecordCount > 0 && records == 0 && types == 0 && attributes == 0 {
		log.Printf("dataspace: %s: the index counts %d records, %s holds no records, "+
			"no object types and no attributes",
			spaceID, row.RecordCount, s.spacePath(spaceID))
		return fmt.Errorf("dataspace: space %s is not intact: the index counts %d records "+
			"but %s holds no records and no schema at all, which is what a replaced or "+
			"restored file looks like. Restore that file from a backup, or delete the "+
			"space; this build will not serve it as empty",
			spaceID, row.RecordCount, s.spacePath(spaceID))
	}
	if row.RecordCount == records && row.ObjectTypeCount == types {
		return nil
	}
	log.Printf("dataspace: %s: repairing stale counts (index %d types / %d records, file %d / %d)",
		spaceID, row.ObjectTypeCount, row.RecordCount, types, records)
	// A targeted write: updated_at belongs to the caller's edits, not to this.
	if _, err := s.index.ExecContext(ctx,
		`UPDATE spaces SET object_type_count = ?, record_count = ? WHERE id = ?`,
		types, records, spaceID); err != nil {
		return fmt.Errorf("dataspace: repair counts for %s: %w", spaceID, err)
	}
	return nil
}

// evictLocked closes the least recently used handles until there is room for
// one more. Only a space whose lock is free is evicted: every call holds its
// space's lock for its whole duration, so a free lock is proof that no
// transaction is using that handle. s.mu is held by the caller, and TryLock
// never waits, so this cannot invert the two locks into a deadlock.
func (s *store) evictLocked(keep string) {
	for len(s.dbs) >= maxOpenSpaceDBs {
		candidates := make([]string, 0, len(s.dbs))
		for id := range s.dbs {
			if id != keep {
				candidates = append(candidates, id)
			}
		}
		sort.Slice(candidates, func(i, j int) bool {
			return s.used[candidates[i]].Before(s.used[candidates[j]])
		})
		evicted := false
		for _, id := range candidates {
			lock := s.lockFor(id)
			if !lock.TryLock() {
				continue
			}
			_ = s.dbs[id].Close()
			delete(s.dbs, id)
			delete(s.used, id)
			lock.Unlock()
			evicted = true
			break
		}
		if !evicted {
			// Every other space is mid-call. Going over the cap beats blocking.
			return
		}
	}
}

// forgetSpaceDB closes and drops a cached handle, so the file can be removed.
func (s *store) forgetSpaceDB(spaceID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if db, ok := s.dbs[spaceID]; ok {
		_ = db.Close()
		delete(s.dbs, spaceID)
	}
	delete(s.used, spaceID)
}

func (s *store) stamp() string {
	return s.now().UTC().Format(timestampLayout)
}

// ── transactions ─────────────────────────────────────────────────

// inTx runs fn inside one WRITE transaction on a space database and commits
// only when fn returns nil, so a failed validation can never half-write a
// space. The BEGIN is IMMEDIATE (see the DSN), so the write lock is taken up
// front and busy_timeout applies to waiting for it.
func (s *store) inTx(ctx context.Context, spaceID string, fn func(tx *sql.Tx) error) error {
	return s.runTx(ctx, spaceID, nil, fn)
}

// inReadTx runs fn inside a read transaction. It asks for ReadOnly, which the
// driver answers with a plain deferred BEGIN, so a reader never takes the
// write lock and never makes a writer in another process wait.
func (s *store) inReadTx(ctx context.Context, spaceID string, fn func(tx *sql.Tx) error) error {
	return s.runTx(ctx, spaceID, &sql.TxOptions{ReadOnly: true}, fn)
}

func (s *store) runTx(ctx context.Context, spaceID string, opts *sql.TxOptions, fn func(tx *sql.Tx) error) error {
	db, err := s.spaceDB(ctx, spaceID)
	if err != nil {
		return err
	}
	tx, err := beginWithRetry(ctx, db, opts)
	if err != nil {
		log.Printf("dataspace: begin on %s: %v", spaceID, err)
		return fmt.Errorf("dataspace: begin: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		log.Printf("dataspace: commit on %s: %v", spaceID, err)
		return fmt.Errorf("dataspace: commit: %w", err)
	}
	return nil
}

// beginWithRetry retries a BEGIN that lost the write lock to another process.
// Only the BEGIN is retried, never fn: at BEGIN nothing has run yet, so a
// second attempt cannot repeat a partial effect or double an entry in a batch
// result that the caller is accumulating outside the transaction.
func beginWithRetry(ctx context.Context, db *sql.DB, opts *sql.TxOptions) (*sql.Tx, error) {
	var err error
	for attempt := 0; attempt < txBeginAttempts; attempt++ {
		var tx *sql.Tx
		tx, err = db.BeginTx(ctx, opts)
		if err == nil {
			return tx, nil
		}
		if !isBusy(err) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 10 * time.Millisecond):
		}
	}
	return nil, err
}

// isBusy reports whether err is SQLite telling us another connection holds the
// lock. The driver does not export a typed error for it, so the text is the
// only handle; SQLITE_BUSY, SQLITE_LOCKED and the BUSY_SNAPSHOT extended code
// all read as "database is locked".
func isBusy(err error) bool {
	if err == nil {
		return false
	}
	text := err.Error()
	return strings.Contains(text, "database is locked") ||
		strings.Contains(text, "database table is locked") ||
		strings.Contains(text, "SQLITE_BUSY")
}

// savepoint runs fn inside a named savepoint, so one entry of a batch can fail
// and roll back without taking the rest of the call with it.
func savepoint(ctx context.Context, tx *sql.Tx, name string, fn func() error) error {
	if _, err := tx.ExecContext(ctx, "SAVEPOINT "+name); err != nil {
		return fmt.Errorf("dataspace: savepoint: %w", err)
	}
	if err := fn(); err != nil {
		if _, rbErr := tx.ExecContext(ctx, "ROLLBACK TO "+name); rbErr != nil {
			return fmt.Errorf("dataspace: rollback to savepoint: %w", rbErr)
		}
		if _, relErr := tx.ExecContext(ctx, "RELEASE "+name); relErr != nil {
			return fmt.Errorf("dataspace: release savepoint: %w", relErr)
		}
		return err
	}
	if _, err := tx.ExecContext(ctx, "RELEASE "+name); err != nil {
		return fmt.Errorf("dataspace: release savepoint: %w", err)
	}
	return nil
}

// ── migrations ───────────────────────────────────────────────────

const indexDDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  id                TEXT PRIMARY KEY,
  owner             TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  access_json       TEXT NOT NULL,
  attached_apps     TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  object_type_count INTEGER NOT NULL DEFAULT 0,
  record_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS spaces_owner ON spaces(owner);
`

const spaceDDLv1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS object_types (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
  name_plural TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  position    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  id                   TEXT PRIMARY KEY,
  source_type_id       TEXT NOT NULL,
  source_attribute_id  TEXT NOT NULL,
  target_type_id       TEXT NOT NULL,
  inverse_attribute_id TEXT NOT NULL DEFAULT '',
  cardinality          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attributes (
  id              TEXT PRIMARY KEY,
  type_id         TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_key        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  is_primary      INTEGER NOT NULL DEFAULT 0,
  is_required     INTEGER NOT NULL DEFAULT 0,
  is_unique       INTEGER NOT NULL DEFAULT 0,
  is_multivalue   INTEGER NOT NULL DEFAULT 0,
  currency_code   TEXT NOT NULL DEFAULT '',
  relationship_id TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL,
  position        INTEGER NOT NULL,
  UNIQUE(type_id, slug),
  UNIQUE(type_id, name_key)
);
CREATE TABLE IF NOT EXISTS select_options (
  id           TEXT PRIMARY KEY,
  attribute_id TEXT NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  color        TEXT NOT NULL,
  position     INTEGER NOT NULL,
  UNIQUE(attribute_id, name_key)
);
CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  type_id    TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_type ON records(type_id, seq);
CREATE TABLE IF NOT EXISTS record_values (
  record_id    TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  attribute_id TEXT NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  unique_key   TEXT,
  PRIMARY KEY (record_id, attribute_id)
);
CREATE INDEX IF NOT EXISTS record_values_attribute ON record_values(attribute_id);
-- The one guard that makes uniqueness a property of the store rather than of
-- a check the caller hopes nobody raced.
CREATE UNIQUE INDEX IF NOT EXISTS record_values_unique
  ON record_values(attribute_id, unique_key) WHERE unique_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS links (
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  PRIMARY KEY (relationship_id, source_id, target_id)
);
CREATE INDEX IF NOT EXISTS links_target ON links(relationship_id, target_id);
CREATE INDEX IF NOT EXISTS links_source_record ON links(source_id);
CREATE INDEX IF NOT EXISTS links_target_record ON links(target_id);
`

// readVersion reads meta.schema_version without writing anything. It used to
// create the meta table first, which meant merely asking a suspicious file its
// version modified it; the DDL of each version creates meta itself.
func readVersion(ctx context.Context, db *sql.DB) (int, error) {
	var raw string
	err := db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil && strings.Contains(err.Error(), "no such table") {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("dataspace: read schema version: %w", err)
	}
	var version int
	if _, scanErr := fmt.Sscanf(raw, "%d", &version); scanErr != nil {
		return 0, fmt.Errorf("dataspace: schema version %q is not a number", raw)
	}
	return version, nil
}

func writeVersion(ctx context.Context, db *sql.DB, version int) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO meta(key, value) VALUES('schema_version', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		fmt.Sprintf("%d", version))
	if err != nil {
		return fmt.Errorf("dataspace: write schema version: %w", err)
	}
	return nil
}

func migrateIndex(ctx context.Context, db *sql.DB) error {
	version, err := readVersion(ctx, db)
	if err != nil {
		return err
	}
	if version > schemaVersion {
		return newerFileError(indexFile, version)
	}
	if version == schemaVersion {
		return nil
	}
	if _, err := db.ExecContext(ctx, indexDDL); err != nil {
		return fmt.Errorf("dataspace: index schema: %w", err)
	}
	return writeVersion(ctx, db, schemaVersion)
}

// newerFileError refuses a file this build does not understand. Downgrading is
// ordinary here — the CLI ships through npx and people pin older versions — and
// the old behaviour was to restamp the version DOWNWARD and then read the file
// with the old assumptions, so the damage only appeared on the next upgrade,
// when migrations re-ran over rows that already had them.
func newerFileError(what string, version int) error {
	return fmt.Errorf("dataspace: %s was written by a newer wuphf (file schema version %d, "+
		"this build understands %d). Refusing to touch it — upgrade wuphf rather than "+
		"downgrading your data", what, version, schemaVersion)
}

// notInitialisableError refuses to treat an existing file as a new space. A
// brand new space and a file that was truncated or replaced both report schema
// version 0; running the v1 DDL over the second one hands the caller a working
// EMPTY space while the index still counts the records that were in it, and
// the UI then renders its honest "no records yet" state over the loss. Nothing
// in that sequence is an error, which is why it has to be made one here.
func notInitialisableError(spaceID, path string, size int64) error {
	return fmt.Errorf("dataspace: space %s has a database file (%s, %d bytes) that carries "+
		"no schema version: it was truncated, replaced or only partly written. Refusing to "+
		"initialise it as a new empty space — restore it from a backup or move it aside",
		spaceID, path, size)
}

// migrateSpace brings one space database up to schemaVersion. Later slices add
// a case here rather than editing an earlier version's DDL.
//
// existing is the size the file had before it was opened, or -1 when it did
// not exist. It is the only way to tell a brand new space from one whose file
// was truncated to nothing or replaced: both report schema version 0, and
// running the v1 DDL over the second one hands the caller a working EMPTY
// space while the index still counts the records that were in it.
func migrateSpace(ctx context.Context, db *sql.DB, spaceID, path string, existing int64) error {
	version, err := readVersion(ctx, db)
	if err != nil {
		return err
	}
	if version > schemaVersion {
		return newerFileError("space "+spaceID, version)
	}
	if version == schemaVersion {
		return nil
	}
	if version == 0 && existing >= 0 {
		return notInitialisableError(spaceID, path, existing)
	}
	for version < schemaVersion {
		switch version {
		case 0:
			if _, err := db.ExecContext(ctx, spaceDDLv1); err != nil {
				return fmt.Errorf("dataspace: space schema v1: %w", err)
			}
			if _, err := db.ExecContext(ctx,
				`INSERT INTO meta(key, value) VALUES('space_id', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, spaceID); err != nil {
				return fmt.Errorf("dataspace: space id: %w", err)
			}
			version = 1
		default:
			return fmt.Errorf("dataspace: space %s has unknown schema version %d", spaceID, version)
		}
	}
	// Only reached when the version actually moved.
	return writeVersion(ctx, db, schemaVersion)
}

// closeRows releases a result set. It exists so every call site can ignore the
// error in one place rather than repeating the assignment.
func closeRows(rows *sql.Rows) {
	_ = rows.Close()
}
