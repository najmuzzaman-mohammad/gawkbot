# Agent-built data model (objects, attributes, relationships, records)

Status: DRAFT, research complete, plan awaiting founder approval.
Branch: `feat/agent-data-model` (worktree `.worktrees/agent-data-model`).

## Goal

Bots define object types, attributes, and relationships on the fly, then fill
them with records. Each use case gets its own small structured datastore. That
datastore is the data that built apps read and write. The Data section in the
web UI lets the operator browse and edit it, with the same information
architecture as the Nex data UI.

## ICP tutorial examples (these are the spec)

Primary persona is Sam, a founder running an office of bots. Each example must
work end to end before the feature is called done.

### 1. Sam, solo founder, seed raise tracker

Sam types in the office channel: "Track my seed raise. I have talked to about
20 investors so far, notes are in the wiki."

Expected:
1. The bot checks existing object types, finds none that fit, and creates
   `Investor` (name, email unique, stage status: Intro, Pitched, Diligence,
   Committed, Passed; check size currency), `Firm` (name, domain unique, tier
   select), and `Meeting` (title, date, notes text).
2. It creates the relationship fields in the same call: Investor `firm`
   many-to-one Firm (inverse `investors`), and Meeting `investor` many-to-one
   Investor (inverse `meetings`).
3. It re-reads the schema, then creates records from the wiki notes. A second
   run does not duplicate investors, because email is the unique match field.
4. Sam opens Data, sees Investors, Firms, and Meetings in the sidebar, opens
   the Investors table, sorts by stage, clicks a row, and sees the record page
   with the firm link and the list of meetings.
5. Sam says "build me a pipeline board for this". The built app reads the same
   records through the bridge. Moving a card in the app changes `stage`, and the
   Data table shows the new value.

### 2. Priya, agency owner, client delivery tracker

Priya says: "Set up tracking for client projects: clients, projects,
deliverables with due dates and an owner."

Expected:
1. Bot creates `Client`, `Project` (status, budget currency, client
   many-to-one), and `Deliverable` (due date, done toggle, project many-to-one).
2. Priya edits a due date inline in the Deliverables table. The change persists
   and shows on the Project record page under related deliverables.
3. Priya later says "add a priority field to deliverables: low, medium, high".
   The bot adds one select attribute to the existing type. It does not create a
   second Deliverable type. The new column appears in the table.
4. Priya asks the bot to set priority "urgent". The bot gets an error listing
   the valid options and either maps to "high" or asks her.

### 3. Marcus, first ops hire, recruiting pipeline

Marcus says: "We are hiring 3 roles. Track candidates per role and every
interview with a rating."

Expected:
1. Bot creates `Role`, `Candidate` (email unique, stage status, role
   many-to-one), and `Interview` (date, rating 1 to 5, candidate many-to-one,
   interviewer text).
2. A rating of 7 is rejected with a clear message. A candidate cannot be linked
   to two roles, because the field is to-one; passing `replace` moves them.
3. Marcus deletes the `Interview` type from the UI. He sees a preview with the
   record and link counts before anything is removed.
4. This use case lives in its own data space, separate from any other use case
   in the same office.

## What we steal from Nex core

Source: `nex/core` `internal/entity`, `py/chat/tools.py`, `py/chat/agent.py`.

Keep:
- Vocabulary: object type, attribute, relationship, record. (`Entity*`,
  `/entity/`, and `entity_*` tools are taken in this repo by the wiki fact log.)
- Every object type gets a required primary `name` attribute, added by the
  server.
- Attribute type enum, trimmed for v1: text, number, currency, date, toggle,
  select, status, rating, url, email, phone, relationship. Select and status
  allow multi-value where Nex does (status never).
- Relationship as a field: one call creates the definition, the field on the
  owning side, and the inverse field. Cardinality is stated from the owning
  side (`many_to_one`, `one_to_many`, `one_to_one`, `many_to_many`) and
  normalized to stored sides. Cardinality is immutable.
- Same-call target resolution, so two new types can be created and linked in
  one request.
- Links are addressed by field: source record, field slug, target record.
  `already_linked` and `not_linked` are idempotent results. `replace=true`
  swaps a conflicting to-one link.
- Uniform batch envelope: `{succeeded, failed, summary, entries[]}` in request
  order, with per-item success or failure.
- Self-correcting errors: an invalid select value returns the valid option
  names (capped at 25).
- Select values match by option id, then by case-insensitive trimmed name.
  Option ids are minted by the server. Renaming an option keeps its id, so
  records are never rewritten.
- Upsert on a unique attribute only. Nil values are skipped.
- Immutable after create: attribute type, `is_unique`, `is_multivalue`.
- Two-phase deletes for types and attributes: preview with impact counts and a
  token bound to the id set, then execute. 15 minute TTL.
- Ids are strings everywhere.
- Prompt rules, close to verbatim: check existing types before creating;
  re-inspect a type right after creating or changing it; never invent slugs or
  option values; never add a near-duplicate option.

Do differently (Nex pain points):
- Slugs are stable. A rename changes the display name only. Nex regenerates
  the slug on rename and pays for it in every consumer.
- Uniqueness is enforced by the store under one lock, not by
  check-then-insert in application code.
- Creating a relationship and its two fields is atomic.
- Flags are typed struct fields, not keys in a free-form options blob.
- Give the agent a real upsert tool. Nex chat agents only have create plus
  "on conflict, update that id", which costs a round trip.
- No second store and no extraction pipeline in this feature.

## What exists in gawkbot today

- No top-level Data section. "Data" is a read-only tab on a built app
  (`web/src/appdetail/surfaces/AppDataTab.tsx`).
- Per-app store: `internal/team/custom_app_db.go`, `db.json` under
  `~/.wuphf/apps/app_<16hex>/`. Tables, columns (`string|number|boolean|date|
  string[]`), rows, upsert on a key column. Limits 32 tables, 64 columns, 5000
  rows. No relationships, no validation, no row patch or delete, no filter.
- HTTP: `GET|POST /apps/{id}/db` with ops define, upsert, query, clear
  (`internal/team/broker_apps.go`).
- Bridge: `db.*` in `templates/app-scaffold/src/wuphf-bridge.ts`, serviced by
  `web/src/components/apps/CustomAppFrame.tsx`.
- No MCP tool touches app data. A bot cannot define or write data today.
- Builder guidance lives only in `templates/app-scaffold/AI_RULES.md:229-320`.
- `modernc.org/sqlite` is already in `go.mod` (wiki index only).

## Nex app UI blueprint (what we replicate)

Source: `nex/app` `src/routes/_authed/_app/n/$workspaceSlug/knowledge-base/**`
and `.../entity/$entityId/**`, plus `src/features/typed-values`.

Screens:
1. Section index: header band (title, subtitle, primary "New object type"), then
   a list-variant table of object types: icon and name link, record count,
   attribute count, "Settings", "Open". One flat sidebar row for the section;
   object types are not in the sidebar.
2. Records table per object type: back link and H1 plural name, `[Settings]`
   and `[Add {Name}]`. Toolbar: filter popover with count, sort readout, search.
   Table: select column and primary name column pinned start, data columns,
   Updated, actions pinned end, `+` add-column. Column header menu: sort
   ascending or descending, move left or right, hide. Drag reorder and pointer
   resize. Server-side pagination, default 30 per page.
3. Cell editing: double-click, Enter, or F2 swaps the cell for the type's form
   field; Escape cancels. Toggle flips on single click. Rows never have an
   onClick; the name cell is a real link with a hover "Preview" chip that opens
   a peek drawer (`?peek=<recordId>`). Optimistic update with snapshot restore
   on error. Relationship cells are chips plus a popover record picker;
   to-one replaces, to-many adds, chip `x` unlinks; not optimistic.
4. Renderer and editor registries keyed by attribute type, one display cell and
   one form field per type. The same form-field registry powers the
   new-record modal (required attributes first, optional behind an expander).
5. Record detail page: no tabs. Left column: header (avatar, H1 name, type
   badge, created), Attributes card (2-up grid, only filled attributes, empty
   ones as a chip strip), Relationships card (one section per relationship
   attribute, chips capped at 12 with "Show all"). Right rail 348px: Activity
   timeline. The peek drawer reuses the header and an attribute list capped at 8.
6. Object type settings, tabbed: Settings (name, plural, icon, delete all
   records, delete type), Attributes (table of name, type, properties, slug;
   row menu edit, copy id, delete; create modal with type-conditional
   controls). Choosing "Relation" swaps to the relationship modal: source
   name, target type, target name, and four named cardinality modes (Exclusive
   Pair, One Link per Source, One Link per Target, Open Linking).
7. Read-only mode is expressed by withholding handlers.

Deliberate differences from Nex:
- One extra level above the index: the list of data spaces (one per use case).
- Sort, filter, page, and search live in URL search params (Nex keeps them in
  context and on a server-side View). No saved views and no lists in v1.
- Record detail attributes are editable in place, using the same form-field
  registry (Nex left this as a TODO).
- Style with gawkbot design tokens and the three themes, not Nex colors.
  Mono only for data values such as slugs and ids.
- Agent provenance: a "created by @bot" line on object types and records, from
  the actor slug the store already records.

Already in `web/package.json`: `@tanstack/react-table` ^8.21.3,
`@base-ui/react`, React Query, Zustand, TanStack Router. No new web dependency
is needed. Virtualization is skipped in v1 (30 rows per page).

## Decisions and recommendations

1. Scope. RECOMMEND a workspace-level data space, one per use case, that apps
   attach to. ICP example 1 needs data before any app exists, and the founder
   ask is "per use case", not "per app". Per-app-only fails that.
2. Storage. RECOMMEND SQLite, one file per space at
   `~/.wuphf/data/<space_id>.db`, using `modernc.org/sqlite` (already in
   `go.mod`, pure Go). Records hold their values as one JSON column, filtered
   and sorted with `json_extract`; unique attributes get a side table with a
   real UNIQUE index; links are a table. JSON files would keep the 5000 row
   whole-file-rewrite ceiling and make uniqueness and filtering hand-rolled.
3. Existing per-app `db.json` and `db.*` bridge. RECOMMEND leave working and
   untouched, stop teaching it. New apps are taught `data.*` only. The app
   Data tab shows the attached space when there is one, else the legacy view.
   No migration in this feature.

### Founder decisions (2026-09-17)

- Scope: PER AGENT, with sharing and global data (founder, 2026-09-17: "we
  also need global data just like Nex has. any agent data can be shared with
  other agents or made global"). Every space keeps `owner` (the bot that
  created it) and carries `access`:
  - `private`: the owner bot and the operator. The default for a new space.
  - `shared`: plus named bots, each with `read` or `write`.
  - `global`: every bot in the office reads and writes, present and future.
    This is the Nex workspace-data equivalent.
  A bot may create a space as global. The operator can change access on any
  space from the UI; a bot can change access only on spaces it owns. The
  operator always has full access. Enforcement lives in the Go store and is
  checked on every MCP tool call with the calling bot's slug: no access reads
  as not found, read-only writes fail with a message naming the owner.
  `data_list_spaces` returns only spaces the caller can see, with its level.
  Storage is flat, `~/.wuphf/data/<space_id>.db`, so promoting a space never
  moves data. The Data section shows a Global group first, then one group per
  owning bot. An app attaches to any space its builder bot can write.
- Storage: SQLite.
- Proceed with S1 (UI on mock data), then stop for a founder click-through.

## Wire shape (broker HTTP, mirrored 1:1 by MCP tools and the bridge)

```
GET    /data/spaces                          POST /data/spaces {name, description}
GET    /data/spaces/{space}                  (space + object types + relationships: the full schema)
POST   /data/spaces/{space}/object-types     {items:[{name, name_plural?, icon?, description?, attributes:[AttributeInput]}]}
PATCH  /data/spaces/{space}/object-types/{type}
POST   /data/spaces/{space}/object-types/{type}/attributes   {items:[AttributeInput]}
PATCH  /data/spaces/{space}/object-types/{type}/attributes/{attr}   (name, description, is_required, select option add/rename)
POST   /data/spaces/{space}/records/query    {object_type, filter[], sort[], limit, offset, query}
POST   /data/spaces/{space}/records          {object_type, items:[{values}]}
PUT    /data/spaces/{space}/records          {object_type, matching_attribute, items:[{values}]}   (upsert)
PATCH  /data/spaces/{space}/records/{id}     {values}      (null clears)
GET    /data/spaces/{space}/records/{id}     (values + resolved links per relationship attribute)
POST   /data/spaces/{space}/links            {items:[{record, attribute, target, replace?}]}
POST   /data/spaces/{space}/unlinks          {items:[{record, attribute, target}]}
POST   /data/spaces/{space}/delete-preview   {kind: object_type|attribute|records|space, ids[]} -> {impact, token}
POST   /data/spaces/{space}/delete           {token}
```

`AttributeInput = {name, type, slug?, description?, is_required?, is_unique?,
is_multivalue?, options?: [names], relationship?: {target, cardinality,
inverse_name?}}`. `target` may name a type created earlier in the same call.
Every batch call returns `{succeeded, failed, summary, entries[]}`.

MCP tools (`internal/teammcp/data_tools.go`): `data_list_spaces`,
`data_create_space`, `data_get_schema`, `data_create_object_types`,
`data_add_attributes`, `data_update_attribute`, `data_query_records`,
`data_upsert_records`, `data_update_records`, `data_link_records`,
`data_unlink_records`, `data_delete` (preview then execute).

Limits: 50 object types per space, 100 attributes per type, 1000 records per
write call, 100 links per call, 100k records per space.

## Build order (frontend first, then backend, each slice verified)

- S1. Web UI on mock data. `web/src/data/**`: types, fixture for the three ICP
  examples, mock client behind the same interface the real client will use.
  Routes `/data`, `/data/$space`, `/data/$space/$type`,
  `/data/$space/$type/settings`, `/data/$space/records/$id`. Sidebar entry.
  Registries, table, inline edit, peek, record page, schema modals. Stories per
  visual component in all three themes. Vitest for registries, edit lifecycle,
  and URL state. Founder clicks through before backend starts.
- S2. Go store. New package `internal/dataspace` (own package because broker,
  MCP, and bridge all share it): SQLite schema, type system and coercion,
  relationship normalization and cardinality enforcement, upsert under lock,
  delete tokens, batch envelope. Table-driven unit tests for every coercion and
  every cardinality case.
- S3. Broker routes in `internal/team/broker_data.go`, rate limit reused from
  the app DB path. HTTP integration tests. Swap the web client from mock to
  real. Human browser eval of ICP examples 2 and 3 through the UI.
- S4. MCP tools plus prompt rules (system skill `data-modeling`). Tool tests on
  the `stubBroker` pattern. Live eval: a real bot runs ICP example 1 steps 1 to
  4 from one chat message.
- S5. Apps attach. Manifest `data_space`, bridge `data.*` in
  `wuphf-bridge.ts` and `CustomAppFrame.tsx` scoped to the attached space,
  refine data provider resources, `AI_RULES.md` rewrite of the database
  section, app Data tab shows the space. Live eval: ICP example 1 step 5.
- S6. Triangulation review (security, API, types, SRE lenses), CodeRabbit,
  staff review, screenshots via `publish.sh`, draft PR per slice group.

Out of scope for v1: saved views, lists, kanban in the Data section, CSV
import, AI autofill attributes, extraction from text, migration of `db.json`.

## Progress log (keep current; a fresh session resumes from here)

2026-09-17, S1 in flight, nothing committed yet:
- DONE contract: `web/src/api/dataspaces.ts` (types + `DataClient`),
  `web/src/api/dataspacesClient.ts` (exports the mock for now).
- DONE shell: routes in `web/src/lib/router.ts` (`/data`, `/data/$spaceId`,
  `/data/$spaceId/t/$typeSlug`, `.../settings`, `/data/$spaceId/r/$recordId`),
  registry, `useCurrentRoute` kinds `data-*`, sidebar entry under Knowledge,
  exhaustive switches in ChannelHeader, StatusBar, BotPanel,
  useObjectBreadcrumb, RootRoute. Shared chrome in `web/src/components/data/`
  (`DataSection`, `DataPageHeader`, `DataEmptyState`, `BotByline`) and
  `web/src/styles/data.css`.
- DONE model layer (204 tests): `web/src/api/dataspaces.mock*.ts`,
  `dataspaces.fixtures*.ts` (three ICP spaces owned by `cos`, `ops`,
  `recruiter`), `web/src/hooks/useDataSpaces*.ts`,
  `web/src/lib/dataRecordCache.ts`, `web/src/lib/dataTableSearch.ts`. The mock
  implements the real semantics; the Go store in S2 must match it, and its
  tests are the behavior oracle. Additions beyond the plan: duplicate object
  type and attribute names are rejected; delete tokens are single use.
- DONE value layer (147 tests): `web/src/components/data/values/**`,
  `web/src/styles/data-values.css`. URL values only ever become http(s)
  links. `--purple` is undefined in the dark themes, so purple pills use the
  tertiary ramp.
- DONE shared `DeletePreviewDialog`, route tests
  (`web/src/routes/useCurrentRoute.data.test.ts`).
- IN FLIGHT (sub-agents): screens. `index/` + `settings/` (one agent);
  `records/` + `record/` (another).
- NEXT after screens land: tsc, biome, full web suite, e2e route-matrix check,
  isolated-browser eval of the three ICP examples, screenshots, founder
  click-through. Then S2.
