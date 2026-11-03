package dataspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// PrimaryAttributeSlug is the slug of the required text attribute every object
// type gets on creation. A record's display name is always this attribute.
const PrimaryAttributeSlug = "name"

// PrimaryAttributeName is the display name that attribute starts with; it can
// be renamed, and the slug still does not move.
const PrimaryAttributeName = "Name"

// DefaultObjectTypeIcon is the icon an object type gets when none is given.
const DefaultObjectTypeIcon = "box"

// DefaultCurrencyCode is the ISO 4217 code a currency attribute defaults to.
const DefaultCurrencyCode = "USD"

// DefaultStatusOptions are the options a status attribute gets when the caller
// names none.
var DefaultStatusOptions = []string{"To do", "In progress", "Done"}

// OptionColors are the semantic color slots options cycle through, matching
// OPTION_COLORS in web/src/api/dataspaces.ts.
var OptionColors = []string{"neutral", "blue", "green", "yellow", "red", "purple"}

// multivalueTypes are the attribute types that may hold more than one value.
var multivalueTypes = []AttributeType{TypeSelect, TypeEmail, TypeURL}

// optionTypes are the attribute types that carry select options.
var optionTypes = []AttributeType{TypeSelect, TypeStatus}

// attributeTypes is the closed set, in the order the error message lists them.
var attributeTypes = []AttributeType{
	TypeText, TypeNumber, TypeCurrency, TypeDate, TypeToggle, TypeSelect,
	TypeStatus, TypeRating, TypeURL, TypeEmail, TypePhone, TypeRelationship,
}

// cardinalities is the closed set, in the order the error message lists them.
var cardinalities = []Cardinality{
	CardinalityOneToOne, CardinalityManyToOne, CardinalityOneToMany, CardinalityManyToMany,
}

func isOptionType(t AttributeType) bool {
	for _, item := range optionTypes {
		if item == t {
			return true
		}
	}
	return false
}

func isMultivalueType(t AttributeType) bool {
	for _, item := range multivalueTypes {
		if item == t {
			return true
		}
	}
	return false
}

func isAttributeType(t AttributeType) bool {
	for _, item := range attributeTypes {
		if item == t {
			return true
		}
	}
	return false
}

func isCardinality(c Cardinality) bool {
	for _, item := range cardinalities {
		if item == c {
			return true
		}
	}
	return false
}

func joinAttributeTypes() string {
	names := make([]string, 0, len(attributeTypes))
	for _, item := range attributeTypes {
		names = append(names, string(item))
	}
	return strings.Join(names, ", ")
}

func joinCardinalities() string {
	names := make([]string, 0, len(cardinalities))
	for _, item := range cardinalities {
		names = append(names, string(item))
	}
	return strings.Join(names, ", ")
}

func joinMultivalueTypes() string {
	names := make([]string, 0, len(multivalueTypes))
	for _, item := range multivalueTypes {
		names = append(names, string(item))
	}
	return strings.Join(names, ", ")
}

// flipCardinality mirrors a cardinality onto the other side of a relationship.
func flipCardinality(c Cardinality) Cardinality {
	switch c {
	case CardinalityManyToOne:
		return CardinalityOneToMany
	case CardinalityOneToMany:
		return CardinalityManyToOne
	case CardinalityOneToOne, CardinalityManyToMany:
		return c
	default:
		return c
	}
}

// typeEntry is one object type and its attributes, loaded for the length of
// one call. It is read-only: writes go to SQL and the snapshot is reloaded.
type typeEntry struct {
	ID          string
	Slug        string
	Name        string
	NamePlural  string
	Icon        string
	Description string
	CreatedBy   string
	CreatedAt   string
	Position    int
	Attrs       []*Attribute
}

func (t *typeEntry) primary() *Attribute {
	for _, attr := range t.Attrs {
		if attr.IsPrimary {
			return attr
		}
	}
	return nil
}

func (t *typeEntry) attrBySlug(slug string) *Attribute {
	for _, attr := range t.Attrs {
		if attr.Slug == slug {
			return attr
		}
	}
	return nil
}

func (t *typeEntry) attrByID(id string) *Attribute {
	for _, attr := range t.Attrs {
		if attr.ID == id {
			return attr
		}
	}
	return nil
}

func (t *typeEntry) attrByName(name string) *Attribute {
	for _, attr := range t.Attrs {
		if sameName(attr.Name, name) {
			return attr
		}
	}
	return nil
}

func (t *typeEntry) slugsTaken() map[string]bool {
	taken := make(map[string]bool, len(t.Attrs))
	for _, attr := range t.Attrs {
		taken[attr.Slug] = true
	}
	return taken
}

func (t *typeEntry) objectType(recordCount int) ObjectType {
	attrs := make([]Attribute, 0, len(t.Attrs))
	for _, attr := range t.Attrs {
		attrs = append(attrs, cloneAttribute(*attr))
	}
	return ObjectType{
		ID:          t.ID,
		Slug:        t.Slug,
		Name:        t.Name,
		NamePlural:  t.NamePlural,
		Icon:        t.Icon,
		Description: t.Description,
		Attributes:  attrs,
		RecordCount: recordCount,
		CreatedBy:   t.CreatedBy,
		CreatedAt:   t.CreatedAt,
	}
}

func cloneAttribute(attr Attribute) Attribute {
	if len(attr.Options) > 0 {
		options := make([]SelectOption, len(attr.Options))
		copy(options, attr.Options)
		attr.Options = options
	}
	if attr.Relationship != nil {
		ref := *attr.Relationship
		attr.Relationship = &ref
	}
	return attr
}

// schemaSnapshot is every type, attribute and relationship in one space.
type schemaSnapshot struct {
	types []*typeEntry
	rels  map[string]*Relationship
}

func (s *schemaSnapshot) typeByID(id string) *typeEntry {
	for _, entry := range s.types {
		if entry.ID == id {
			return entry
		}
	}
	return nil
}

// resolveType finds an object type by id, slug, or name, in that order.
func (s *schemaSnapshot) resolveType(ref string) *typeEntry {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil
	}
	if entry := s.typeByID(ref); entry != nil {
		return entry
	}
	lowered := strings.ToLower(ref)
	for _, entry := range s.types {
		if entry.Slug == lowered {
			return entry
		}
	}
	for _, entry := range s.types {
		if sameName(entry.Name, ref) {
			return entry
		}
	}
	for _, entry := range s.types {
		if sameName(entry.NamePlural, ref) {
			return entry
		}
	}
	return nil
}

// requireType resolves a type reference or explains what is available.
func (s *schemaSnapshot) requireType(ref string) (*typeEntry, error) {
	if entry := s.resolveType(ref); entry != nil {
		return entry, nil
	}
	known := make([]string, 0, len(s.types))
	for _, entry := range s.types {
		known = append(known, entry.ID)
	}
	listed := strings.Join(known, ", ")
	if listed == "" {
		listed = "none"
	}
	return nil, notFound("", "Unknown object type %q. Known object types: %s.", ref, listed)
}

// findAttribute locates an attribute by id anywhere in the space.
func (s *schemaSnapshot) findAttribute(attributeID string) (*typeEntry, *Attribute) {
	for _, entry := range s.types {
		if attr := entry.attrByID(attributeID); attr != nil {
			return entry, attr
		}
	}
	return nil, nil
}

// loadSchema reads every type, attribute, option and relationship of a space.
// The schema is small by construction (50 types of 100 attributes at most), so
// one snapshot per call keeps the rules readable and matches the mock, which
// validates against a whole-space state.
func loadSchema(ctx context.Context, tx *sql.Tx) (*schemaSnapshot, error) {
	snapshot := &schemaSnapshot{rels: map[string]*Relationship{}}

	relRows, err := tx.QueryContext(ctx,
		`SELECT id, source_type_id, source_attribute_id, target_type_id, inverse_attribute_id, cardinality
		 FROM relationships`)
	if err != nil {
		return nil, fmt.Errorf("dataspace: load relationships: %w", err)
	}
	defer closeRows(relRows)
	for relRows.Next() {
		var rel Relationship
		if err := relRows.Scan(&rel.ID, &rel.SourceTypeID, &rel.SourceAttributeID,
			&rel.TargetTypeID, &rel.InverseAttributeID, &rel.Cardinality); err != nil {
			return nil, fmt.Errorf("dataspace: scan relationship: %w", err)
		}
		stored := rel
		snapshot.rels[rel.ID] = &stored
	}
	if err := relRows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: load relationships: %w", err)
	}

	typeRows, err := tx.QueryContext(ctx,
		`SELECT id, slug, name, name_plural, icon, description, created_by, created_at, position
		 FROM object_types ORDER BY position, id`)
	if err != nil {
		return nil, fmt.Errorf("dataspace: load object types: %w", err)
	}
	defer closeRows(typeRows)
	byID := map[string]*typeEntry{}
	for typeRows.Next() {
		entry := &typeEntry{}
		if err := typeRows.Scan(&entry.ID, &entry.Slug, &entry.Name, &entry.NamePlural,
			&entry.Icon, &entry.Description, &entry.CreatedBy, &entry.CreatedAt, &entry.Position); err != nil {
			return nil, fmt.Errorf("dataspace: scan object type: %w", err)
		}
		snapshot.types = append(snapshot.types, entry)
		byID[entry.ID] = entry
	}
	if err := typeRows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: load object types: %w", err)
	}

	options, err := loadOptions(ctx, tx)
	if err != nil {
		return nil, err
	}

	attrRows, err := tx.QueryContext(ctx,
		`SELECT id, type_id, slug, name, kind, description, is_primary, is_required,
		        is_unique, is_multivalue, currency_code, relationship_id, created_by
		 FROM attributes ORDER BY type_id, position, id`)
	if err != nil {
		return nil, fmt.Errorf("dataspace: load attributes: %w", err)
	}
	defer closeRows(attrRows)
	for attrRows.Next() {
		var (
			attr           Attribute
			typeID         string
			relationshipID string
		)
		if err := attrRows.Scan(&attr.ID, &typeID, &attr.Slug, &attr.Name, &attr.Type,
			&attr.Description, &attr.IsPrimary, &attr.IsRequired, &attr.IsUnique,
			&attr.IsMultivalue, &attr.CurrencyCode, &relationshipID, &attr.CreatedBy); err != nil {
			return nil, fmt.Errorf("dataspace: scan attribute: %w", err)
		}
		attr.Options = options[attr.ID]
		if relationshipID != "" {
			rel, ok := snapshot.rels[relationshipID]
			if !ok {
				return nil, fmt.Errorf("dataspace: attribute %s names missing relationship %s", attr.ID, relationshipID)
			}
			ref := &RelationshipRef{RelationshipID: rel.ID}
			if rel.SourceAttributeID == attr.ID {
				ref.TargetTypeID = rel.TargetTypeID
				ref.Cardinality = rel.Cardinality
				ref.InverseAttributeID = rel.InverseAttributeID
			} else {
				ref.TargetTypeID = rel.SourceTypeID
				ref.Cardinality = flipCardinality(rel.Cardinality)
				ref.InverseAttributeID = rel.SourceAttributeID
			}
			attr.Relationship = ref
		}
		entry, ok := byID[typeID]
		if !ok {
			return nil, fmt.Errorf("dataspace: attribute %s names missing object type %s", attr.ID, typeID)
		}
		stored := attr
		entry.Attrs = append(entry.Attrs, &stored)
	}
	if err := attrRows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: load attributes: %w", err)
	}
	return snapshot, nil
}

func loadOptions(ctx context.Context, tx *sql.Tx) (map[string][]SelectOption, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT id, attribute_id, name, color FROM select_options ORDER BY attribute_id, position, id`)
	if err != nil {
		return nil, fmt.Errorf("dataspace: load options: %w", err)
	}
	defer closeRows(rows)
	out := map[string][]SelectOption{}
	for rows.Next() {
		var (
			option      SelectOption
			attributeID string
		)
		if err := rows.Scan(&option.ID, &attributeID, &option.Name, &option.Color); err != nil {
			return nil, fmt.Errorf("dataspace: scan option: %w", err)
		}
		out[attributeID] = append(out[attributeID], option)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: load options: %w", err)
	}
	return out, nil
}

// recordCounts returns the number of records per object type.
func recordCounts(ctx context.Context, tx *sql.Tx) (map[string]int, error) {
	rows, err := tx.QueryContext(ctx, `SELECT type_id, COUNT(*) FROM records GROUP BY type_id`)
	if err != nil {
		return nil, fmt.Errorf("dataspace: count records: %w", err)
	}
	defer closeRows(rows)
	counts := map[string]int{}
	for rows.Next() {
		var (
			typeID string
			count  int
		)
		if err := rows.Scan(&typeID, &count); err != nil {
			return nil, fmt.Errorf("dataspace: scan record count: %w", err)
		}
		counts[typeID] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: count records: %w", err)
	}
	return counts, nil
}

func totalRecords(ctx context.Context, tx *sql.Tx) (int, error) {
	var total int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM records`).Scan(&total); err != nil {
		return 0, fmt.Errorf("dataspace: count records: %w", err)
	}
	return total, nil
}

func nextPosition(ctx context.Context, tx *sql.Tx, query string, args ...any) (int, error) {
	var next sql.NullInt64
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&next); err != nil {
		return 0, fmt.Errorf("dataspace: next position: %w", err)
	}
	if !next.Valid {
		return 0, nil
	}
	return int(next.Int64) + 1, nil
}
