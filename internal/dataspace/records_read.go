package dataspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// recordScope names a set of records by a predicate over the records table, so
// values and links can be fetched with the same predicate instead of a giant
// IN list of ids.
type recordScope struct {
	where string
	args  []any
}

func scopeType(typeID string) recordScope {
	return recordScope{where: "type_id = ?", args: []any{typeID}}
}

func scopeRecord(recordID string) recordScope {
	return recordScope{where: "id = ?", args: []any{recordID}}
}

type storedRecord struct {
	ID        string
	TypeID    string
	CreatedBy string
	CreatedAt string
	UpdatedAt string
	Seq       int64
	Values    map[string]Value
}

// decodeValue turns a stored JSON value back into the concrete Go type the
// attribute holds.
func decodeValue(raw string) (Value, error) {
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, fmt.Errorf("dataspace: decode value: %w", err)
	}
	if list, ok := decoded.([]any); ok {
		out := make([]string, 0, len(list))
		for _, item := range list {
			out = append(out, valueString(item))
		}
		return out, nil
	}
	return decoded, nil
}

func encodeValue(value Value) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("dataspace: encode value: %w", err)
	}
	return string(encoded), nil
}

// loadStoredRecords reads the records in a scope together with their values.
func loadStoredRecords(ctx context.Context, tx *sql.Tx, scope recordScope) ([]*storedRecord, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT id, type_id, created_by, created_at, updated_at, seq
		 FROM records WHERE `+scope.where+` ORDER BY seq, id`, scope.args...)
	if err != nil {
		return nil, fmt.Errorf("dataspace: load records: %w", err)
	}
	defer closeRows(rows)
	out := []*storedRecord{}
	byID := map[string]*storedRecord{}
	for rows.Next() {
		record := &storedRecord{Values: map[string]Value{}}
		if err := rows.Scan(&record.ID, &record.TypeID, &record.CreatedBy,
			&record.CreatedAt, &record.UpdatedAt, &record.Seq); err != nil {
			return nil, fmt.Errorf("dataspace: scan record: %w", err)
		}
		out = append(out, record)
		byID[record.ID] = record
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: load records: %w", err)
	}
	if len(out) == 0 {
		return out, nil
	}
	valueRows, err := tx.QueryContext(ctx,
		`SELECT record_id, slug, value_json FROM record_values
		 WHERE record_id IN (SELECT id FROM records WHERE `+scope.where+`)`, scope.args...)
	if err != nil {
		return nil, fmt.Errorf("dataspace: load values: %w", err)
	}
	defer closeRows(valueRows)
	for valueRows.Next() {
		var recordID, slug, raw string
		if err := valueRows.Scan(&recordID, &slug, &raw); err != nil {
			return nil, fmt.Errorf("dataspace: scan value: %w", err)
		}
		value, decodeErr := decodeValue(raw)
		if decodeErr != nil {
			return nil, decodeErr
		}
		if record, ok := byID[recordID]; ok {
			record.Values[slug] = value
		}
	}
	if err := valueRows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: load values: %w", err)
	}
	return out, nil
}

type storedLink struct {
	RelationshipID string
	SourceID       string
	TargetID       string
}

func loadLinks(ctx context.Context, tx *sql.Tx, scope recordScope) ([]storedLink, error) {
	args := append(append([]any{}, scope.args...), scope.args...)
	rows, err := tx.QueryContext(ctx,
		`SELECT relationship_id, source_id, target_id FROM links
		 WHERE source_id IN (SELECT id FROM records WHERE `+scope.where+`)
		    OR target_id IN (SELECT id FROM records WHERE `+scope.where+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("dataspace: load links: %w", err)
	}
	defer closeRows(rows)
	out := []storedLink{}
	for rows.Next() {
		var link storedLink
		if err := rows.Scan(&link.RelationshipID, &link.SourceID, &link.TargetID); err != nil {
			return nil, fmt.Errorf("dataspace: scan link: %w", err)
		}
		out = append(out, link)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: load links: %w", err)
	}
	return out, nil
}

// refsFor resolves record ids into RecordRefs, reading each target's current
// primary value so a reference can never show a stale name.
func refsFor(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, ids []string) (map[string]RecordRef, error) {
	out := map[string]RecordRef{}
	unique := sortedCopy(ids)
	const chunk = 400
	for start := 0; start < len(unique); start += chunk {
		end := start + chunk
		if end > len(unique) {
			end = len(unique)
		}
		batch := unique[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(batch)), ",")
		args := make([]any, 0, len(batch))
		for _, id := range batch {
			args = append(args, id)
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT r.id, r.type_id, COALESCE(v.value_json, '')
			 FROM records r
			 LEFT JOIN attributes a ON a.type_id = r.type_id AND a.is_primary = 1
			 LEFT JOIN record_values v ON v.record_id = r.id AND v.attribute_id = a.id
			 WHERE r.id IN (`+placeholders+`)`, args...)
		if err != nil {
			return nil, fmt.Errorf("dataspace: resolve references: %w", err)
		}
		for rows.Next() {
			var id, typeID, raw string
			if err := rows.Scan(&id, &typeID, &raw); err != nil {
				closeRows(rows)
				return nil, fmt.Errorf("dataspace: scan reference: %w", err)
			}
			name := ""
			if raw != "" {
				value, decodeErr := decodeValue(raw)
				if decodeErr != nil {
					closeRows(rows)
					return nil, decodeErr
				}
				name = valueString(value)
			}
			out[id] = RecordRef{ID: id, TypeID: typeID, Name: name}
		}
		if err := rows.Err(); err != nil {
			closeRows(rows)
			return nil, fmt.Errorf("dataspace: resolve references: %w", err)
		}
		closeRows(rows)
	}
	return out, nil
}

// viewRecords turns stored records into the wire shape, resolving every
// relationship attribute slug even when nothing is linked.
func viewRecords(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, records []*storedRecord, scope recordScope) ([]Record, error) {
	links, err := loadLinks(ctx, tx, scope)
	if err != nil {
		return nil, err
	}
	needed := []string{}
	for _, link := range links {
		needed = append(needed, link.SourceID, link.TargetID)
	}
	refs, err := refsFor(ctx, tx, snapshot, needed)
	if err != nil {
		return nil, err
	}
	byRelationship := map[string][]storedLink{}
	for _, link := range links {
		byRelationship[link.RelationshipID] = append(byRelationship[link.RelationshipID], link)
	}
	out := make([]Record, 0, len(records))
	for _, record := range records {
		view := Record{
			ID:        record.ID,
			TypeID:    record.TypeID,
			Values:    map[string]Value{},
			Links:     map[string][]RecordRef{},
			CreatedBy: record.CreatedBy,
			CreatedAt: record.CreatedAt,
			UpdatedAt: record.UpdatedAt,
		}
		for slug, value := range record.Values {
			view.Values[slug] = value
		}
		entry := snapshot.typeByID(record.TypeID)
		if entry != nil {
			for _, attr := range entry.Attrs {
				if attr.Relationship == nil {
					continue
				}
				rel, ok := snapshot.rels[attr.Relationship.RelationshipID]
				if !ok {
					continue
				}
				isSource := rel.SourceAttributeID == attr.ID
				refsOut := []RecordRef{}
				for _, link := range byRelationship[rel.ID] {
					var otherID string
					switch {
					case isSource && link.SourceID == record.ID:
						otherID = link.TargetID
					case !isSource && link.TargetID == record.ID:
						otherID = link.SourceID
					default:
						continue
					}
					if ref, found := refs[otherID]; found {
						refsOut = append(refsOut, ref)
					}
				}
				view.Links[attr.Slug] = refsOut
			}
		}
		out = append(out, view)
	}
	return out, nil
}
