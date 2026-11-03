package teammcp

// data_tools.go — MCP tools for data spaces: the structured store a bot builds
// for itself (object types, attributes, relationships, records).
//
// The tools mirror the broker's /data routes 1:1, so there is one tool per
// route and no tool that fans out into several writes behind the bot's back.
// Handlers live in data_tools_handlers.go.
//
// The DESCRIPTIONS are the product here. They are the only instructions a bot
// ever reads about this surface, so they are written as instructions, not as
// labels, and they encode the rules Nex learned the hard way:
//
//   - read the schema before creating, and again right after changing it;
//   - never invent an attribute slug or a select option value;
//   - never add a near-duplicate option;
//   - a relationship IS an attribute, and it creates its own mirror;
//   - upsert on a unique attribute when re-importing;
//   - ids are strings, passed back exactly as they came;
//   - preview a delete, show the operator the counts, then execute;
//   - every batch write returns entries[] in request order — read them.
//
// The input types below mirror internal/dataspace's JSON shapes rather than
// importing them, because every field here carries a jsonschema description the
// store's own structs have no business holding. data_tools_test.go asserts the
// two stay field-for-field identical, so the mirror cannot drift in silence.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ── Inputs (mirrors of internal/dataspace) ───────────────────────

// DataRelationshipInput declares a relationship while creating the attribute
// that owns it. Mirrors dataspace.RelationshipInput.
type DataRelationshipInput struct {
	Target      string `json:"target" jsonschema:"The object type on the other end: its id or slug, or the NAME of a type created earlier in this same call, so two brand-new types can be linked in one request."`
	Cardinality string `json:"cardinality" jsonschema:"one_to_one, many_to_one, one_to_many or many_to_many, always stated from the side you are defining: many_to_one on Investor.firm means many investors share one firm. Cardinality cannot be changed later, so get it right now."`
	InverseName string `json:"inverse_name,omitempty" jsonschema:"Display name for the mirrored attribute the store creates on the target type, e.g. 'Investors' on Firm when you define Investor.firm. Leave empty only if the other side should not see the link."`
}

// DataAttributeInput defines one attribute. Mirrors dataspace.AttributeInput.
type DataAttributeInput struct {
	Name         string                 `json:"name" jsonschema:"Display name, e.g. 'Check size'. The operator sees this; the slug is what your later writes use."`
	Type         string                 `json:"type" jsonschema:"One of text, number, currency, date, toggle, select, status, rating, url, email, phone, relationship. Fixed at creation — to change a type you create a new attribute."`
	Slug         string                 `json:"slug,omitempty" jsonschema:"Optional stable slug; the store derives one from the name when you leave this empty. A slug never changes, even when the attribute is renamed, so every later write can rely on it."`
	Description  string                 `json:"description,omitempty" jsonschema:"One line on what this attribute holds, for the operator and for the next bot."`
	IsRequired   bool                   `json:"is_required,omitempty" jsonschema:"Records cannot be written without a value for this attribute."`
	IsUnique     bool                   `json:"is_unique,omitempty" jsonschema:"Enforce uniqueness across the type's records. Only a unique attribute can be the matching_attribute of data_upsert_records, so mark the natural key (email on a person, domain on a company) unique NOW — this cannot be changed later."`
	IsMultivalue bool                   `json:"is_multivalue,omitempty" jsonschema:"Allow several values in one record. Select supports it; status never does. Cannot be changed later."`
	Options      []string               `json:"options,omitempty" jsonschema:"Option NAMES for a select or status attribute, e.g. Intro, Pitched, Diligence, Committed, Passed. The store mints their ids and colors. Records may only use these values afterwards, so agree the list with the operator rather than guessing."`
	CurrencyCode string                 `json:"currency_code,omitempty" jsonschema:"ISO currency code for a currency attribute, e.g. USD."`
	Relationship *DataRelationshipInput `json:"relationship,omitempty" jsonschema:"Set this together with type=relationship. It creates the link definition, this attribute, and the mirrored attribute on the target type in one transaction — there is no separate create-relationship tool."`
}

// DataObjectTypeInput defines one object type plus its attributes. Mirrors
// dataspace.ObjectTypeInput.
type DataObjectTypeInput struct {
	Name        string               `json:"name" jsonschema:"Singular display name, e.g. 'Investor'."`
	NamePlural  string               `json:"name_plural,omitempty" jsonschema:"Plural display name, e.g. 'Investors'. Derived from the name when empty."`
	Icon        string               `json:"icon,omitempty" jsonschema:"Optional emoji shown next to the type."`
	Description string               `json:"description,omitempty" jsonschema:"One line on what this type tracks."`
	Attributes  []DataAttributeInput `json:"attributes,omitempty" jsonschema:"The attributes to create with the type. Do NOT include a 'name' attribute: the store adds a required primary 'name' itself, which is why you must re-read the schema after this call."`
}

// DataAttributePatch is the mutable part of an attribute. Mirrors
// dataspace.AttributePatch.
type DataAttributePatch struct {
	Name         *string           `json:"name,omitempty" jsonschema:"New display name. The slug stays as it was, so nothing that references the attribute breaks."`
	Description  *string           `json:"description,omitempty" jsonschema:"New description."`
	IsRequired   *bool             `json:"is_required,omitempty" jsonschema:"Turn the required flag on or off."`
	AddOptions   []string          `json:"add_options,omitempty" jsonschema:"Option names to add to a select or status attribute. Never add a near-duplicate of an option that already exists: do not add '201-500' when '251-500' is there — map your value to the existing option or ask the operator."`
	RenameOption *DataRenameOption `json:"rename_option,omitempty" jsonschema:"Rename one existing option by id. The id survives the rename, so no record is rewritten."`
}

// DataRenameOption renames one select/status option in place.
type DataRenameOption struct {
	ID   string `json:"id" jsonschema:"The option id from data_get_schema, passed back exactly as it was returned."`
	Name string `json:"name" jsonschema:"The new display name for that option."`
}

// DataRecordInput is one record to write. Mirrors dataspace.RecordInput.
type DataRecordInput struct {
	Values map[string]any `json:"values" jsonschema:"Attribute slug (as data_get_schema returned it) to value. Text/url/email/phone are strings; number, currency and rating are numbers; date is YYYY-MM-DD; toggle is true or false; select and status take an option NAME or id. Relationship slugs are rejected here — make links with data_link_records once the records exist."`
}

// DataFilterInput is one filter clause. Mirrors dataspace.Filter.
type DataFilterInput struct {
	Attribute string `json:"attribute" jsonschema:"Attribute slug to filter on, or a system field: _created_at, _updated_at, _created_by."`
	Operator  string `json:"operator" jsonschema:"equals, not_equals, contains, greater, less, is_empty or is_not_empty."`
	Value     string `json:"value,omitempty" jsonschema:"The value to compare against, as text. Select and status compare by option NAME, the same text you can see."`
}

// DataSortInput orders a query. Mirrors dataspace.Sort.
type DataSortInput struct {
	Attribute string `json:"attribute" jsonschema:"Attribute slug to sort by, or _created_at / _updated_at. Relationship attributes cannot be sorted on."`
	Desc      bool   `json:"desc,omitempty" jsonschema:"Sort descending instead of ascending."`
}

// DataLinkInput joins two records through one relationship attribute. Mirrors
// dataspace.LinkInput.
type DataLinkInput struct {
	Record    string `json:"record" jsonschema:"Id of the record that owns the relationship attribute, as a string, exactly as it was returned."`
	Attribute string `json:"attribute" jsonschema:"Slug of the relationship attribute on that record's own object type, e.g. 'firm' on an Investor."`
	Target    string `json:"target" jsonschema:"Id of the record to link to, as a string, exactly as it was returned."`
	Replace   bool   `json:"replace,omitempty" jsonschema:"On a to-one attribute, move the link instead of failing when the record is already linked to something else — how you move a candidate to a different role."`
}

// DataGrantInput gives one bot one level on a shared space. Mirrors
// dataspace.Grant.
type DataGrantInput struct {
	Bot   string `json:"bot" jsonschema:"The teammate's bot slug, lowercase, e.g. 'ops'."`
	Level string `json:"level" jsonschema:"read or write."`
}

// ── Tool arguments ───────────────────────────────────────────────

// DataListSpacesArgs has no inputs: it returns the spaces this bot can see.
type DataListSpacesArgs struct{}

// DataCreateSpaceArgs creates one space.
type DataCreateSpaceArgs struct {
	Name        string           `json:"name" jsonschema:"Short name for the use case, e.g. 'Seed raise' or 'Client delivery'."`
	Description string           `json:"description,omitempty" jsonschema:"One line on what this space tracks and who it is for."`
	Access      string           `json:"access,omitempty" jsonschema:"private (default: you and the operator), shared (you plus the bots you name in grants), or global (every bot in the office, now and in future, can read AND change the data). Only widen this when the operator asked for it."`
	Grants      []DataGrantInput `json:"grants,omitempty" jsonschema:"Required with access=shared: the teammates who may use the space and at what level. Ignored for private and global."`
}

// DataGetSchemaArgs identifies the space to inspect.
type DataGetSchemaArgs struct {
	Space string `json:"space" jsonschema:"Space id from data_list_spaces, as a string, exactly as it was returned."`
}

// DataCreateObjectTypesArgs creates types (and the relationships between them).
type DataCreateObjectTypesArgs struct {
	Space string                `json:"space" jsonschema:"Space id from data_list_spaces."`
	Items []DataObjectTypeInput `json:"items" jsonschema:"The object types to create, with their attributes and the relationships between them. Several types in one call is the normal case, not the exception."`
}

// DataAddAttributesArgs adds attributes to an existing type.
type DataAddAttributesArgs struct {
	Space      string               `json:"space" jsonschema:"Space id from data_list_spaces."`
	ObjectType string               `json:"object_type" jsonschema:"Id or slug of the EXISTING object type, from data_get_schema."`
	Items      []DataAttributeInput `json:"items" jsonschema:"The attributes to add to that type."`
}

// DataUpdateAttributeArgs changes the mutable part of one attribute.
type DataUpdateAttributeArgs struct {
	Space      string             `json:"space" jsonschema:"Space id from data_list_spaces."`
	ObjectType string             `json:"object_type" jsonschema:"Id or slug of the object type the attribute belongs to."`
	Attribute  string             `json:"attribute" jsonschema:"Id or slug of the attribute to change, from data_get_schema."`
	Patch      DataAttributePatch `json:"patch" jsonschema:"Only the parts you are changing. Type, is_unique and is_multivalue are not in here because they cannot change after creation."`
}

// DataQueryRecordsArgs reads records of one object type.
type DataQueryRecordsArgs struct {
	Space      string            `json:"space" jsonschema:"Space id from data_list_spaces."`
	ObjectType string            `json:"object_type" jsonschema:"Id or slug of the object type to read."`
	Filters    []DataFilterInput `json:"filters,omitempty" jsonschema:"Filter clauses, combined with AND."`
	Sort       *DataSortInput    `json:"sort,omitempty" jsonschema:"How to order the page."`
	Query      string            `json:"query,omitempty" jsonschema:"Case-insensitive substring search over the primary name and every text-like value."`
	Limit      int               `json:"limit,omitempty" jsonschema:"How many records to return. Keep it small; page with offset."`
	Offset     int               `json:"offset,omitempty" jsonschema:"How many records to skip, for paging."`
}

// DataCreateRecordsArgs creates records.
type DataCreateRecordsArgs struct {
	Space      string            `json:"space" jsonschema:"Space id from data_list_spaces."`
	ObjectType string            `json:"object_type" jsonschema:"Id or slug of the object type to create records of."`
	Items      []DataRecordInput `json:"items" jsonschema:"The records to create, in the order you want them reported back."`
}

// DataUpsertRecordsArgs creates or updates records matched on one attribute.
type DataUpsertRecordsArgs struct {
	Space             string            `json:"space" jsonschema:"Space id from data_list_spaces."`
	ObjectType        string            `json:"object_type" jsonschema:"Id or slug of the object type to write."`
	MatchingAttribute string            `json:"matching_attribute" jsonschema:"Slug of the attribute to match on. It MUST be an attribute marked unique (email, domain, external id); the store rejects anything else."`
	Items             []DataRecordInput `json:"items" jsonschema:"The records to create or update. Every item must carry a value for matching_attribute."`
}

// DataUpdateRecordArgs patches one record.
type DataUpdateRecordArgs struct {
	Space  string         `json:"space" jsonschema:"Space id from data_list_spaces."`
	Record string         `json:"record" jsonschema:"Record id as a string, exactly as it was returned by data_query_records."`
	Values map[string]any `json:"values" jsonschema:"Attribute slug to new value. Only the attributes you pass change; pass null to clear one."`
}

// DataLinkRecordsArgs links record pairs.
type DataLinkRecordsArgs struct {
	Space string          `json:"space" jsonschema:"Space id from data_list_spaces."`
	Items []DataLinkInput `json:"items" jsonschema:"The links to make, in request order."`
}

// DataUnlinkRecordsArgs removes record links.
type DataUnlinkRecordsArgs struct {
	Space string          `json:"space" jsonschema:"Space id from data_list_spaces."`
	Items []DataLinkInput `json:"items" jsonschema:"The links to remove, in request order. replace is ignored here."`
}

// DataShareSpaceArgs changes a space's sharing.
type DataShareSpaceArgs struct {
	Space  string           `json:"space" jsonschema:"Space id from data_list_spaces. You must own the space."`
	Access string           `json:"access" jsonschema:"private, shared or global."`
	Grants []DataGrantInput `json:"grants,omitempty" jsonschema:"Required with access=shared: the teammates who may use the space and at what level."`
}

// DataDeletePreviewArgs asks what a delete would remove.
type DataDeletePreviewArgs struct {
	Space string   `json:"space" jsonschema:"Space id from data_list_spaces."`
	Kind  string   `json:"kind" jsonschema:"What to remove: object_type, attribute, records, records_of_type (empty a type without removing it) or space."`
	IDs   []string `json:"ids,omitempty" jsonschema:"Ids of the things to remove, as strings, exactly as they were returned. Leave empty only for kind=space."`
}

// DataDeleteArgs executes a previewed delete.
type DataDeleteArgs struct {
	Space string `json:"space" jsonschema:"Space id from data_list_spaces."`
	Token string `json:"token" jsonschema:"The token from the data_delete_preview whose counts the operator has already seen."`
}

// ── Registration ─────────────────────────────────────────────────

// registerDataTools wires the data-space tools. Every bot gets them; the
// data-modeling system skill can switch them off per bot, and the broker
// enforces per-space access on top of that.
func registerDataTools(server *mcp.Server) {
	mcp.AddTool(server, readOnlyTool(
		"data_list_spaces",
		"List the data spaces you can use. A data space is one use case's own structured store — its object types, attributes, relationships and records — and it is what the operator browses under Data. Each entry carries the bot that owns it and your access level (write or read), so check the level before planning a write. ALWAYS call this first: if a space for this use case already exists, work in it instead of creating a second one.",
	), handleDataListSpaces)

	mcp.AddTool(server, officeWriteTool(
		"data_create_space",
		"Create a data space for a use case that does not have one yet. One space per use case ('Seed raise', 'Client delivery', 'Hiring'), not one per request — call data_list_spaces first and reuse a space that already fits. A new space is private to you and the operator by default. Share it only when the operator asks: access=shared names specific teammates, and access=global means EVERY bot in the office, now and in future, can read and change the data.",
	), handleDataCreateSpace)

	mcp.AddTool(server, readOnlyTool(
		"data_get_schema",
		"Read a space's full schema: every object type, every attribute (slug, type, required, unique, multivalue, select options) and every relationship. Call this BEFORE you create anything — if a type already exists, add attributes to it with data_add_attributes instead of creating a second one. Call it AGAIN right after creating or changing a type: the store adds a required primary `name` attribute your call did not define and mints the ids of your select options, so your creation call is NOT the full effective schema. Every later write must use the slugs and option values this returns. Never invent an attribute slug or an option value.",
	), handleDataGetSchema)

	mcp.AddTool(server, officeWriteTool(
		"data_create_object_types",
		"Create one or more object types in a space — with their attributes AND the relationships between them — in a single call. Call data_get_schema first: if the type already exists, use data_add_attributes instead, because a second near-duplicate type is the most expensive mistake on this surface. A relationship IS an attribute: give an attribute type=relationship plus `relationship`, and the store also creates the mirrored attribute on the other type. There is no separate create-relationship tool. State cardinality from the side you are defining — many_to_one on Investor.firm means many investors share one firm — and note that cardinality cannot be changed later. `relationship.target` may name a type created earlier in this same call, so Investor, Firm and Meeting plus the links between them are ONE call. Do not define a `name` attribute; the store adds the required primary one. Returns the batch envelope {succeeded, failed, summary, entries[]} in request order: read `entries` rather than assuming the whole call worked, then re-read the schema.",
	), handleDataCreateObjectTypes)

	mcp.AddTool(server, officeWriteTool(
		"data_add_attributes",
		"Add attributes to an object type that already exists. This is the tool for 'add a priority field to deliverables' — never create a second object type for one more field. type=relationship plus `relationship` works here too and creates the mirrored attribute on the target type. Type, is_unique and is_multivalue are fixed at creation, so decide uniqueness before you write records: only a unique attribute can be the matching_attribute of data_upsert_records. Returns the batch envelope {succeeded, failed, summary, entries[]} in request order — read `entries`, then re-read the schema with data_get_schema to pick up the slugs and option ids the store minted.",
	), handleDataAddAttributes)

	mcp.AddTool(server, officeWriteTool(
		"data_update_attribute",
		"Change the mutable part of an existing attribute: display name, description, whether it is required, and the options on a select or status attribute. The slug never changes, so a rename breaks nothing that points at it, and renaming an option keeps its id, so no record is rewritten. When adding an option, never add a near-duplicate of one that already exists — do not add '201-500' when '251-500' is there; map your value onto the existing option or ask the operator. Type, is_unique and is_multivalue cannot be changed; create a new attribute instead.",
	), handleDataUpdateAttribute)

	mcp.AddTool(server, readOnlyTool(
		"data_query_records",
		"Read records of one object type: filters and query narrow the result, sort orders it, limit and offset page it. Filter and sort by attribute SLUG exactly as data_get_schema returned it, or by the system fields _created_at, _updated_at and _created_by; select and status filter by option NAME, the text you can see. Relationship attributes cannot be sorted on — each record comes back with its links per relationship attribute instead. Read before you write, so you update the record that already exists instead of adding a duplicate. Record ids come back as strings; pass them onward exactly as they were returned.",
	), handleDataQueryRecords)

	mcp.AddTool(server, officeWriteTool(
		"data_create_records",
		"Create records of one object type. `values` is keyed by attribute slug; relationship slugs are rejected here — make links with data_link_records once both records exist. Prefer data_upsert_records whenever the source could be read again (a wiki page, an export, a thread), because a second run of THIS tool creates a second set of records. Values are validated per attribute type: an invalid select or status value comes back naming the valid options — use one of those or ask the operator, and never invent an option value. Returns the batch envelope {succeeded, failed, summary, entries[]} in request order; read `entries` before you report success, because one rejected record does not fail the rest.",
	), handleDataCreateRecords)

	mcp.AddTool(server, officeWriteTool(
		"data_upsert_records",
		"Create or update records matched on one attribute. Use this whenever you import or re-import from a source, so a second run updates the same records instead of duplicating them. matching_attribute MUST be an attribute marked unique (email on an investor, domain on a firm); the store rejects anything else. A match updates the record, a miss creates it, and a null value is skipped rather than clearing the attribute — use data_update_record when you actually want to clear something. Returns the batch envelope {succeeded, failed, summary, entries[]} in request order; read `entries` to see which items matched and which were created.",
	), handleDataUpsertRecords)

	mcp.AddTool(server, officeWriteTool(
		"data_update_record",
		"Change values on one existing record, addressed by its id exactly as it was returned — pass ids as strings, never renumbered or reformatted. `values` is keyed by attribute slug and patches only the attributes you pass; pass null to clear one. An invalid select or status value is refused with the valid options listed; use one of those or ask the operator. Relationship attributes are changed with data_link_records and data_unlink_records, not here.",
	), handleDataUpdateRecord)

	mcp.AddTool(server, officeWriteTool(
		"data_link_records",
		"Link records through a relationship attribute: each item is {record, attribute, target}. `record` and `target` are record ids as strings, exactly as they were returned; `attribute` is the relationship attribute's slug on the record's own object type. Linking a pair that is already linked is a no-op, not an error. On a to-one attribute, a second, different link fails unless you pass replace=true, which MOVES the link — that is how you move a candidate to another role. Returns the batch envelope {succeeded, failed, summary, entries[]} in request order; read `entries`.",
	), handleDataLinkRecords)

	mcp.AddTool(server, officeWriteTool(
		"data_unlink_records",
		"Remove links between records through a relationship attribute. Same item shape as data_link_records, and unlinking a pair that is not linked is a no-op, not an error. This removes the LINK only: neither record is deleted, and no attribute is removed. Returns the batch envelope {succeeded, failed, summary, entries[]} in request order; read `entries`.",
	), handleDataUnlinkRecords)

	mcp.AddTool(server, officeWriteTool(
		"data_share_space",
		"Change who can use a data space. A space is private to you and the operator by default, and you share it only when the operator asks. access=shared names specific teammates, each with read or write. access=global means EVERY bot in the office, present and future, can read AND change the data — it is the widest setting, so confirm it with the operator before you use it. Only the space's owner (and the operator) can change this.",
	), handleDataShareSpace)

	// The delete pair is marked destructive on BOTH halves. The preview removes
	// nothing, but it is the front door to an irreversible removal and a bot
	// should treat the two calls as one destructive act.
	mcp.AddTool(server, officeDestructiveTool(
		"data_delete_preview",
		"Step one of every delete: find out what would be removed. `kind` is object_type, attribute, records, records_of_type (empty a type without removing it) or space, and `ids` names what to remove. Returns the impact — how many object types, attributes, records and links would go — plus a token bound to that exact id set. NOTHING is deleted yet. Show the operator those counts and get their answer before you call data_delete. The token expires after a short window; if it does, preview again.",
	), handleDataDeletePreview)

	mcp.AddTool(server, officeDestructiveTool(
		"data_delete",
		"Step two of a delete: execute the preview the operator has already seen, by its token. This permanently removes the object types, attributes, records and links that data_delete_preview counted, and it cannot be undone. Never call it with a token whose counts you did not show the operator. The delete is re-planned against current state, so a token whose id set has changed since the preview fails rather than removing the wrong thing.",
	), handleDataDelete)
}

// ── Shared helpers ───────────────────────────────────────────────

// dataSpaceRefs are the valid delete kinds, mirroring dataspace.DeleteKind.
var dataDeleteKinds = map[string]bool{
	"space":           true,
	"object_type":     true,
	"attribute":       true,
	"records":         true,
	"records_of_type": true,
}

// dataAccessScopes mirrors dataspace.Scope.
var dataAccessScopes = map[string]bool{"private": true, "shared": true, "global": true}

// dataRef trims, validates and path-escapes one required path segment. The
// message names the tool that hands out the value, so a bot that guessed an id
// is told where to get a real one.
func dataRef(value, field, where string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("%s is required: %s", field, where)
	}
	return url.PathEscape(trimmed), nil
}

// dataSpacePath builds /data/spaces/{space}{suffix} with the space escaped.
func dataSpacePath(space, suffix string) (string, error) {
	ref, err := dataRef(space, "space", "call data_list_spaces and pass the id of the space to work in")
	if err != nil {
		return "", err
	}
	return "/data/spaces/" + ref + suffix, nil
}

// dataAccessBody builds the Access object the store expects, validating the
// scope here so a typo costs no round trip.
func dataAccessBody(access string, grants []DataGrantInput) (map[string]any, error) {
	scope := strings.ToLower(strings.TrimSpace(access))
	if scope == "" {
		scope = "private"
	}
	if !dataAccessScopes[scope] {
		return nil, fmt.Errorf("access %q is not a sharing scope; use private, shared or global", access)
	}
	body := map[string]any{"scope": scope}
	if scope != "shared" {
		if len(grants) > 0 {
			return nil, fmt.Errorf("grants only apply to access=shared; %s needs none", scope)
		}
		return body, nil
	}
	if len(grants) == 0 {
		return nil, fmt.Errorf("access=shared needs grants: name the teammates who may use the space, each read or write")
	}
	normalized := make([]map[string]any, 0, len(grants))
	for _, grant := range grants {
		bot := strings.ToLower(strings.TrimSpace(grant.Bot))
		if bot == "" {
			return nil, fmt.Errorf("every grant needs a bot slug")
		}
		level := strings.ToLower(strings.TrimSpace(grant.Level))
		if level != "read" && level != "write" {
			return nil, fmt.Errorf("grant level %q for @%s is not valid; use read or write", grant.Level, bot)
		}
		normalized = append(normalized, map[string]any{"bot": bot, "level": level})
	}
	body["grants"] = normalized
	return body, nil
}

// dataSkillGate honors the per-bot switch on the data-modeling system skill.
// An unresolvable identity skips the check (fail-open, like the gate itself):
// the broker still enforces per-space access, so nothing is unguarded.
func dataSkillGate(ctx context.Context) error {
	slug := strings.TrimSpace(resolveSlugOptional(""))
	if slug == "" {
		return nil
	}
	if !systemSkillEnabledFor(ctx, systemSkillDataModeling, slug) {
		return systemSkillDisabledError(systemSkillDataModeling, slug)
	}
	return nil
}

// readableDataError lifts the store's own sentence out of the broker's
// "broker POST /path failed: 400 Bad Request {json}" wrapper, so an invalid
// option reads as `stage: "urgent" is not a valid option. Valid options: …`
// instead of hiding inside a status line. Returns err unchanged when the body
// is not the store's error shape.
func readableDataError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	start := strings.Index(msg, "{")
	if start < 0 {
		return err
	}
	var payload struct {
		Error     string `json:"error"`
		Message   string `json:"message"`
		Attribute string `json:"attribute"`
	}
	if decodeErr := json.Unmarshal([]byte(msg[start:]), &payload); decodeErr != nil {
		return err
	}
	text := strings.TrimSpace(payload.Error)
	if text == "" {
		text = strings.TrimSpace(payload.Message)
	}
	if text == "" {
		return err
	}
	if attribute := strings.TrimSpace(payload.Attribute); attribute != "" {
		return fmt.Errorf("%s: %s", attribute, text)
	}
	return errors.New(text)
}

// dataResult renders the broker's JSON body straight through, so the batch
// envelope reaches the bot with its entries in request order and its field
// order intact.
func dataResult(raw json.RawMessage) *mcp.CallToolResult {
	body := strings.TrimSpace(string(raw))
	if body == "" {
		body = "{}"
	}
	return textResult(body)
}
