package dataspace

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

var currencyCodePattern = regexp.MustCompile(`^[A-Z]{3}$`)

// ── Store: attributes ────────────────────────────────────────────

func (s *store) AddAttributes(ctx context.Context, actor Actor, spaceID, typeRef string, inputs []AttributeInput) (Result, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Result{}, err
	}
	defer unlock()
	if len(inputs) > MaxAttributesPerType {
		return Result{}, tooMany("attributes", len(inputs), MaxAttributesPerType)
	}
	out := newResult("attribute", "created", len(inputs))
	who := normalizeActor(actor)
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		// The type reference is resolved once; the snapshot is reloaded per
		// entry so a later relationship sees the attributes just added.
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		resolved, typeErr := snapshot.requireType(typeRef)
		if typeErr != nil {
			return typeErr
		}
		typeID := resolved.ID
		for index, input := range inputs {
			snapshot, loadErr = loadSchema(ctx, tx)
			if loadErr != nil {
				return loadErr
			}
			entry := snapshot.typeByID(typeID)
			if entry == nil {
				// Defensive: the space lock and the transaction mean the type
				// resolved above cannot go away mid-loop. It carries a message
				// anyway, because a bare ErrNotFound is reserved for a space
				// the caller may not see and reads as an opaque 404.
				return notFound("", "Unknown object type %q.", typeRef)
			}
			var created *Attribute
			entryErr := savepoint(ctx, tx, fmt.Sprintf("attr_%d", index), func() error {
				attr, addErr := addAttribute(ctx, tx, snapshot, who, entry, input)
				if addErr != nil {
					return addErr
				}
				created = attr
				return nil
			})
			if entryErr != nil {
				if isFatal(entryErr) {
					return entryErr
				}
				out.addError(index, strings.TrimSpace(input.Name), entryErr)
				continue
			}
			out.add(index, created.Name, created.ID)
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

// addAttribute creates one attribute on entry, mutating the snapshot so the
// next attribute in the same call sees it.
func addAttribute(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, actor string, entry *typeEntry, input AttributeInput) (*Attribute, error) {
	name, err := cleanName(input.Name, "An attribute")
	if err != nil {
		return nil, err
	}
	if !isAttributeType(input.Type) {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: %q is not an attribute type. Valid: %s.", name, string(input.Type), joinAttributeTypes())}
	}
	if len(entry.Attrs) >= MaxAttributesPerType {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s already has %d attributes.", entry.Name, MaxAttributesPerType)}
	}
	if err := assertNameFree(entry, name, ""); err != nil {
		return nil, err
	}
	if input.Type == TypeRelationship {
		return addRelationship(ctx, tx, snapshot, actor, entry, input, name)
	}
	attr, err := buildValueAttribute(actor, entry, input, name)
	if err != nil {
		return nil, err
	}
	if err := insertAttribute(ctx, tx, entry.ID, attr, len(entry.Attrs)); err != nil {
		return nil, err
	}
	entry.Attrs = append(entry.Attrs, attr)
	return attr, nil
}

func assertNameFree(entry *typeEntry, name, exceptID string) error {
	for _, attr := range entry.Attrs {
		if attr.ID != exceptID && sameName(attr.Name, name) {
			return &ValidationError{Message: fmt.Sprintf(
				"%s already has an attribute named %q (slug %s). Reuse it instead of adding a duplicate.",
				entry.Name, attr.Name, attr.Slug)}
		}
	}
	return nil
}

// baseSlug picks an attribute's slug: an explicit one when given, otherwise
// derived from the name, and uniquified within the type either way. It never
// changes again, whatever the attribute is renamed to.
func baseSlug(entry *typeEntry, input AttributeInput, name string) string {
	source := strings.TrimSpace(input.Slug)
	if source == "" {
		source = name
	}
	return uniqueSlug(slugify(source, "field"), entry.slugsTaken())
}

func buildValueAttribute(actor string, entry *typeEntry, input AttributeInput, name string) (*Attribute, error) {
	if err := assertFlags(input, name); err != nil {
		return nil, err
	}
	if input.Relationship != nil {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: only relationship attributes take a relationship target.", name)}
	}
	optionNames, err := cleanOptionNames(input.Options)
	if err != nil {
		return nil, err
	}
	if !isOptionType(input.Type) && len(optionNames) > 0 {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: options are only valid for select and status attributes.", name)}
	}
	if input.Type == TypeSelect && len(optionNames) == 0 {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: a select attribute needs at least one option.", name)}
	}
	if input.Type == TypeStatus && len(optionNames) == 0 {
		optionNames = append([]string{}, DefaultStatusOptions...)
	}
	currencyCode := ""
	if input.Type == TypeCurrency {
		currencyCode = strings.ToUpper(strings.TrimSpace(input.CurrencyCode))
		if currencyCode == "" {
			currencyCode = DefaultCurrencyCode
		}
		if !currencyCodePattern.MatchString(currencyCode) {
			return nil, &ValidationError{Message: fmt.Sprintf(
				"%s: %q is not a three letter currency code.", name, currencyCode)}
		}
	}
	return &Attribute{
		ID:           newID(prefixAttribute),
		Slug:         baseSlug(entry, input, name),
		Name:         name,
		Type:         input.Type,
		Description:  strings.TrimSpace(input.Description),
		IsRequired:   input.IsRequired,
		IsUnique:     input.IsUnique,
		IsMultivalue: input.IsMultivalue,
		Options:      mintOptions(optionNames, 0),
		CurrencyCode: currencyCode,
		CreatedBy:    actor,
	}, nil
}

func assertFlags(input AttributeInput, name string) error {
	if input.Type == TypeStatus && input.IsMultivalue {
		return &ValidationError{Message: fmt.Sprintf(
			"%s: a status attribute holds exactly one value.", name)}
	}
	if input.IsMultivalue && !isMultivalueType(input.Type) {
		return &ValidationError{Message: fmt.Sprintf(
			"%s: only %s attributes can hold multiple values.", name, joinMultivalueTypes())}
	}
	if input.IsMultivalue && input.IsUnique {
		return &ValidationError{Message: fmt.Sprintf(
			"%s: a unique attribute cannot hold multiple values.", name)}
	}
	if input.Type == TypeToggle && input.IsUnique {
		return &ValidationError{Message: fmt.Sprintf(
			"%s: a toggle attribute cannot be unique.", name)}
	}
	return nil
}

func cleanOptionNames(raw []string) ([]string, error) {
	names := make([]string, 0, len(raw))
	for _, item := range raw {
		name, err := cleanName(item, "An option")
		if err != nil {
			return nil, err
		}
		for _, seen := range names {
			if sameName(seen, name) {
				return nil, &ValidationError{Message: fmt.Sprintf(
					"Option %q is listed twice. Option names must be unique.", name)}
			}
		}
		names = append(names, name)
	}
	return names, nil
}

// mintOptions assigns ids and round-robins the color slots from startIndex.
func mintOptions(names []string, startIndex int) []SelectOption {
	if len(names) == 0 {
		return nil
	}
	options := make([]SelectOption, 0, len(names))
	for index, name := range names {
		options = append(options, SelectOption{
			ID:    newID(prefixOption),
			Name:  name,
			Color: OptionColors[(startIndex+index)%len(OptionColors)],
		})
	}
	return options
}

// addRelationship creates the owning attribute, the mirrored attribute on the
// target, and the relationship row, all inside the caller's transaction.
func addRelationship(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, actor string, entry *typeEntry, input AttributeInput, name string) (*Attribute, error) {
	rel := input.Relationship
	if rel == nil {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: a relationship attribute needs a target type.", name)}
	}
	if input.IsUnique || input.IsMultivalue || input.IsRequired {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: relationship attributes do not take required, unique, or multivalue. Cardinality covers it.", name)}
	}
	if len(input.Options) > 0 {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: options are only valid for select and status attributes.", name)}
	}
	if !isCardinality(rel.Cardinality) {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: %q is not a cardinality. Valid: %s.", name, string(rel.Cardinality), joinCardinalities())}
	}
	if resolved := snapshot.resolveType(rel.Target); resolved != nil && resolved.ID == entry.ID {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"%s: an object type cannot have a relationship to itself.", name)}
	}
	target, err := snapshot.requireType(rel.Target)
	if err != nil {
		return nil, err
	}
	if err := assertNoDuplicateRelationship(snapshot, entry, target, name); err != nil {
		return nil, err
	}

	relationshipID := newID(prefixRelation)
	inverseName := strings.TrimSpace(rel.InverseName)
	var mirrored *Attribute
	if inverseName != "" {
		if len(target.Attrs) >= MaxAttributesPerType {
			return nil, &ValidationError{Message: fmt.Sprintf(
				"%s already has %d attributes.", target.Name, MaxAttributesPerType)}
		}
		if err := assertNameFree(target, inverseName, ""); err != nil {
			return nil, err
		}
		mirrored = &Attribute{
			ID:        newID(prefixAttribute),
			Slug:      uniqueSlug(slugify(inverseName, "field"), target.slugsTaken()),
			Name:      inverseName,
			Type:      TypeRelationship,
			CreatedBy: actor,
		}
	}
	owning := &Attribute{
		ID:          newID(prefixAttribute),
		Slug:        baseSlug(entry, input, name),
		Name:        name,
		Type:        TypeRelationship,
		Description: strings.TrimSpace(input.Description),
		CreatedBy:   actor,
	}
	inverseID := ""
	if mirrored != nil {
		inverseID = mirrored.ID
	}
	owning.Relationship = &RelationshipRef{
		RelationshipID:     relationshipID,
		TargetTypeID:       target.ID,
		Cardinality:        rel.Cardinality,
		InverseAttributeID: inverseID,
	}
	if mirrored != nil {
		mirrored.Relationship = &RelationshipRef{
			RelationshipID:     relationshipID,
			TargetTypeID:       entry.ID,
			Cardinality:        flipCardinality(rel.Cardinality),
			InverseAttributeID: owning.ID,
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO relationships(id, source_type_id, source_attribute_id, target_type_id, inverse_attribute_id, cardinality)
		 VALUES(?, ?, ?, ?, ?, ?)`,
		relationshipID, entry.ID, owning.ID, target.ID, inverseID, string(rel.Cardinality)); err != nil {
		return nil, fmt.Errorf("dataspace: insert relationship: %w", err)
	}
	if err := insertAttribute(ctx, tx, entry.ID, owning, len(entry.Attrs)); err != nil {
		return nil, err
	}
	entry.Attrs = append(entry.Attrs, owning)
	if mirrored != nil {
		if err := insertAttribute(ctx, tx, target.ID, mirrored, len(target.Attrs)); err != nil {
			return nil, err
		}
		target.Attrs = append(target.Attrs, mirrored)
	}
	snapshot.rels[relationshipID] = &Relationship{
		ID:                 relationshipID,
		SourceTypeID:       entry.ID,
		SourceAttributeID:  owning.ID,
		TargetTypeID:       target.ID,
		InverseAttributeID: inverseID,
		Cardinality:        rel.Cardinality,
	}
	return owning, nil
}

// assertNoDuplicateRelationship refuses the same pair of types, in either
// orientation, under the same owning attribute name.
func assertNoDuplicateRelationship(snapshot *schemaSnapshot, entry, target *typeEntry, name string) error {
	for _, existing := range snapshot.rels {
		samePair := (existing.SourceTypeID == entry.ID && existing.TargetTypeID == target.ID) ||
			(existing.SourceTypeID == target.ID && existing.TargetTypeID == entry.ID)
		if !samePair {
			continue
		}
		owner := snapshot.typeByID(existing.SourceTypeID)
		if owner == nil {
			continue
		}
		attr := owner.attrByID(existing.SourceAttributeID)
		if attr == nil || !sameName(attr.Name, name) {
			continue
		}
		return &ValidationError{Message: fmt.Sprintf(
			"%s and %s are already related through %q. Reuse that relationship.",
			entry.Name, target.Name, attr.Name)}
	}
	return nil
}

func insertAttribute(ctx context.Context, tx *sql.Tx, typeID string, attr *Attribute, position int) error {
	relationshipID := ""
	if attr.Relationship != nil {
		relationshipID = attr.Relationship.RelationshipID
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO attributes(id, type_id, slug, name, name_key, kind, description, is_primary,
		                        is_required, is_unique, is_multivalue, currency_code, relationship_id,
		                        created_by, position)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		attr.ID, typeID, attr.Slug, attr.Name, nameKey(attr.Name), string(attr.Type), attr.Description,
		attr.IsPrimary, attr.IsRequired, attr.IsUnique, attr.IsMultivalue, attr.CurrencyCode,
		relationshipID, attr.CreatedBy, position); err != nil {
		return fmt.Errorf("dataspace: insert attribute: %w", err)
	}
	return insertOptions(ctx, tx, attr.ID, attr.Options, 0)
}

func insertOptions(ctx context.Context, tx *sql.Tx, attributeID string, options []SelectOption, startPosition int) error {
	for index, option := range options {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO select_options(id, attribute_id, name, name_key, color, position)
			 VALUES(?, ?, ?, ?, ?, ?)`,
			option.ID, attributeID, option.Name, nameKey(option.Name), option.Color, startPosition+index); err != nil {
			return fmt.Errorf("dataspace: insert option: %w", err)
		}
	}
	return nil
}

// nameKey is the case-insensitive key the UNIQUE indexes on names use. It is
// computed in Go rather than with SQLite's lower(), which is ASCII only.
func nameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func (s *store) UpdateAttribute(ctx context.Context, actor Actor, spaceID, typeRef, attrRef string, patch AttributePatch) (Attribute, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Attribute{}, err
	}
	defer unlock()
	var out Attribute
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		entry, typeErr := snapshot.requireType(typeRef)
		if typeErr != nil {
			return typeErr
		}
		attr := resolveAttributeRef(entry, attrRef)
		if attr == nil {
			return notFound("", "%s has no attribute with id %q.", entry.Name, attrRef)
		}
		next := cloneAttribute(*attr)
		if patch.Name != nil {
			name, nameErr := cleanName(*patch.Name, "An attribute")
			if nameErr != nil {
				return nameErr
			}
			if err := assertNameFree(entry, name, attr.ID); err != nil {
				return err
			}
			// The slug is deliberately left alone: a rename never changes it.
			next.Name = name
		}
		if patch.Description != nil {
			next.Description = strings.TrimSpace(*patch.Description)
		}
		if patch.IsRequired != nil {
			if err := assertRequiredChange(attr, *patch.IsRequired); err != nil {
				return err
			}
			next.IsRequired = *patch.IsRequired
		}
		if patch.AddOptions != nil || patch.RenameOption != nil {
			if !isOptionType(attr.Type) {
				return Invalid(attr.Slug, "%s is a %s attribute and has no options.", attr.Name, string(attr.Type))
			}
			options, optionErr := patchOptions(ctx, tx, attr, patch)
			if optionErr != nil {
				return optionErr
			}
			next.Options = options
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE attributes SET name = ?, name_key = ?, description = ?, is_required = ? WHERE id = ?`,
			next.Name, nameKey(next.Name), next.Description, next.IsRequired, next.ID); err != nil {
			return fmt.Errorf("dataspace: update attribute: %w", err)
		}
		out = next
		return nil
	})
	if err != nil {
		return Attribute{}, err
	}
	if _, err := s.touchSpace(ctx, space); err != nil {
		return Attribute{}, err
	}
	return out, nil
}

// resolveAttributeRef finds an attribute by id, then slug, then name.
func resolveAttributeRef(entry *typeEntry, ref string) *Attribute {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil
	}
	if attr := entry.attrByID(ref); attr != nil {
		return attr
	}
	if attr := entry.attrBySlug(strings.ToLower(ref)); attr != nil {
		return attr
	}
	return entry.attrByName(ref)
}

func assertRequiredChange(attr *Attribute, isRequired bool) error {
	if attr.IsPrimary && !isRequired {
		return Invalid(attr.Slug, "The primary attribute is always required.")
	}
	if attr.Type == TypeRelationship && isRequired {
		return Invalid(attr.Slug, "A relationship attribute cannot be required.")
	}
	return nil
}

// patchOptions appends and renames options, writing only what changed. An
// option id survives a rename, so no record is rewritten.
func patchOptions(ctx context.Context, tx *sql.Tx, attr *Attribute, patch AttributePatch) ([]SelectOption, error) {
	options := make([]SelectOption, len(attr.Options))
	copy(options, attr.Options)
	for _, raw := range patch.AddOptions {
		name, err := cleanName(raw, "An option")
		if err != nil {
			return nil, err
		}
		// An existing name, in any letter case, is a no-op.
		exists := false
		for _, option := range options {
			if sameName(option.Name, name) {
				exists = true
				break
			}
		}
		if exists {
			continue
		}
		minted := mintOptions([]string{name}, len(options))
		if err := insertOptions(ctx, tx, attr.ID, minted, len(options)); err != nil {
			return nil, err
		}
		options = append(options, minted...)
	}
	if patch.RenameOption != nil {
		id := patch.RenameOption.ID
		name, err := cleanName(patch.RenameOption.Name, "An option")
		if err != nil {
			return nil, err
		}
		found := -1
		for index, option := range options {
			if option.ID == id {
				found = index
			}
		}
		if found < 0 {
			return nil, Invalid(attr.Slug, "%s has no option with id %q.", attr.Name, id)
		}
		for _, option := range options {
			if option.ID != id && sameName(option.Name, name) {
				return nil, Invalid(attr.Slug, "%s already has an option named %q.", attr.Name, option.Name)
			}
		}
		options[found].Name = name
		if _, err := tx.ExecContext(ctx,
			`UPDATE select_options SET name = ?, name_key = ? WHERE id = ?`,
			name, nameKey(name), id); err != nil {
			return nil, fmt.Errorf("dataspace: rename option: %w", err)
		}
	}
	return options, nil
}
