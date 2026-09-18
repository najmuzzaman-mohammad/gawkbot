package dataspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// resolvedLink is one link input validated against the schema and oriented the
// way the relationship stores it.
type resolvedLink struct {
	record     *storedRecord
	target     *storedRecord
	entry      *typeEntry
	targetType *typeEntry
	attr       *Attribute
	rel        *Relationship
	link       storedLink
}

func requireStoredRecord(ctx context.Context, tx *sql.Tx, recordID string) (*storedRecord, error) {
	records, err := loadStoredRecords(ctx, tx, scopeRecord(recordID))
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, notFound("", "Unknown record %q.", recordID)
	}
	return records[0], nil
}

func resolveLink(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, input LinkInput) (*resolvedLink, error) {
	record, err := requireStoredRecord(ctx, tx, input.Record)
	if err != nil {
		return nil, err
	}
	entry := snapshot.typeByID(record.TypeID)
	if entry == nil {
		return nil, fmt.Errorf("dataspace: record %s has no object type", record.ID)
	}
	attr := resolveAttributeRef(entry, input.Attribute)
	if attr == nil {
		slugs := []string{}
		for _, candidate := range entry.Attrs {
			if candidate.Type == TypeRelationship {
				slugs = append(slugs, candidate.Slug)
			}
		}
		listed := strings.Join(slugs, ", ")
		if listed == "" {
			listed = "none"
		}
		return nil, Invalid(input.Attribute,
			"%q is not an attribute of %s. Relationship attributes: %s.",
			input.Attribute, entry.Name, listed)
	}
	if attr.Type != TypeRelationship || attr.Relationship == nil {
		return nil, Invalid(attr.Slug,
			"%q is a %s attribute, not a relationship, so set its value directly rather than linking.",
			attr.Slug, string(attr.Type))
	}
	target, err := requireStoredRecord(ctx, tx, input.Target)
	if err != nil {
		return nil, err
	}
	targetType := snapshot.typeByID(attr.Relationship.TargetTypeID)
	if targetType == nil {
		return nil, fmt.Errorf("dataspace: relationship %s has no target type", attr.Relationship.RelationshipID)
	}
	if target.TypeID != targetType.ID {
		actual := snapshot.typeByID(target.TypeID)
		actualName := target.TypeID
		if actual != nil {
			actualName = actual.Name
		}
		return nil, Invalid(attr.Slug, "%s links to %s records; %s is a %s.",
			attr.Name, targetType.Name, target.ID, actualName)
	}
	rel, ok := snapshot.rels[attr.Relationship.RelationshipID]
	if !ok {
		return nil, fmt.Errorf("dataspace: unknown relationship %s", attr.Relationship.RelationshipID)
	}
	fromSource := rel.SourceAttributeID == attr.ID
	link := storedLink{RelationshipID: rel.ID, SourceID: record.ID, TargetID: target.ID}
	if !fromSource {
		link.SourceID, link.TargetID = target.ID, record.ID
	}
	return &resolvedLink{
		record: record, target: target, entry: entry, targetType: targetType,
		attr: attr, rel: rel, link: link,
	}, nil
}

func (s *store) Link(ctx context.Context, actor Actor, spaceID string, inputs []LinkInput) (Result, error) {
	return s.changeLinks(ctx, actor, spaceID, inputs, true)
}

func (s *store) Unlink(ctx context.Context, actor Actor, spaceID string, inputs []LinkInput) (Result, error) {
	return s.changeLinks(ctx, actor, spaceID, inputs, false)
}

func (s *store) changeLinks(ctx context.Context, actor Actor, spaceID string, inputs []LinkInput, link bool) (Result, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Result{}, err
	}
	defer unlock()
	if len(inputs) > MaxLinksPerCall {
		return Result{}, tooMany("links", len(inputs), MaxLinksPerCall)
	}
	verb := "linked"
	if !link {
		verb = "unlinked"
	}
	out := newResult("link", verb, len(inputs))
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		for index, input := range inputs {
			identifier := input.Record + " " + input.Attribute + " " + input.Target
			var noop bool
			entryErr := savepoint(ctx, tx, fmt.Sprintf("link_%d", index), func() error {
				changed, applyErr := applyLink(ctx, tx, s, snapshot, input, link)
				if applyErr != nil {
					return applyErr
				}
				noop = !changed
				return nil
			})
			if entryErr != nil {
				if isFatal(entryErr) {
					return entryErr
				}
				out.addError(index, identifier, entryErr)
				continue
			}
			if noop {
				out.addNoop(index, identifier, input.Record)
				continue
			}
			out.add(index, identifier, input.Record)
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

// applyLink links or unlinks one pair. It reports whether anything changed, so
// an idempotent repeat comes back as a no-op rather than a write.
func applyLink(ctx context.Context, tx *sql.Tx, s *store, snapshot *schemaSnapshot, input LinkInput, link bool) (bool, error) {
	resolved, err := resolveLink(ctx, tx, snapshot, input)
	if err != nil {
		return false, err
	}
	exists, err := linkExists(ctx, tx, resolved.link)
	if err != nil {
		return false, err
	}
	if !link {
		if !exists {
			// Not linked: an idempotent no-op.
			return false, nil
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM links WHERE relationship_id = ? AND source_id = ? AND target_id = ?`,
			resolved.link.RelationshipID, resolved.link.SourceID, resolved.link.TargetID); err != nil {
			return false, fmt.Errorf("dataspace: unlink: %w", err)
		}
		return true, touchRecords(ctx, tx, s, []string{resolved.link.SourceID, resolved.link.TargetID})
	}
	if exists {
		// Already linked: an idempotent no-op, nothing is touched.
		return false, nil
	}
	conflicts, err := linkConflicts(ctx, tx, resolved)
	if err != nil {
		return false, err
	}
	if len(conflicts) > 0 && !input.Replace {
		message, msgErr := conflictMessage(ctx, tx, snapshot, resolved, conflicts[0])
		if msgErr != nil {
			return false, msgErr
		}
		return false, Invalid(resolved.attr.Slug, "%s", message)
	}
	touched := []string{resolved.link.SourceID, resolved.link.TargetID}
	for _, conflict := range conflicts {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM links WHERE relationship_id = ? AND source_id = ? AND target_id = ?`,
			conflict.RelationshipID, conflict.SourceID, conflict.TargetID); err != nil {
			return false, fmt.Errorf("dataspace: replace link: %w", err)
		}
		touched = append(touched, conflict.SourceID, conflict.TargetID)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO links(relationship_id, source_id, target_id) VALUES(?, ?, ?)`,
		resolved.link.RelationshipID, resolved.link.SourceID, resolved.link.TargetID); err != nil {
		return false, fmt.Errorf("dataspace: link: %w", err)
	}
	return true, touchRecords(ctx, tx, s, touched)
}

func linkExists(ctx context.Context, tx *sql.Tx, link storedLink) (bool, error) {
	var one int
	err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM links WHERE relationship_id = ? AND source_id = ? AND target_id = ?`,
		link.RelationshipID, link.SourceID, link.TargetID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("dataspace: check link: %w", err)
	}
	return true, nil
}

// linkConflicts returns the links cardinality will not let stand next to the
// new one, on either side of the relationship.
func linkConflicts(ctx context.Context, tx *sql.Tx, resolved *resolvedLink) ([]storedLink, error) {
	sourceHoldsOne := resolved.rel.Cardinality == CardinalityManyToOne || resolved.rel.Cardinality == CardinalityOneToOne
	targetHoldsOne := resolved.rel.Cardinality == CardinalityOneToMany || resolved.rel.Cardinality == CardinalityOneToOne
	if !sourceHoldsOne && !targetHoldsOne {
		return nil, nil
	}
	clauses := []string{}
	args := []any{resolved.link.RelationshipID}
	if sourceHoldsOne {
		clauses = append(clauses, "source_id = ?")
		args = append(args, resolved.link.SourceID)
	}
	if targetHoldsOne {
		clauses = append(clauses, "target_id = ?")
		args = append(args, resolved.link.TargetID)
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT relationship_id, source_id, target_id FROM links
		 WHERE relationship_id = ? AND (`+strings.Join(clauses, " OR ")+`)
		 ORDER BY source_id, target_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("dataspace: find link conflicts: %w", err)
	}
	defer closeRows(rows)
	out := []storedLink{}
	for rows.Next() {
		var conflict storedLink
		if err := rows.Scan(&conflict.RelationshipID, &conflict.SourceID, &conflict.TargetID); err != nil {
			return nil, fmt.Errorf("dataspace: scan link conflict: %w", err)
		}
		out = append(out, conflict)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: find link conflicts: %w", err)
	}
	return out, nil
}

// conflictMessage explains which side is full and what replace would do.
func conflictMessage(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, resolved *resolvedLink, conflict storedLink) (string, error) {
	callerIsSource := resolved.link.SourceID == resolved.record.ID
	callerSideBlocked := conflict.SourceID == resolved.record.ID
	if !callerIsSource {
		callerSideBlocked = conflict.TargetID == resolved.record.ID
	}
	recordName, err := recordLabel(ctx, tx, snapshot, resolved.record.ID)
	if err != nil {
		return "", err
	}
	targetName, err := recordLabel(ctx, tx, snapshot, resolved.target.ID)
	if err != nil {
		return "", err
	}
	if callerSideBlocked {
		heldID := conflict.TargetID
		if !callerIsSource {
			heldID = conflict.SourceID
		}
		held, heldErr := recordLabel(ctx, tx, snapshot, heldID)
		if heldErr != nil {
			return "", heldErr
		}
		return fmt.Sprintf(
			"%s is already linked to %s through %s, which holds one %s. Pass replace to swap it for %s.",
			recordName, held, resolved.attr.Name, resolved.targetType.Name, targetName), nil
	}
	ownerID := conflict.SourceID
	if !callerIsSource {
		ownerID = conflict.TargetID
	}
	owner, ownerErr := recordLabel(ctx, tx, snapshot, ownerID)
	if ownerErr != nil {
		return "", ownerErr
	}
	return fmt.Sprintf(
		"%s is already linked to %s, and each %s can belong to one %s through %s. Pass replace to move it to %s.",
		targetName, owner, resolved.targetType.Name, resolved.entry.Name, resolved.attr.Name, recordName), nil
}

// recordLabel is a record's primary value, falling back to its id.
func recordLabel(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, recordID string) (string, error) {
	refs, err := refsFor(ctx, tx, snapshot, []string{recordID})
	if err != nil {
		return "", err
	}
	ref, ok := refs[recordID]
	if !ok || ref.Name == "" {
		return recordID, nil
	}
	return ref.Name, nil
}

func touchRecords(ctx context.Context, tx *sql.Tx, s *store, ids []string) error {
	unique := sortedCopy(ids)
	if len(unique) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(unique)), ",")
	args := make([]any, 0, len(unique)+1)
	args = append(args, s.stamp())
	for _, id := range unique {
		args = append(args, id)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE records SET updated_at = ? WHERE id IN (`+placeholders+`)`, args...); err != nil {
		return fmt.Errorf("dataspace: touch records: %w", err)
	}
	return nil
}
