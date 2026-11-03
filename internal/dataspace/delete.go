package dataspace

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

// DeleteTokenTTL is how long a delete preview stays valid.
const DeleteTokenTTL = 15 * time.Minute

// MaxLiveDeleteTokens caps the outstanding previews. Expiry alone is not a
// bound: nothing stops a caller previewing faster than tokens age out.
const MaxLiveDeleteTokens = 1000

// deleteBinding is what a token stands for: one kind, one id set, one space.
type deleteBinding struct {
	spaceID   string
	kind      DeleteKind
	ids       []string
	impact    Impact
	expiresAt time.Time
}

var deleteKinds = []DeleteKind{
	DeleteSpace, DeleteObjectType, DeleteAttribute, DeleteRecords, DeleteRecordsOfType,
}

func isDeleteKind(kind DeleteKind) bool {
	for _, item := range deleteKinds {
		if item == kind {
			return true
		}
	}
	return false
}

func joinDeleteKinds() string {
	names := make([]string, 0, len(deleteKinds))
	for _, item := range deleteKinds {
		names = append(names, string(item))
	}
	return strings.Join(names, ", ")
}

// deletePlan is everything an id set takes with it.
type deletePlan struct {
	deletesSpace    bool
	typeIDs         map[string]bool
	attributeIDs    map[string]bool
	relationshipIDs map[string]bool
	recordIDs       map[string]bool
	impact          Impact
}

func newPlan() *deletePlan {
	return &deletePlan{
		typeIDs:         map[string]bool{},
		attributeIDs:    map[string]bool{},
		relationshipIDs: map[string]bool{},
		recordIDs:       map[string]bool{},
	}
}

func keysOf(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	return sortedCopy(out)
}

func placeholdersFor(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func argsOf(ids []string) []any {
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	return args
}

// countLinksFor counts the links that go with a set of relationships and a set
// of records, without double counting a link caught by both.
func countLinksFor(ctx context.Context, tx *sql.Tx, relationshipIDs, recordIDs []string) (int, error) {
	if len(relationshipIDs) == 0 && len(recordIDs) == 0 {
		return 0, nil
	}
	clauses := []string{}
	args := []any{}
	if len(relationshipIDs) > 0 {
		clauses = append(clauses, "relationship_id IN ("+placeholdersFor(len(relationshipIDs))+")")
		args = append(args, argsOf(relationshipIDs)...)
	}
	if len(recordIDs) > 0 {
		clauses = append(clauses, "source_id IN ("+placeholdersFor(len(recordIDs))+")")
		args = append(args, argsOf(recordIDs)...)
		clauses = append(clauses, "target_id IN ("+placeholdersFor(len(recordIDs))+")")
		args = append(args, argsOf(recordIDs)...)
	}
	var count int
	err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM links WHERE `+strings.Join(clauses, " OR "), args...).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("dataspace: count links: %w", err)
	}
	return count, nil
}

func planRecords(ctx context.Context, tx *sql.Tx, ids []string) (*deletePlan, error) {
	plan := newPlan()
	missing := []string{}
	for _, id := range ids {
		var found string
		err := tx.QueryRowContext(ctx, `SELECT id FROM records WHERE id = ?`, id).Scan(&found)
		if err == sql.ErrNoRows {
			missing = append(missing, id)
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("dataspace: check record: %w", err)
		}
		plan.recordIDs[id] = true
	}
	if len(missing) > 0 {
		return nil, notFound("", "Unknown record ids: %s.", strings.Join(missing, ", "))
	}
	links, err := countLinksFor(ctx, tx, nil, keysOf(plan.recordIDs))
	if err != nil {
		return nil, err
	}
	plan.impact = Impact{Records: len(plan.recordIDs), Links: links}
	return plan, nil
}

func planAttributes(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, ids []string) (*deletePlan, error) {
	plan := newPlan()
	losingValue := map[string]bool{}
	for _, id := range ids {
		entry, attr := snapshot.findAttribute(id)
		if attr == nil {
			return nil, notFound("", "Unknown attribute id %q.", id)
		}
		if attr.IsPrimary {
			return nil, Invalid(attr.Slug,
				"%q is the primary attribute of %s and cannot be deleted.", attr.Name, entry.Name)
		}
		plan.attributeIDs[attr.ID] = true
		if attr.Relationship != nil {
			// The mirrored attribute and every link go with it.
			plan.relationshipIDs[attr.Relationship.RelationshipID] = true
			if attr.Relationship.InverseAttributeID != "" {
				plan.attributeIDs[attr.Relationship.InverseAttributeID] = true
			}
			continue
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT record_id FROM record_values WHERE attribute_id = ?`, attr.ID)
		if err != nil {
			return nil, fmt.Errorf("dataspace: find values: %w", err)
		}
		for rows.Next() {
			var recordID string
			if err := rows.Scan(&recordID); err != nil {
				closeRows(rows)
				return nil, fmt.Errorf("dataspace: scan value holder: %w", err)
			}
			losingValue[recordID] = true
		}
		if err := rows.Err(); err != nil {
			closeRows(rows)
			return nil, fmt.Errorf("dataspace: find values: %w", err)
		}
		closeRows(rows)
	}
	links, err := countLinksFor(ctx, tx, keysOf(plan.relationshipIDs), nil)
	if err != nil {
		return nil, err
	}
	plan.impact = Impact{
		Records:    len(losingValue),
		Links:      links,
		Attributes: len(plan.attributeIDs),
	}
	return plan, nil
}

func planTypes(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, ids []string) (*deletePlan, error) {
	plan := newPlan()
	missing := []string{}
	for _, id := range ids {
		if snapshot.typeByID(id) == nil {
			missing = append(missing, id)
			continue
		}
		plan.typeIDs[id] = true
	}
	if len(missing) > 0 {
		return nil, notFound("", "Unknown object type ids: %s.", strings.Join(missing, ", "))
	}
	for _, rel := range snapshot.rels {
		if plan.typeIDs[rel.SourceTypeID] || plan.typeIDs[rel.TargetTypeID] {
			plan.relationshipIDs[rel.ID] = true
		}
	}
	for _, entry := range snapshot.types {
		for _, attr := range entry.Attrs {
			pointsAtDeleted := attr.Relationship != nil && plan.relationshipIDs[attr.Relationship.RelationshipID]
			if plan.typeIDs[entry.ID] || pointsAtDeleted {
				plan.attributeIDs[attr.ID] = true
			}
		}
	}
	recordIDs, err := recordIDsOfTypes(ctx, tx, keysOf(plan.typeIDs))
	if err != nil {
		return nil, err
	}
	for _, id := range recordIDs {
		plan.recordIDs[id] = true
	}
	links, err := countLinksFor(ctx, tx, keysOf(plan.relationshipIDs), nil)
	if err != nil {
		return nil, err
	}
	plan.impact = Impact{
		Records:     len(plan.recordIDs),
		Links:       links,
		Attributes:  len(plan.attributeIDs),
		ObjectTypes: len(plan.typeIDs),
	}
	return plan, nil
}

// planRecordsOfType empties a type without removing it.
func planRecordsOfType(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, ids []string) (*deletePlan, error) {
	plan := newPlan()
	missing := []string{}
	typeIDs := []string{}
	for _, id := range ids {
		entry := snapshot.resolveType(id)
		if entry == nil {
			missing = append(missing, id)
			continue
		}
		typeIDs = append(typeIDs, entry.ID)
	}
	if len(missing) > 0 {
		return nil, notFound("", "Unknown object type ids: %s.", strings.Join(missing, ", "))
	}
	recordIDs, err := recordIDsOfTypes(ctx, tx, typeIDs)
	if err != nil {
		return nil, err
	}
	for _, id := range recordIDs {
		plan.recordIDs[id] = true
	}
	links, err := countLinksFor(ctx, tx, nil, keysOf(plan.recordIDs))
	if err != nil {
		return nil, err
	}
	plan.impact = Impact{Records: len(plan.recordIDs), Links: links}
	return plan, nil
}

func recordIDsOfTypes(ctx context.Context, tx *sql.Tx, typeIDs []string) ([]string, error) {
	if len(typeIDs) == 0 {
		return nil, nil
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM records WHERE type_id IN (`+placeholdersFor(len(typeIDs))+`)`,
		argsOf(typeIDs)...)
	if err != nil {
		return nil, fmt.Errorf("dataspace: find records: %w", err)
	}
	defer closeRows(rows)
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("dataspace: scan record id: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: find records: %w", err)
	}
	return out, nil
}

func planDelete(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, spaceID string, kind DeleteKind, rawIDs []string) (*deletePlan, error) {
	if !isDeleteKind(kind) {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%q cannot be deleted. Valid kinds: %s.", string(kind), joinDeleteKinds())}
	}
	ids := sortedCopy(rawIDs)
	if len(ids) == 0 {
		return nil, &ValidationError{Message: "Nothing to delete: the id list is empty."}
	}
	switch kind {
	case DeleteRecords:
		return planRecords(ctx, tx, ids)
	case DeleteAttribute:
		return planAttributes(ctx, tx, snapshot, ids)
	case DeleteObjectType:
		return planTypes(ctx, tx, snapshot, ids)
	case DeleteRecordsOfType:
		return planRecordsOfType(ctx, tx, snapshot, ids)
	case DeleteSpace:
		if len(ids) != 1 || ids[0] != spaceID {
			return nil, &ValidationError{Message: fmt.Sprintf(
				"A space delete takes exactly the space id %q.", spaceID)}
		}
		all := make([]string, 0, len(snapshot.types))
		for _, entry := range snapshot.types {
			all = append(all, entry.ID)
		}
		var plan *deletePlan
		if len(all) == 0 {
			plan = newPlan()
		} else {
			var err error
			plan, err = planTypes(ctx, tx, snapshot, all)
			if err != nil {
				return nil, err
			}
		}
		plan.deletesSpace = true
		return plan, nil
	default:
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%q cannot be deleted. Valid kinds: %s.", string(kind), joinDeleteKinds())}
	}
}

// applyDelete removes everything a plan resolved to. Foreign keys cascade the
// rows that hang off each one, which is why the order below does not matter.
func applyDelete(ctx context.Context, tx *sql.Tx, plan *deletePlan) error {
	deletions := []struct {
		table  string
		column string
		ids    []string
	}{
		{"relationships", "id", keysOf(plan.relationshipIDs)},
		{"attributes", "id", keysOf(plan.attributeIDs)},
		{"records", "id", keysOf(plan.recordIDs)},
		{"object_types", "id", keysOf(plan.typeIDs)},
	}
	for _, deletion := range deletions {
		if len(deletion.ids) == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM `+deletion.table+` WHERE `+deletion.column+` IN (`+
				placeholdersFor(len(deletion.ids))+`)`, argsOf(deletion.ids)...); err != nil {
			return fmt.Errorf("dataspace: delete from %s: %w", deletion.table, err)
		}
	}
	return nil
}

// ── Store: deletes ───────────────────────────────────────────────

// pruneTokensLocked drops every expired preview and, if that still leaves the
// map over its cap, the oldest live ones. s.tokenMu is held by the caller.
func (s *store) pruneTokensLocked() {
	now := s.now().UTC()
	for token, binding := range s.tokens {
		if now.After(binding.expiresAt) {
			delete(s.tokens, token)
		}
	}
	if len(s.tokens) < MaxLiveDeleteTokens {
		return
	}
	live := make([]string, 0, len(s.tokens))
	for token := range s.tokens {
		live = append(live, token)
	}
	sort.Slice(live, func(i, j int) bool {
		return s.tokens[live[i]].expiresAt.Before(s.tokens[live[j]].expiresAt)
	})
	// One short of the cap, so the preview being taken now still fits.
	for _, token := range live[:len(live)-MaxLiveDeleteTokens+1] {
		delete(s.tokens, token)
	}
}

func (s *store) PreviewDelete(ctx context.Context, actor Actor, spaceID string, kind DeleteKind, ids []string) (Preview, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Preview{}, err
	}
	defer unlock()
	if kind == DeleteSpace {
		if err := ownerOnly(actor, space, "deleting"); err != nil {
			return Preview{}, err
		}
	}
	var impact Impact
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		plan, planErr := planDelete(ctx, tx, snapshot, spaceID, kind, ids)
		if planErr != nil {
			return planErr
		}
		impact = plan.impact
		return nil
	})
	if err != nil {
		return Preview{}, err
	}
	expires := s.now().UTC().Add(DeleteTokenTTL)
	token := newID(prefixToken)
	s.tokenMu.Lock()
	// A preview that is never executed used to sit here for the life of the
	// process, because only executing that exact token removed it. Most
	// previews are never executed: they are what a bot does to find out what a
	// delete would cost, and then it changes its mind.
	s.pruneTokensLocked()
	s.tokens[token] = deleteBinding{
		spaceID:   spaceID,
		kind:      kind,
		ids:       sortedCopy(ids),
		impact:    impact,
		expiresAt: expires,
	}
	s.tokenMu.Unlock()
	return Preview{
		Token:     token,
		Kind:      kind,
		Impact:    impact,
		ExpiresAt: expires.Format(timestampLayout),
	}, nil
}

func (s *store) ExecuteDelete(ctx context.Context, actor Actor, spaceID, token string) (Impact, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Impact{}, err
	}
	defer unlock()
	s.tokenMu.Lock()
	binding, found := s.tokens[token]
	s.tokenMu.Unlock()
	if !found || binding.spaceID != spaceID {
		return Impact{}, &ValidationError{Message: "Unknown delete token. Run the delete preview again."}
	}
	// Checked before the token is consumed, so a caller who may not do this
	// cannot burn the owner's preview on the way to being refused. Both calls
	// hold this space's lock, so nothing can take the token in between.
	if binding.kind == DeleteSpace {
		if err := ownerOnly(actor, space, "deleting"); err != nil {
			return Impact{}, err
		}
	}
	s.tokenMu.Lock()
	// A token is single use, whether it succeeds, fails, or has expired.
	delete(s.tokens, token)
	s.tokenMu.Unlock()
	if s.now().UTC().After(binding.expiresAt) {
		return Impact{}, &ValidationError{Message: "This delete token has expired. Run the preview again."}
	}

	var (
		impact       Impact
		deletesSpace bool
	)
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		// Re-planned against current state, so a stale id set fails loudly.
		plan, planErr := planDelete(ctx, tx, snapshot, spaceID, binding.kind, binding.ids)
		if planErr != nil {
			return planErr
		}
		if plan.impact != binding.impact {
			return &ValidationError{Message: fmt.Sprintf(
				"This delete would now remove %s, not %s as previewed. Run the preview again.",
				describeImpact(plan.impact), describeImpact(binding.impact))}
		}
		if err := applyDelete(ctx, tx, plan); err != nil {
			return err
		}
		impact = plan.impact
		deletesSpace = plan.deletesSpace
		return nil
	})
	if err != nil {
		return Impact{}, err
	}
	if deletesSpace {
		if err := s.removeSpace(ctx, spaceID); err != nil {
			return Impact{}, err
		}
		return impact, nil
	}
	if _, err := s.touchSpace(ctx, space); err != nil {
		return Impact{}, err
	}
	return impact, nil
}

func describeImpact(impact Impact) string {
	return fmt.Sprintf("%d object types, %d attributes, %d records and %d links",
		impact.ObjectTypes, impact.Attributes, impact.Records, impact.Links)
}
