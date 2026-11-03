package dataspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// ── Store: object types ──────────────────────────────────────────

func (s *store) CreateObjectTypes(ctx context.Context, actor Actor, spaceID string, inputs []ObjectTypeInput) (Result, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Result{}, err
	}
	defer unlock()
	if len(inputs) > MaxObjectTypesPerSpace {
		return Result{}, tooMany("object types", len(inputs), MaxObjectTypesPerSpace)
	}
	out := newResult("object type", "created", len(inputs))
	who := normalizeActor(actor)
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		for index, input := range inputs {
			// Reloaded per entry so a relationship in a later entry resolves
			// against the types the earlier ones created.
			snapshot, loadErr := loadSchema(ctx, tx)
			if loadErr != nil {
				return loadErr
			}
			var created *typeEntry
			entryErr := savepoint(ctx, tx, fmt.Sprintf("type_%d", index), func() error {
				entry, createErr := createObjectType(ctx, tx, snapshot, who, s.stamp(), input)
				if createErr != nil {
					return createErr
				}
				created = entry
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

// createObjectType creates one type, its primary attribute, and every
// attribute declared with it. The caller wraps it in a savepoint, so a failure
// anywhere leaves no half-built type behind.
func createObjectType(ctx context.Context, tx *sql.Tx, snapshot *schemaSnapshot, actor, stamp string, input ObjectTypeInput) (*typeEntry, error) {
	name, err := cleanName(input.Name, "An object type")
	if err != nil {
		return nil, err
	}
	if len(snapshot.types) >= MaxObjectTypesPerSpace {
		return nil, &ValidationError{Message: fmt.Sprintf(
			"A space holds at most %d object types.", MaxObjectTypesPerSpace)}
	}
	for _, existing := range snapshot.types {
		if sameName(existing.Name, name) {
			return nil, &ValidationError{Message: fmt.Sprintf(
				"An object type named %q already exists (id %s). Add attributes to it instead of creating a second one.",
				existing.Name, existing.ID)}
		}
	}
	taken := make(map[string]bool, len(snapshot.types))
	for _, existing := range snapshot.types {
		taken[existing.Slug] = true
	}
	namePlural := strings.TrimSpace(input.NamePlural)
	if namePlural == "" {
		namePlural = name + "s"
	}
	icon := strings.TrimSpace(input.Icon)
	if icon == "" {
		icon = DefaultObjectTypeIcon
	}
	entry := &typeEntry{
		ID:          newID(prefixType),
		Slug:        uniqueSlug(slugify(name, "object"), taken),
		Name:        name,
		NamePlural:  namePlural,
		Icon:        icon,
		Description: strings.TrimSpace(input.Description),
		CreatedBy:   actor,
		CreatedAt:   stamp,
		Position:    len(snapshot.types),
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO object_types(id, slug, name, name_key, name_plural, icon, description, created_by, created_at, position)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.ID, entry.Slug, entry.Name, nameKey(entry.Name), entry.NamePlural, entry.Icon,
		entry.Description, entry.CreatedBy, entry.CreatedAt, entry.Position); err != nil {
		return nil, fmt.Errorf("dataspace: insert object type: %w", err)
	}
	snapshot.types = append(snapshot.types, entry)

	primary := &Attribute{
		ID:         newID(prefixAttribute),
		Slug:       PrimaryAttributeSlug,
		Name:       PrimaryAttributeName,
		Type:       TypeText,
		IsPrimary:  true,
		IsRequired: true,
		CreatedBy:  actor,
	}
	if err := insertAttribute(ctx, tx, entry.ID, primary, 0); err != nil {
		return nil, err
	}
	entry.Attrs = append(entry.Attrs, primary)

	for _, attrInput := range input.Attributes {
		if _, err := addAttribute(ctx, tx, snapshot, actor, entry, attrInput); err != nil {
			return nil, err
		}
	}
	return entry, nil
}

func (s *store) UpdateObjectType(ctx context.Context, actor Actor, spaceID, typeRef string, patch ObjectTypePatch) (ObjectType, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return ObjectType{}, err
	}
	defer unlock()
	var out ObjectType
	err = s.inTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		entry, typeErr := snapshot.requireType(typeRef)
		if typeErr != nil {
			return typeErr
		}
		if patch.Name != nil {
			name, nameErr := cleanName(*patch.Name, "An object type")
			if nameErr != nil {
				return nameErr
			}
			for _, other := range snapshot.types {
				if other.ID != entry.ID && sameName(other.Name, name) {
					return &ValidationError{Message: fmt.Sprintf(
						"An object type named %q already exists.", other.Name)}
				}
			}
			// The slug is deliberately left alone: a rename never changes it.
			entry.Name = name
		}
		if patch.NamePlural != nil {
			plural, pluralErr := cleanName(*patch.NamePlural, "The plural")
			if pluralErr != nil {
				return pluralErr
			}
			entry.NamePlural = plural
		}
		if patch.Icon != nil {
			icon := strings.TrimSpace(*patch.Icon)
			if icon == "" {
				icon = DefaultObjectTypeIcon
			}
			entry.Icon = icon
		}
		if patch.Description != nil {
			entry.Description = strings.TrimSpace(*patch.Description)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE object_types SET name = ?, name_key = ?, name_plural = ?, icon = ?, description = ?
			 WHERE id = ?`,
			entry.Name, nameKey(entry.Name), entry.NamePlural, entry.Icon, entry.Description, entry.ID); err != nil {
			return fmt.Errorf("dataspace: update object type: %w", err)
		}
		counts, countErr := recordCounts(ctx, tx)
		if countErr != nil {
			return countErr
		}
		out = entry.objectType(counts[entry.ID])
		return nil
	})
	if err != nil {
		return ObjectType{}, err
	}
	if _, err := s.touchSpace(ctx, space); err != nil {
		return ObjectType{}, err
	}
	return out, nil
}
