package dataspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
)

// loadSpaceRow reads one space from the index. A missing row is ErrNotFound,
// which is also what a caller with no access gets, so the two are
// indistinguishable from outside.
func (s *store) loadSpaceRow(ctx context.Context, spaceID string) (Space, error) {
	row := s.index.QueryRowContext(ctx,
		`SELECT id, owner, name, description, access_json, attached_apps,
		        created_at, updated_at, object_type_count, record_count
		 FROM spaces WHERE id = ?`, spaceID)
	return scanSpace(row)
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSpace(row rowScanner) (Space, error) {
	var (
		space      Space
		accessJSON string
		appsJSON   string
	)
	err := row.Scan(&space.ID, &space.Owner, &space.Name, &space.Description,
		&accessJSON, &appsJSON, &space.CreatedAt, &space.UpdatedAt,
		&space.ObjectTypeCount, &space.RecordCount)
	if errors.Is(err, sql.ErrNoRows) {
		return Space{}, ErrNotFound
	}
	if err != nil {
		return Space{}, fmt.Errorf("dataspace: read space: %w", err)
	}
	if err := json.Unmarshal([]byte(accessJSON), &space.Access); err != nil {
		return Space{}, fmt.Errorf("dataspace: decode access for %s: %w", space.ID, err)
	}
	if strings.TrimSpace(appsJSON) != "" {
		if err := json.Unmarshal([]byte(appsJSON), &space.AttachedAppIDs); err != nil {
			return Space{}, fmt.Errorf("dataspace: decode attached apps for %s: %w", space.ID, err)
		}
	}
	return space, nil
}

// authorize resolves a space and the caller's level on it. A caller with no
// access gets ErrNotFound whether it was reading or writing; a caller that can
// read but not write gets a ForbiddenError naming the owner.
func (s *store) authorize(ctx context.Context, actor Actor, spaceID string, write bool) (Space, Level, error) {
	space, err := s.loadSpaceRow(ctx, spaceID)
	if err != nil {
		return Space{}, LevelNone, err
	}
	level := LevelFor(space, actor)
	if level == LevelNone {
		return Space{}, LevelNone, ErrNotFound
	}
	if write && level != LevelWrite {
		return Space{}, level, &ForbiddenError{SpaceID: space.ID, Owner: space.Owner}
	}
	space.CallerLevel = level
	return space, level, nil
}

// ownerOnly gates the few changes that write access does not imply. A write
// grant says "put data in my space"; it does not say "delete it" or "rename
// it", and neither is something the owner would see coming. Only the space's
// owner and the operator may do those.
func ownerOnly(actor Actor, space Space, action string) error {
	slug := normalizeActor(actor)
	if slug == string(ActorHuman) || slug == normalizeActor(Actor(space.Owner)) {
		return nil
	}
	return &ForbiddenError{
		SpaceID: space.ID,
		Owner:   space.Owner,
		Message: fmt.Sprintf("%s a data space is the owner's call; @%s owns this one",
			action, space.Owner),
	}
}

// saveSpaceRow writes a space row back and stamps updatedAt.
func (s *store) saveSpaceRow(ctx context.Context, space Space) (Space, error) {
	accessJSON, err := json.Marshal(space.Access)
	if err != nil {
		return Space{}, fmt.Errorf("dataspace: encode access: %w", err)
	}
	apps := space.AttachedAppIDs
	if apps == nil {
		apps = []string{}
	}
	appsJSON, err := json.Marshal(apps)
	if err != nil {
		return Space{}, fmt.Errorf("dataspace: encode attached apps: %w", err)
	}
	space.UpdatedAt = s.stamp()
	_, err = s.index.ExecContext(ctx,
		`UPDATE spaces SET owner = ?, name = ?, description = ?, access_json = ?,
		        attached_apps = ?, updated_at = ?, object_type_count = ?, record_count = ?
		 WHERE id = ?`,
		space.Owner, space.Name, space.Description, string(accessJSON), string(appsJSON),
		space.UpdatedAt, space.ObjectTypeCount, space.RecordCount, space.ID)
	if err != nil {
		return Space{}, fmt.Errorf("dataspace: save space: %w", err)
	}
	return space, nil
}

// touchSpace refreshes the cached counts and updatedAt after a write. It is
// the only writer of the two denormalized columns, so they cannot drift for
// longer than one failed process.
func (s *store) touchSpace(ctx context.Context, space Space) (Space, error) {
	counts, err := s.spaceCounts(ctx, space.ID)
	if err != nil {
		return Space{}, err
	}
	space.ObjectTypeCount = counts.types
	space.RecordCount = counts.records
	return s.saveSpaceRow(ctx, space)
}

type spaceCounts struct {
	types   int
	records int
}

func (s *store) spaceCounts(ctx context.Context, spaceID string) (spaceCounts, error) {
	db, err := s.spaceDB(ctx, spaceID)
	if err != nil {
		return spaceCounts{}, err
	}
	var counts spaceCounts
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM object_types`).Scan(&counts.types); err != nil {
		return spaceCounts{}, fmt.Errorf("dataspace: count object types: %w", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM records`).Scan(&counts.records); err != nil {
		return spaceCounts{}, fmt.Errorf("dataspace: count records: %w", err)
	}
	return counts, nil
}

// ── Store: spaces ────────────────────────────────────────────────

func (s *store) ListSpaces(ctx context.Context, actor Actor) ([]Space, error) {
	rows, err := s.index.QueryContext(ctx,
		`SELECT id, owner, name, description, access_json, attached_apps,
		        created_at, updated_at, object_type_count, record_count
		 FROM spaces ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("dataspace: list spaces: %w", err)
	}
	defer closeRows(rows)
	out := []Space{}
	for rows.Next() {
		space, err := scanSpace(rows)
		if err != nil {
			return nil, err
		}
		level := LevelFor(space, actor)
		if level == LevelNone {
			continue
		}
		space.CallerLevel = level
		out = append(out, space)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dataspace: list spaces: %w", err)
	}
	return out, nil
}

func (s *store) CreateSpace(ctx context.Context, actor Actor, name, description string, access Access) (Space, error) {
	slug := normalizeActor(actor)
	if slug == "" {
		return Space{}, &ValidationError{Message: "A data space needs a calling bot."}
	}
	if slug != string(ActorHuman) && !IsBotSlug(slug) {
		return Space{}, &ValidationError{Message: fmt.Sprintf("%q is not a valid bot slug.", string(actor))}
	}
	clean, err := cleanName(name, "A data space")
	if err != nil {
		return Space{}, err
	}
	if access.Scope == "" {
		access = Access{Scope: ScopePrivate}
	}
	normalized, err := NormalizeAccess(slug, access)
	if err != nil {
		return Space{}, err
	}
	stamp := s.stamp()
	space := Space{
		Name:           clean,
		Description:    strings.TrimSpace(description),
		Owner:          slug,
		Access:         normalized,
		AttachedAppIDs: []string{},
		CreatedAt:      stamp,
		UpdatedAt:      stamp,
		CallerLevel:    LevelWrite,
	}
	accessJSON, err := json.Marshal(normalized)
	if err != nil {
		return Space{}, fmt.Errorf("dataspace: encode access: %w", err)
	}
	// A random id collides only in theory; retrying on the primary key keeps
	// it out of practice too.
	for attempt := 0; attempt < 5; attempt++ {
		space.ID = newID(prefixSpace)
		_, err = s.index.ExecContext(ctx,
			`INSERT INTO spaces(id, owner, name, description, access_json, attached_apps,
			                    created_at, updated_at, object_type_count, record_count)
			 VALUES(?, ?, ?, ?, ?, '[]', ?, ?, 0, 0)`,
			space.ID, space.Owner, space.Name, space.Description, string(accessJSON),
			space.CreatedAt, space.UpdatedAt)
		if err == nil {
			break
		}
		if !isUniqueViolation(err) {
			return Space{}, fmt.Errorf("dataspace: create space: %w", err)
		}
	}
	if err != nil {
		return Space{}, fmt.Errorf("dataspace: create space: %w", err)
	}
	// Create the database eagerly so a failure surfaces here rather than on
	// the first write.
	if _, err := s.spaceDB(ctx, space.ID); err != nil {
		_, _ = s.index.ExecContext(ctx, `DELETE FROM spaces WHERE id = ?`, space.ID)
		return Space{}, err
	}
	return space, nil
}

func (s *store) UpdateSpace(ctx context.Context, actor Actor, spaceID string, patch SpacePatch) (Space, error) {
	space, _, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Space{}, err
	}
	defer unlock()
	if patch.Name != nil {
		// Renaming is the owner's call. A write grant says "put data in my
		// space", not "relabel it": every other bot sees the new name, and the
		// owner has no way to notice it changed. Description and app attach
		// stay at write — a description is scoped to the change it describes,
		// and attaching an app is how a collaborator's app uses shared data.
		if err := ownerOnly(actor, space, "renaming"); err != nil {
			return Space{}, err
		}
		name, nameErr := cleanName(*patch.Name, "A data space")
		if nameErr != nil {
			return Space{}, nameErr
		}
		space.Name = name
	}
	if patch.Description != nil {
		space.Description = strings.TrimSpace(*patch.Description)
	}
	if patch.Access != nil {
		slug := normalizeActor(actor)
		if slug != string(ActorHuman) && slug != strings.ToLower(strings.TrimSpace(space.Owner)) {
			return Space{}, &ForbiddenError{SpaceID: space.ID, Owner: space.Owner}
		}
		// Normalized before anything is written, so a bad grant changes nothing.
		normalized, accessErr := NormalizeAccess(space.Owner, *patch.Access)
		if accessErr != nil {
			return Space{}, accessErr
		}
		space.Access = normalized
	}
	saved, err := s.saveSpaceRow(ctx, space)
	if err != nil {
		return Space{}, err
	}
	saved.CallerLevel = LevelFor(saved, actor)
	return saved, nil
}

func (s *store) GetSchema(ctx context.Context, actor Actor, spaceID string) (Schema, error) {
	space, level, unlock, err := s.lockSpace(ctx, actor, spaceID, false)
	if err != nil {
		return Schema{}, err
	}
	defer unlock()
	var schema Schema
	err = s.inReadTx(ctx, spaceID, func(tx *sql.Tx) error {
		snapshot, loadErr := loadSchema(ctx, tx)
		if loadErr != nil {
			return loadErr
		}
		counts, countErr := recordCounts(ctx, tx)
		if countErr != nil {
			return countErr
		}
		total, totalErr := totalRecords(ctx, tx)
		if totalErr != nil {
			return totalErr
		}
		space.ObjectTypeCount = len(snapshot.types)
		space.RecordCount = total
		space.CallerLevel = level
		schema.Space = space
		schema.ObjectTypes = make([]ObjectType, 0, len(snapshot.types))
		for _, entry := range snapshot.types {
			schema.ObjectTypes = append(schema.ObjectTypes, entry.objectType(counts[entry.ID]))
		}
		schema.Relationships = make([]Relationship, 0, len(snapshot.rels))
		for _, rel := range snapshot.rels {
			schema.Relationships = append(schema.Relationships, *rel)
		}
		sort.Slice(schema.Relationships, func(i, j int) bool {
			return schema.Relationships[i].ID < schema.Relationships[j].ID
		})
		return nil
	})
	if err != nil {
		return Schema{}, err
	}
	return schema, nil
}

func (s *store) AttachApp(ctx context.Context, actor Actor, spaceID, appID string) (Space, error) {
	return s.changeApps(ctx, actor, spaceID, appID, true)
}

func (s *store) DetachApp(ctx context.Context, actor Actor, spaceID, appID string) (Space, error) {
	return s.changeApps(ctx, actor, spaceID, appID, false)
}

func (s *store) changeApps(ctx context.Context, actor Actor, spaceID, appID string, attach bool) (Space, error) {
	space, level, unlock, err := s.lockSpace(ctx, actor, spaceID, true)
	if err != nil {
		return Space{}, err
	}
	defer unlock()
	appID = strings.TrimSpace(appID)
	if !isAppID(appID) {
		return Space{}, &ValidationError{Message: fmt.Sprintf(
			"%q is not an app id. App ids look like app_ followed by 16 hex characters.", appID)}
	}
	kept := make([]string, 0, len(space.AttachedAppIDs)+1)
	present := false
	for _, existing := range space.AttachedAppIDs {
		if existing == appID {
			present = true
			if !attach {
				continue
			}
		}
		kept = append(kept, existing)
	}
	if attach && !present {
		kept = append(kept, appID)
	}
	sort.Strings(kept)
	space.AttachedAppIDs = kept
	saved, err := s.saveSpaceRow(ctx, space)
	if err != nil {
		return Space{}, err
	}
	saved.CallerLevel = level
	return saved, nil
}

// removeSpace drops a space's row and its database file, in the order that
// leaves nothing stranded.
//
// The file is retired to a tombstone FIRST. Dropping the row first meant a
// crash, or a directory that had gone read-only, left a full space database
// with no row pointing at it: unreachable, never enumerated, and indefinitely
// on disk. Retiring first makes the failure recoverable in both directions —
// if the row cannot be dropped the file is moved back and the space is intact,
// and if the unlink fails the leftover tombstone is swept at the next Open.
func (s *store) removeSpace(ctx context.Context, spaceID string) error {
	s.forgetSpaceDB(spaceID)
	path := s.spacePath(spaceID)
	tomb := fmt.Sprintf("%s.deleted-%s", path, s.now().UTC().Format("20060102T150405.000"))
	retired := false
	if err := os.Rename(path, tomb); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("dataspace: retire %s: %w", path, err)
		}
	} else {
		retired = true
	}
	if _, err := s.index.ExecContext(ctx, `DELETE FROM spaces WHERE id = ?`, spaceID); err != nil {
		if retired {
			if back := os.Rename(tomb, path); back != nil {
				log.Printf("dataspace: %s: could not restore %s after a failed row delete: %v",
					spaceID, path, back)
			}
		}
		return fmt.Errorf("dataspace: delete space row: %w", err)
	}
	// The space is gone from the index; from here nothing can reach the bytes.
	s.locks.Delete(spaceID)
	for _, name := range []string{tomb, path + "-wal", path + "-shm"} {
		if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("dataspace: %s: leftover %s (%v); the next Open sweeps it", spaceID, name, err)
		}
	}
	return nil
}

// isUniqueViolation reports whether err is a SQLite UNIQUE constraint failure.
// The driver does not export a typed error for it, so the text is the only
// handle; both wordings modernc uses are matched.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	text := err.Error()
	return strings.Contains(text, "UNIQUE constraint failed") ||
		strings.Contains(text, "constraint failed: UNIQUE")
}
