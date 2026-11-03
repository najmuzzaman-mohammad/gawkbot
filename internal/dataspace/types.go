// Package dataspace is the structured store bots build for themselves. A bot
// defines object types, their attributes and the relationships between them on
// the fly, then fills them with records; one space per use case, and those
// records are what the bot's apps read and write.
//
// The vocabulary is deliberate and matches the web UI: object type, attribute,
// relationship, record. "Entity", the /entity/ routes and the entity_* tools
// belong to the wiki fact log and mean something else.
//
// The behaviour here is not invented: web/src/api/dataspaces.mock*.ts already
// implements every rule below and its tests are the oracle this package is
// written against. Where the two could drift — coercion, cardinality, upsert
// matching, delete impact — the mock's tests say what is correct.
//
// Storage is one SQLite file per space at <runtime home>/.wuphf/data/<id>.db,
// flat so that sharing a space or making it global never moves its file.
package dataspace

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ── Access ───────────────────────────────────────────────────────

// Scope is how far a space reaches beyond the bot that created it.
type Scope string

const (
	// ScopePrivate is the owner bot and the operator, nobody else.
	ScopePrivate Scope = "private"
	// ScopeShared adds the bots named in Grants.
	ScopeShared Scope = "shared"
	// ScopeGlobal is every bot in the office, including ones added later.
	ScopeGlobal Scope = "global"
)

// Level is what a caller may do. The owner and the operator always have
// LevelWrite; LevelNone means the space reads as if it does not exist.
type Level string

const (
	LevelNone  Level = "none"
	LevelRead  Level = "read"
	LevelWrite Level = "write"
)

// Grant gives one bot a level on one space. Never the owner: the owner's
// write access is implicit, so a grant naming it is dropped.
type Grant struct {
	Bot   string `json:"bot"`
	Level Level  `json:"level"`
}

// Access is a space's sharing. Grants is non-empty only when Scope is
// ScopeShared, and is always sorted by bot slug.
type Access struct {
	Scope  Scope   `json:"scope"`
	Grants []Grant `json:"grants"`
}

// Actor is who is calling. A bot's slug, or ActorHuman for the operator, who
// always has write access to every space.
type Actor string

// ActorHuman is the operator. Records a bot did not create carry it as CreatedBy.
const ActorHuman Actor = "human"

// ── Schema ───────────────────────────────────────────────────────

// AttributeType is the closed set of value kinds an attribute may hold.
// TypeRelationship carries no value of its own: its data is the links.
type AttributeType string

const (
	TypeText         AttributeType = "text"
	TypeNumber       AttributeType = "number"
	TypeCurrency     AttributeType = "currency"
	TypeDate         AttributeType = "date"
	TypeToggle       AttributeType = "toggle"
	TypeSelect       AttributeType = "select"
	TypeStatus       AttributeType = "status"
	TypeRating       AttributeType = "rating"
	TypeURL          AttributeType = "url"
	TypeEmail        AttributeType = "email"
	TypePhone        AttributeType = "phone"
	TypeRelationship AttributeType = "relationship"
)

// Cardinality is always stated from the side that owns the attribute, so
// CardinalityManyToOne on Investor.firm reads "many investors, one firm".
// It cannot be changed after the relationship is created.
type Cardinality string

const (
	CardinalityOneToOne   Cardinality = "one_to_one"
	CardinalityManyToOne  Cardinality = "many_to_one"
	CardinalityOneToMany  Cardinality = "one_to_many"
	CardinalityManyToMany Cardinality = "many_to_many"
)

// SelectOption is one choice on a select or status attribute. The id is minted
// by the store and survives a rename, so renaming an option never rewrites the
// records pointing at it.
type SelectOption struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// RelationshipRef is the other half of a relationship attribute.
type RelationshipRef struct {
	RelationshipID string      `json:"relationship_id"`
	TargetTypeID   string      `json:"target_type_id"`
	Cardinality    Cardinality `json:"cardinality"`
	// InverseAttributeID is the mirrored attribute on the target type, empty
	// when the relationship was created without one.
	InverseAttributeID string `json:"inverse_attribute_id,omitempty"`
}

// Attribute is one field on an object type. Slug is stable for the life of the
// attribute: a rename changes Name only, so no consumer has to chase a slug.
// Type, IsUnique and IsMultivalue cannot change after creation.
type Attribute struct {
	ID           string           `json:"id"`
	Slug         string           `json:"slug"`
	Name         string           `json:"name"`
	Type         AttributeType    `json:"type"`
	Description  string           `json:"description,omitempty"`
	IsPrimary    bool             `json:"is_primary"`
	IsRequired   bool             `json:"is_required"`
	IsUnique     bool             `json:"is_unique"`
	IsMultivalue bool             `json:"is_multivalue"`
	Options      []SelectOption   `json:"options,omitempty"`
	CurrencyCode string           `json:"currency_code,omitempty"`
	Relationship *RelationshipRef `json:"relationship,omitempty"`
	CreatedBy    string           `json:"created_by"`
}

// ObjectType is one kind of thing in a space. Every type has exactly one
// primary attribute, a required text "name" the store adds on creation.
type ObjectType struct {
	ID          string      `json:"id"`
	Slug        string      `json:"slug"`
	Name        string      `json:"name"`
	NamePlural  string      `json:"name_plural"`
	Icon        string      `json:"icon,omitempty"`
	Description string      `json:"description,omitempty"`
	Attributes  []Attribute `json:"attributes"`
	RecordCount int         `json:"record_count"`
	CreatedBy   string      `json:"created_by"`
	CreatedAt   string      `json:"created_at"`
}

// Relationship is the pair itself, so a caller never has to guess which side
// owns it from the cardinality.
type Relationship struct {
	ID                 string      `json:"id"`
	SourceTypeID       string      `json:"source_type_id"`
	SourceAttributeID  string      `json:"source_attribute_id"`
	TargetTypeID       string      `json:"target_type_id"`
	InverseAttributeID string      `json:"inverse_attribute_id,omitempty"`
	Cardinality        Cardinality `json:"cardinality"`
}

// Space is one use case's datastore.
type Space struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Owner is the bot that created the space. It keeps write access even
	// after the space goes global.
	Owner           string   `json:"owner"`
	Access          Access   `json:"access"`
	ObjectTypeCount int      `json:"object_type_count"`
	RecordCount     int      `json:"record_count"`
	AttachedAppIDs  []string `json:"attached_app_ids,omitempty"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
	// CallerLevel is what the calling actor may do here. Serialized so a bot
	// listing spaces can see read-only ones without a second call.
	CallerLevel Level `json:"caller_level"`
}

// Schema is a space and everything defined in it.
type Schema struct {
	Space         Space          `json:"space"`
	ObjectTypes   []ObjectType   `json:"object_types"`
	Relationships []Relationship `json:"relationships"`
}

// ── Records ──────────────────────────────────────────────────────

// Value is a stored attribute value. The concrete type per attribute:
// text/url/email/phone -> string; number/currency/rating -> float64; date ->
// string "YYYY-MM-DD"; toggle -> bool; select/status -> option id string, or
// []string when multivalue. Relationship attributes hold no Value.
type Value any

// RecordRef points at a record, carrying its current primary value so a
// caller can render a link without a second read.
type RecordRef struct {
	ID     string `json:"id"`
	TypeID string `json:"type_id"`
	Name   string `json:"name"`
}

// Record is one row. Values is keyed by attribute slug and omits empty
// attributes; Links is keyed by relationship attribute slug and carries every
// such slug, empty when nothing is linked.
type Record struct {
	ID        string                 `json:"id"`
	TypeID    string                 `json:"type_id"`
	Values    map[string]Value       `json:"values"`
	Links     map[string][]RecordRef `json:"links"`
	CreatedBy string                 `json:"created_by"`
	CreatedAt string                 `json:"created_at"`
	UpdatedAt string                 `json:"updated_at"`
}

// Operator is a filter comparison. Select and status compare by option NAME,
// so a caller filters with what it can see.
type Operator string

const (
	OpEquals     Operator = "equals"
	OpNotEquals  Operator = "not_equals"
	OpContains   Operator = "contains"
	OpGreater    Operator = "greater"
	OpLess       Operator = "less"
	OpIsEmpty    Operator = "is_empty"
	OpIsNotEmpty Operator = "is_not_empty"
)

// Filter is one clause. Attribute may also be a system field: "_created_at",
// "_updated_at" or "_created_by".
type Filter struct {
	Attribute string   `json:"attribute"`
	Operator  Operator `json:"operator"`
	Value     string   `json:"value,omitempty"`
}

// Sort orders a query. Relationship attributes cannot be sorted on.
type Sort struct {
	Attribute string `json:"attribute"`
	Desc      bool   `json:"desc"`
}

// Query selects records of one object type.
type Query struct {
	ObjectType string   `json:"object_type"`
	Filters    []Filter `json:"filters,omitempty"`
	Sort       *Sort    `json:"sort,omitempty"`
	// Search is a case-insensitive substring over the primary name and every
	// text-like value.
	Search string `json:"query,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	Offset int    `json:"offset,omitempty"`
}

// Page is one slice of a query. Total is the count after filtering.
type Page struct {
	Records []Record `json:"records"`
	Total   int      `json:"total"`
}

// ── Inputs ───────────────────────────────────────────────────────

// RelationshipInput declares a relationship while creating the attribute that
// owns it. Both the owning attribute and, unless InverseName is empty, the
// mirrored attribute on the target are created in one transaction.
type RelationshipInput struct {
	// Target is a type id, or the slug or name of a type created earlier in
	// the same call, so two new types can be related in one request.
	Target      string      `json:"target"`
	Cardinality Cardinality `json:"cardinality"`
	InverseName string      `json:"inverse_name,omitempty"`
}

// AttributeInput defines one attribute. Options are names; the store mints
// their ids and colors.
type AttributeInput struct {
	Name         string             `json:"name"`
	Type         AttributeType      `json:"type"`
	Slug         string             `json:"slug,omitempty"`
	Description  string             `json:"description,omitempty"`
	IsRequired   bool               `json:"is_required,omitempty"`
	IsUnique     bool               `json:"is_unique,omitempty"`
	IsMultivalue bool               `json:"is_multivalue,omitempty"`
	Options      []string           `json:"options,omitempty"`
	CurrencyCode string             `json:"currency_code,omitempty"`
	Relationship *RelationshipInput `json:"relationship,omitempty"`
}

// ObjectTypeInput defines one object type plus the attributes to create with
// it. The primary "name" attribute is added by the store and must not appear
// in Attributes.
type ObjectTypeInput struct {
	Name        string           `json:"name"`
	NamePlural  string           `json:"name_plural,omitempty"`
	Icon        string           `json:"icon,omitempty"`
	Description string           `json:"description,omitempty"`
	Attributes  []AttributeInput `json:"attributes,omitempty"`
}

// AttributePatch is the mutable part of an attribute. Everything else is
// fixed at creation.
type AttributePatch struct {
	Name         *string  `json:"name,omitempty"`
	Description  *string  `json:"description,omitempty"`
	IsRequired   *bool    `json:"is_required,omitempty"`
	AddOptions   []string `json:"add_options,omitempty"`
	RenameOption *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"rename_option,omitempty"`
}

// SpacePatch is the mutable part of a space.
type SpacePatch struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	Access      *Access `json:"access,omitempty"`
}

// ObjectTypePatch is the mutable part of an object type. Slug never changes.
type ObjectTypePatch struct {
	Name        *string `json:"name,omitempty"`
	NamePlural  *string `json:"name_plural,omitempty"`
	Icon        *string `json:"icon,omitempty"`
	Description *string `json:"description,omitempty"`
}

// RecordInput is one record to write. Values is keyed by attribute slug or
// name; a nil value clears the attribute. Relationship slugs are rejected:
// links are made with Link.
type RecordInput struct {
	Values map[string]any `json:"values"`
}

// LinkInput joins two records through one relationship attribute.
type LinkInput struct {
	Record    string `json:"record"`
	Attribute string `json:"attribute"`
	Target    string `json:"target"`
	// Replace swaps a conflicting to-one link instead of failing.
	Replace bool `json:"replace,omitempty"`
}

// ── Batch envelope ───────────────────────────────────────────────

// EntryStatus is how one item in a batch fared.
type EntryStatus string

const (
	StatusOK EntryStatus = "ok"
	// StatusNoop is an idempotent repeat: already linked, already not linked,
	// an option that already exists.
	StatusNoop   EntryStatus = "noop"
	StatusFailed EntryStatus = "failed"
)

// Entry is one item's outcome, in request order.
type Entry struct {
	Index      int         `json:"index"`
	Identifier string      `json:"identifier,omitempty"`
	Status     EntryStatus `json:"status"`
	Error      string      `json:"error,omitempty"`
	// Attribute names the offending attribute on a validation failure, so a
	// caller can put the message next to the right field.
	Attribute string `json:"attribute,omitempty"`
	ID        string `json:"id,omitempty"`
}

// Result is the uniform envelope every batch write returns. One bad item never
// fails the others.
type Result struct {
	Succeeded int     `json:"succeeded"`
	Failed    int     `json:"failed"`
	Summary   string  `json:"summary"`
	Entries   []Entry `json:"entries"`
}

// ── Deletes ──────────────────────────────────────────────────────

// DeleteKind is what a delete targets.
type DeleteKind string

const (
	DeleteSpace      DeleteKind = "space"
	DeleteObjectType DeleteKind = "object_type"
	DeleteAttribute  DeleteKind = "attribute"
	DeleteRecords    DeleteKind = "records"
	// DeleteRecordsOfType empties one object type without removing it.
	DeleteRecordsOfType DeleteKind = "records_of_type"
)

// Impact is what a delete would remove.
type Impact struct {
	ObjectTypes int `json:"object_types"`
	Attributes  int `json:"attributes"`
	Records     int `json:"records"`
	Links       int `json:"links"`
}

// Preview is the first half of a delete: what would go, and a token bound to
// this exact id set. Nothing is removed until the token is presented.
type Preview struct {
	Token     string     `json:"token"`
	Kind      DeleteKind `json:"kind"`
	Impact    Impact     `json:"impact"`
	ExpiresAt string     `json:"expires_at"`
}

// ── Errors ───────────────────────────────────────────────────────

// ErrNotFound is returned for a missing space, type, attribute or record, and
// for anything the caller has no access to: a space a bot cannot see must be
// indistinguishable from one that does not exist.
var ErrNotFound = errors.New("not found")

// ErrForbidden is returned when the caller can read but not write.
var ErrForbidden = errors.New("read-only access")

// ValidationError carries a message the caller can act on without a second
// request: an invalid option lists the valid ones, a unique clash names the
// record it collided with.
type ValidationError struct {
	Message string
	// Attribute is the offending attribute's slug, empty when the problem is
	// not attribute-scoped.
	Attribute string
}

func (e *ValidationError) Error() string { return e.Message }

// Invalid builds a ValidationError for an attribute.
func Invalid(attribute, format string, args ...any) *ValidationError {
	return &ValidationError{Message: fmt.Sprintf(format, args...), Attribute: attribute}
}

// ForbiddenError names the owner so the caller knows who to ask.
type ForbiddenError struct {
	SpaceID string
	Owner   string
	// Message replaces the default read-only wording for a refusal that write
	// access would not have lifted, such as deleting a whole data space. Empty
	// for the ordinary read-only case.
	Message string
}

func (e *ForbiddenError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("read-only access to this data space; @%s owns it and can grant write access", e.Owner)
}

func (e *ForbiddenError) Unwrap() error { return ErrForbidden }

// ── Store ────────────────────────────────────────────────────────

// Store is every operation on data spaces. Each call takes the calling Actor
// and enforces access itself: no method trusts its caller to have checked.
//
// Reads a caller may not perform return ErrNotFound rather than a permission
// error, so a private space cannot be probed for existence.
type Store interface {
	// ListSpaces returns the spaces this actor can see, each with CallerLevel.
	ListSpaces(ctx context.Context, actor Actor) ([]Space, error)
	CreateSpace(ctx context.Context, actor Actor, name, description string, access Access) (Space, error)
	// UpdateSpace changes name, description or sharing. Only the owner and the
	// operator may change Access.
	UpdateSpace(ctx context.Context, actor Actor, spaceID string, patch SpacePatch) (Space, error)
	GetSchema(ctx context.Context, actor Actor, spaceID string) (Schema, error)

	// CreateObjectTypes creates types and their attributes, resolving a
	// relationship Target against types created earlier in the same call.
	CreateObjectTypes(ctx context.Context, actor Actor, spaceID string, inputs []ObjectTypeInput) (Result, error)
	UpdateObjectType(ctx context.Context, actor Actor, spaceID, typeRef string, patch ObjectTypePatch) (ObjectType, error)
	AddAttributes(ctx context.Context, actor Actor, spaceID, typeRef string, inputs []AttributeInput) (Result, error)
	UpdateAttribute(ctx context.Context, actor Actor, spaceID, typeRef, attrRef string, patch AttributePatch) (Attribute, error)

	QueryRecords(ctx context.Context, actor Actor, spaceID string, query Query) (Page, error)
	GetRecord(ctx context.Context, actor Actor, spaceID, recordID string) (Record, error)
	CreateRecords(ctx context.Context, actor Actor, spaceID, typeRef string, inputs []RecordInput) (Result, error)
	// UpsertRecords matches on matchAttribute, which must be unique. A match
	// updates, a miss creates; a nil value is skipped rather than clearing.
	UpsertRecords(ctx context.Context, actor Actor, spaceID, typeRef, matchAttribute string, inputs []RecordInput) (Result, error)
	UpdateRecord(ctx context.Context, actor Actor, spaceID, recordID string, values map[string]any) (Record, error)

	Link(ctx context.Context, actor Actor, spaceID string, inputs []LinkInput) (Result, error)
	Unlink(ctx context.Context, actor Actor, spaceID string, inputs []LinkInput) (Result, error)

	PreviewDelete(ctx context.Context, actor Actor, spaceID string, kind DeleteKind, ids []string) (Preview, error)
	// ExecuteDelete re-plans against current state, so a token whose id set has
	// changed since the preview fails rather than removing the wrong thing.
	ExecuteDelete(ctx context.Context, actor Actor, spaceID, token string) (Impact, error)

	// AttachApp records that an app reads and writes this space.
	AttachApp(ctx context.Context, actor Actor, spaceID, appID string) (Space, error)
	DetachApp(ctx context.Context, actor Actor, spaceID, appID string) (Space, error)

	Close() error
}

// NormalizeAccess applies the sharing rules the web client also applies in
// dataspacesAccess.ts: an owner grant is dropped, a bot named twice keeps the
// last level, grants are sorted by slug and kept only for ScopeShared, and a
// shared access left with no grants becomes private.
func NormalizeAccess(owner string, access Access) (Access, error) {
	switch access.Scope {
	case ScopePrivate, ScopeGlobal:
		return Access{Scope: access.Scope, Grants: nil}, nil
	case ScopeShared:
	default:
		return Access{}, &ValidationError{Message: fmt.Sprintf(
			"%q is not a sharing scope. Valid scopes: private, shared, global.", access.Scope)}
	}
	byBot := map[string]Level{}
	order := []string{}
	for _, grant := range access.Grants {
		slug := strings.ToLower(strings.TrimSpace(grant.Bot))
		if !IsBotSlug(slug) {
			return Access{}, &ValidationError{Message: fmt.Sprintf(
				"%q is not a valid bot slug.", grant.Bot)}
		}
		if grant.Level != LevelRead && grant.Level != LevelWrite {
			return Access{}, &ValidationError{Message: fmt.Sprintf(
				"%q is not an access level for @%s. Valid levels: read, write.", grant.Level, slug)}
		}
		if slug == strings.ToLower(strings.TrimSpace(owner)) {
			continue
		}
		if _, seen := byBot[slug]; !seen {
			order = append(order, slug)
		}
		byBot[slug] = grant.Level
	}
	if len(byBot) == 0 {
		return Access{Scope: ScopePrivate, Grants: nil}, nil
	}
	sortStrings(order)
	grants := make([]Grant, 0, len(order))
	for _, slug := range order {
		grants = append(grants, Grant{Bot: slug, Level: byBot[slug]})
	}
	return Access{Scope: ScopeShared, Grants: grants}, nil
}

// LevelFor is what an actor may do on a space. The operator and the owner
// always write; a global space is writable by every bot.
func LevelFor(space Space, actor Actor) Level {
	slug := strings.ToLower(strings.TrimSpace(string(actor)))
	if slug == "" {
		return LevelNone
	}
	if Actor(slug) == ActorHuman {
		return LevelWrite
	}
	if slug == strings.ToLower(strings.TrimSpace(space.Owner)) {
		return LevelWrite
	}
	switch space.Access.Scope {
	case ScopeGlobal:
		return LevelWrite
	case ScopeShared:
		for _, grant := range space.Access.Grants {
			if grant.Bot == slug {
				return grant.Level
			}
		}
	}
	return LevelNone
}

// IsBotSlug reports whether s is a usable bot slug: lowercase alphanumerics
// and dashes, starting with an alphanumeric.
func IsBotSlug(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i > 0:
		default:
			return false
		}
	}
	return true
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
