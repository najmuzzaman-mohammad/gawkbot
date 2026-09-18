package dataspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// ── Store: records ───────────────────────────────────────────────

func (s *store) GetRecord(ctx context.Context, actor Actor, spaceID, recordID string) (Record, error) {
	_, _, unlock, err := s.lockSpace(ctx, actor, spaceID, false)
	if err != nil {
		return Record{}, err
	}
	defer unlock()
	var out Record
	err = s.inReadTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		scope := scopeRecord(recordID)
		records, recErr := loadStoredRecords(ctx, tx, scope)
		if recErr != nil {
			return recErr
		}
		if len(records) == 0 {
			return notFound("", "Unknown record %q.", recordID)
		}
		views, viewErr := viewRecords(ctx, tx, snapshot, records, scope)
		if viewErr != nil {
			return viewErr
		}
		out = views[0]
		return nil
	})
	if err != nil {
		return Record{}, err
	}
	return out, nil
}

func (s *store) CreateRecords(ctx context.Context, actor Actor, spaceID, typeRef string, inputs []RecordInput) (Result, error) {
	return s.writeRecords(ctx, actor, spaceID, typeRef, "", inputs)
}

func (s *store) UpsertRecords(ctx context.Context, actor Actor, spaceID, typeRef, matchAttribute string, inputs []RecordInput) (Result, error) {
	if strings.TrimSpace(matchAttribute) == "" {
		return Result{}, &ValidationError{Message: "An upsert needs a matching attribute."}
	}
	return s.writeRecords(ctx, actor, spaceID, typeRef, matchAttribute, inputs)
}

// writeRecords is create and upsert in one body: the only differences are the
// match lookup and that an upsert skips nil values instead of clearing.
func (s *store) writeRecords(ctx context.Context, actor Actor, spaceID, typeRef, matchAttribute string, inputs []RecordInput) (Result, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Result{}, err
	}
	defer unlock()
	if len(inputs) > MaxRecordsPerCall {
		return Result{}, tooMany("records", len(inputs), MaxRecordsPerCall)
	}
	verb := "created"
	if matchAttribute != "" {
		verb = "written"
	}
	out := newResult("record", verb, len(inputs))
	who := normalizeActor(actor)
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		entry, typeErr := snapshot.requireType(typeRef)
		if typeErr != nil {
			return typeErr
		}
		var match *Attribute
		if matchAttribute != "" {
			match, typeErr = requireMatchAttribute(entry, matchAttribute)
			if typeErr != nil {
				return typeErr
			}
		}
		cursor, cursorErr := newWriteCursor(ctx, tx)
		if cursorErr != nil {
			return cursorErr
		}
		for index, input := range inputs {
			var written string
			entryErr := savepoint(ctx, tx, fmt.Sprintf("rec_%d", index), func() error {
				id, writeErr := writeOneRecord(ctx, tx, s, snapshot, entry, match, cursor, who, input)
				if writeErr != nil {
					return writeErr
				}
				written = id
				return nil
			})
			identifier := identifyInput(entry, input)
			if entryErr != nil {
				if isFatal(entryErr) {
					return entryErr
				}
				out.addError(index, identifier, entryErr)
				continue
			}
			out.add(index, identifier, written)
		}
		return nil
	})
	if err != nil {
		return Result{}, err
	}
	if _, err := s.touchSpace(ctx, space); err != nil {
		return Result{}, err
	}
	return out.result(), nil
}

// identifyInput names a record in the batch envelope: its primary value when
// the caller gave one, so a failure reads as "Mirela: Email is required".
func identifyInput(entry *typeEntry, input RecordInput) string {
	primary := entry.primary()
	if primary == nil {
		return ""
	}
	for key, raw := range input.Values {
		if strings.EqualFold(key, primary.Slug) || sameName(key, primary.Name) {
			if s, ok := raw.(string); ok {
				return strings.TrimSpace(s)
			}
			return valueString(raw)
		}
	}
	return ""
}

func requireMatchAttribute(entry *typeEntry, ref string) (*Attribute, error) {
	attr := resolveAttributeRef(entry, ref)
	if attr == nil {
		return nil, notFound("", "%q is not an attribute of %s, so it cannot match an upsert.", ref, entry.Name)
	}
	if !attr.IsUnique {
		unique := []string{}
		for _, candidate := range entry.Attrs {
			if candidate.IsUnique {
				unique = append(unique, candidate.Slug)
			}
		}
		listed := strings.Join(unique, ", ")
		if listed == "" {
			listed = "none"
		}
		return nil, Invalid(attr.Slug,
			"An upsert matches on a unique attribute, and %q is not unique. Unique attributes on %s: %s.",
			attr.Slug, entry.Name, listed)
	}
	return attr, nil
}

// writeOneRecord creates or updates one record and returns its id.
func writeOneRecord(ctx context.Context, tx *sql.Tx, s *store, snapshot *schemaSnapshot, entry *typeEntry, match *Attribute, cursor *writeCursor, actor string, input RecordInput) (string, error) {
	values := input.Values
	existingID := ""
	if match != nil {
		raw, present := lookupValue(entry, values, match)
		if !present || isBlank(raw) {
			return "", Invalid(match.Slug,
				"An upsert needs a value for %s on every item.", match.Name)
		}
		coerced, err := coerceValue(match, raw)
		if err != nil {
			return "", err
		}
		if coerced == nil {
			return "", Invalid(match.Slug,
				"An upsert needs a value for %s on every item.", match.Name)
		}
		found, lookupErr := findByUniqueValue(ctx, tx, match, coerced)
		if lookupErr != nil {
			return "", lookupErr
		}
		existingID = found
		// A nil value is skipped on upsert rather than clearing what is there.
		values = withoutNils(values)
	}
	if existingID == "" {
		return createRecord(ctx, tx, s, entry, cursor, actor, values)
	}
	if err := updateRecordValues(ctx, tx, s, entry, existingID, values); err != nil {
		return "", err
	}
	return existingID, nil
}

func withoutNils(values map[string]any) map[string]any {
	out := make(map[string]any, len(values))
	for key, raw := range values {
		if raw == nil {
			continue
		}
		out[key] = raw
	}
	return out
}

// lookupValue finds a value in a patch by attribute slug, then by name.
func lookupValue(entry *typeEntry, values map[string]any, attr *Attribute) (any, bool) {
	if raw, ok := values[attr.Slug]; ok {
		return raw, true
	}
	for key, raw := range values {
		if resolveValueKey(entry, key) == attr {
			return raw, true
		}
	}
	return nil, false
}

// resolveValueKey maps a key in a values patch to an attribute: slug first,
// then display name, which is what the RecordInput contract promises.
func resolveValueKey(entry *typeEntry, key string) *Attribute {
	if attr := entry.attrBySlug(key); attr != nil {
		return attr
	}
	if attr := entry.attrBySlug(strings.ToLower(strings.TrimSpace(key))); attr != nil {
		return attr
	}
	return entry.attrByName(key)
}

func findByUniqueValue(ctx context.Context, tx *sql.Tx, attr *Attribute, value Value) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx,
		`SELECT record_id FROM record_values WHERE attribute_id = ? AND unique_key = ?`,
		attr.ID, uniqueKey(value)).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("dataspace: match unique value: %w", err)
	}
	return id, nil
}

// writeCursor carries the two whole-table facts a create needs: how many
// records the space already holds, and the next sequence number. Both used to
// be read per row — a COUNT(*) and a MAX(seq) over every record in the space —
// which at 100k records costs about 7ms each, so a 1000-row batch spent
// several seconds on guard work alone while holding the space lock. They are
// read once per transaction now and carried forward.
type writeCursor struct {
	total int
	seq   int
}

func newWriteCursor(ctx context.Context, tx *sql.Tx) (*writeCursor, error) {
	total, err := totalRecords(ctx, tx)
	if err != nil {
		return nil, err
	}
	seq, err := nextPosition(ctx, tx, `SELECT MAX(seq) FROM records`)
	if err != nil {
		return nil, err
	}
	return &writeCursor{total: total, seq: seq}, nil
}

func createRecord(ctx context.Context, tx *sql.Tx, s *store, entry *typeEntry, cursor *writeCursor, actor string, values map[string]any) (string, error) {
	if cursor.total >= MaxRecordsPerSpace {
		return "", &ValidationError{Message: fmt.Sprintf(
			"A space holds at most %d records.", MaxRecordsPerSpace)}
	}
	patch, err := buildPatch(ctx, tx, entry, values, nil)
	if err != nil {
		return "", err
	}
	seq := cursor.seq
	stamp := s.stamp()
	id := newID(prefixRecord)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO records(id, type_id, created_by, created_at, updated_at, seq)
		 VALUES(?, ?, ?, ?, ?, ?)`,
		id, entry.ID, actor, stamp, stamp, seq); err != nil {
		return "", fmt.Errorf("dataspace: insert record: %w", err)
	}
	if err := writePatch(ctx, tx, id, patch); err != nil {
		return "", err
	}
	// Advanced only once the row is actually in: a savepoint rollback takes
	// the INSERT with it, and the cursor must not count a row that went away.
	cursor.total++
	cursor.seq++
	return id, nil
}

func updateRecordValues(ctx context.Context, tx *sql.Tx, s *store, entry *typeEntry, recordID string, values map[string]any) error {
	existing, err := loadStoredRecords(ctx, tx, scopeRecord(recordID))
	if err != nil {
		return err
	}
	if len(existing) == 0 {
		return notFound("", "Unknown record %q.", recordID)
	}
	patch, err := buildPatch(ctx, tx, entry, values, existing[0])
	if err != nil {
		return err
	}
	if err := writePatch(ctx, tx, recordID, patch); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE records SET updated_at = ? WHERE id = ?`, s.stamp(), recordID); err != nil {
		return fmt.Errorf("dataspace: touch record: %w", err)
	}
	return nil
}

func (s *store) UpdateRecord(ctx context.Context, actor Actor, spaceID, recordID string, values map[string]any) (Record, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Record{}, err
	}
	defer unlock()
	var out Record
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		records, recErr := loadStoredRecords(ctx, tx, scopeRecord(recordID))
		if recErr != nil {
			return recErr
		}
		if len(records) == 0 {
			return notFound("", "Unknown record %q.", recordID)
		}
		entry := snapshot.typeByID(records[0].TypeID)
		if entry == nil {
			return fmt.Errorf("dataspace: record %s has no object type", recordID)
		}
		if err := updateRecordValues(ctx, tx, s, entry, recordID, values); err != nil {
			return err
		}
		scope := scopeRecord(recordID)
		reread, rereadErr := loadStoredRecords(ctx, tx, scope)
		if rereadErr != nil {
			return rereadErr
		}
		views, viewErr := viewRecords(ctx, tx, snapshot, reread, scope)
		if viewErr != nil {
			return viewErr
		}
		out = views[0]
		return nil
	})
	if err != nil {
		return Record{}, err
	}
	if _, err := s.touchSpace(ctx, space); err != nil {
		return Record{}, err
	}
	return out, nil
}

// ── value patches ────────────────────────────────────────────────

type patchEntry struct {
	attr  *Attribute
	value Value // nil means "clear"
}

// buildPatch validates an entire values map before anything is written, so one
// bad value leaves the record exactly as it was.
func buildPatch(ctx context.Context, tx *sql.Tx, entry *typeEntry, values map[string]any, existing *storedRecord) ([]patchEntry, error) {
	out := make([]patchEntry, 0, len(values))
	touched := map[string]bool{}
	// Sorted for a deterministic first error when several values are bad.
	for _, key := range sortedKeys(values) {
		raw := values[key]
		attr, err := resolveValueAttribute(entry, key)
		if err != nil {
			return nil, err
		}
		value, err := coerceValue(attr, raw)
		if err != nil {
			return nil, err
		}
		if value == nil && attr.IsRequired && existing != nil {
			return nil, Invalid(attr.Slug, "%s is required and cannot be cleared.", attr.Name)
		}
		if value != nil && attr.IsUnique {
			selfID := ""
			if existing != nil {
				selfID = existing.ID
			}
			if err := assertUnique(ctx, tx, entry, attr, value, selfID); err != nil {
				return nil, err
			}
		}
		out = append(out, patchEntry{attr: attr, value: value})
		touched[attr.Slug] = true
	}
	if existing == nil {
		// On create every required attribute must end up with a value, whether
		// it was left out or explicitly set to nothing.
		for _, item := range out {
			if item.value == nil {
				delete(touched, item.attr.Slug)
			}
		}
		for _, attr := range entry.Attrs {
			if attr.IsRequired && !touched[attr.Slug] {
				return nil, Invalid(attr.Slug, "%s is required.", attr.Name)
			}
		}
	}
	return out, nil
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return sortedCopy(keys)
}

// resolveValueAttribute maps a key in a values patch to a value attribute, or
// explains what the caller should have used.
func resolveValueAttribute(entry *typeEntry, key string) (*Attribute, error) {
	attr := resolveValueKey(entry, key)
	if attr == nil {
		valid := []string{}
		for _, candidate := range entry.Attrs {
			if candidate.Type != TypeRelationship {
				valid = append(valid, candidate.Slug)
			}
		}
		return nil, Invalid(key, "%q is not an attribute of %s. Valid attributes: %s.",
			key, entry.Name, strings.Join(valid, ", "))
	}
	if attr.Type == TypeRelationship {
		return nil, Invalid(attr.Slug,
			"%q is a relationship, so it is set by linking records, not by setting a value.",
			attr.Slug)
	}
	return attr, nil
}

// assertUnique names the record a value collides with. The partial UNIQUE
// index is what actually enforces uniqueness; this check exists to produce a
// message the caller can act on without a second request.
func assertUnique(ctx context.Context, tx *sql.Tx, entry *typeEntry, attr *Attribute, value Value, selfID string) error {
	var clashID string
	err := tx.QueryRowContext(ctx,
		`SELECT record_id FROM record_values
		 WHERE attribute_id = ? AND unique_key = ? AND record_id <> ?`,
		attr.ID, uniqueKey(value), selfID).Scan(&clashID)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("dataspace: unique check: %w", err)
	}
	label := ""
	if primary := entry.primary(); primary != nil {
		var raw string
		lookupErr := tx.QueryRowContext(ctx,
			`SELECT value_json FROM record_values WHERE record_id = ? AND attribute_id = ?`,
			clashID, primary.ID).Scan(&raw)
		if lookupErr == nil {
			if decoded, decodeErr := decodeValue(raw); decodeErr == nil {
				label = valueString(decoded)
			}
		}
	}
	return Invalid(attr.Slug,
		"%s %s is already used by record %s (%s). %s must be unique; update that record instead.",
		attr.Name, show(value), clashID, label, attr.Name)
}

func writePatch(ctx context.Context, tx *sql.Tx, recordID string, patch []patchEntry) error {
	for _, item := range patch {
		if item.value == nil {
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM record_values WHERE record_id = ? AND attribute_id = ?`,
				recordID, item.attr.ID); err != nil {
				return fmt.Errorf("dataspace: clear value: %w", err)
			}
			continue
		}
		encoded, err := encodeValue(item.value)
		if err != nil {
			return err
		}
		// One value is not a document store. A multi-megabyte string costs
		// every later read of that record, and nothing downstream expects it.
		if len(encoded) > MaxValueBytes {
			return Invalid(item.attr.Slug,
				"%s is %d bytes; one value holds at most %d. Store the long form somewhere else and keep a reference here.",
				item.attr.Name, len(encoded), MaxValueBytes)
		}
		var key any
		if item.attr.IsUnique {
			key = uniqueKey(item.value)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO record_values(record_id, attribute_id, slug, value_json, unique_key)
			 VALUES(?, ?, ?, ?, ?)
			 ON CONFLICT(record_id, attribute_id) DO UPDATE
			   SET slug = excluded.slug, value_json = excluded.value_json, unique_key = excluded.unique_key`,
			recordID, item.attr.ID, item.attr.Slug, encoded, key); err != nil {
			if isUniqueViolation(err) {
				// Another writer took the value between the check above and
				// this insert. The index is the authority, so report it.
				return Invalid(item.attr.Slug,
					"%s %s is already used by another record. %s must be unique; update that record instead.",
					item.attr.Name, show(item.value), item.attr.Name)
			}
			return fmt.Errorf("dataspace: write value: %w", err)
		}
	}
	return nil
}
