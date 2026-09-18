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
PATCH  /data/spaces/{space}                  {name?, description?, access?}
POST   /data/spaces/{space}/apps/{appId}     attach    DELETE same path detaches
POST   /data/spaces/{space}/object-types     {items:[{name, name_plural?, icon?, description?, attributes:[AttributeInput]}]}
PATCH  /data/spaces/{space}/object-types/{type}
POST   /data/spaces/{space}/object-types/{type}/attributes   {items:[AttributeInput]}
PATCH  /data/spaces/{space}/object-types/{type}/attributes/{attr}   (name, description, is_required, select option add/rename)
POST   /data/spaces/{space}/records/query    {object_type, filters[], sort{attribute,desc}, limit, offset, query}
POST   /data/spaces/{space}/records          {object_type, items:[{values}]}
PUT    /data/spaces/{space}/records          {object_type, matching_attribute, items:[{values}]}   (upsert)
PATCH  /data/spaces/{space}/records/{id}     {values}      (null clears)
GET    /data/spaces/{space}/records/{id}     (values + resolved links per relationship attribute)
POST   /data/spaces/{space}/links            {items:[{record, attribute, target, replace?}]}
POST   /data/spaces/{space}/unlinks          {items:[{record, attribute, target}]}
POST   /data/spaces/{space}/delete-preview   {kind, ids[]} -> {impact, token}
       kind = space|object_type|attribute|records|records_of_type
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


## S2 to S5 log (backend)

2026-09-17, founder decision: HOLD the PR until the backend is real. Do not
land a Data section running on fixtures: every user would see invented
investors and candidates, which is the fabricated-UI-state class of bug the
#1189 honesty pass removed. The nav entry ships only when the store is live.

- DONE S1, committed on `feat/agent-data-model` as `feat(data): bot-owned data
  spaces, UI on mock store` (210 files). Full web suite green: 300 files,
  3316 tests. Browser-verified against a bot-free dev office.
- DONE the Go contract: `internal/dataspace/types.go`, the `Store` interface
  plus `NormalizeAccess` and `LevelFor`. It compiles. THE TS MOCK IS THE
  BEHAVIOR ORACLE: `web/src/api/dataspaces.mock*.ts` and its tests define
  coercion, cardinality, upsert matching and delete impact. Go must match it,
  and any difference is reconciled rather than left.
- IN FLIGHT: S2 SQLite store (`internal/dataspace/**`); S3 broker routes
  (`internal/team/broker_data*.go`) plus the real web client in
  `web/src/api/dataspacesClient.ts`; S4 MCP tools
  (`internal/teammcp/data_tools.go`) plus the prompt rules and
  `templates/app-scaffold/AI_RULES.md`.
- OPEN question the founder asked, 2026-09-17: "can apps use this data as
  context?" Not yet. Three senses, all S5 or later: an app reading records at
  runtime through a `data.*` bridge; the app-builder bot seeing the schema
  while it builds; and records as retrievable context for bots, for which the
  precedent is `internal/team/broker_apps_knowledge.go`, which already derives
  a per-app knowledge page from app DB tables and can push it to gbrain.
  A global space makes that last one office-wide context.
- NEXT after S2 to S4 land: reconcile Go against the mock, triangulation
  review on the wire shape (AGENTS.md requires it for a new public API), S5
  apps attach, then one PR with screenshots and a live bot eval of the three
  ICP examples.

## Triangulation review, API/types lens (2026-09-18)

Blocking, being fixed:
- An unknown attribute type CRASHES the Data table. `VALUE_CELL_RENDERERS` is a
  `Record` with no index signature, so a value the bundle has not seen renders
  `undefined` and React unmounts the table. A newer broker with an older bundle
  is enough. Same shape in the icon map; an unknown cardinality silently reads
  as to-one. Fix: fall back visibly at every registry lookup.
- `Schema.Relationships` and `Space.CallerLevel` are emitted by Go and dropped
  by TS. Consequences: the space page GUESSES which side owns a relationship
  when the server now says, and the UI cannot tell a read-only space from a
  writable one.
- `records_of_type` is implemented in Go and MCP but missing from the TS union,
  so "Delete all records" never shipped and its TODO is stale.
- Enum drift is unpinned: the mirror test compares top-level json tags for 9
  input types only. No enum, no output type, nothing on the TS side.

Blocking, queued behind the store agent (internal/dataspace is held):
- `Result` cannot distinguish changed from already-in-that-state. Add `Noop`.
- `data_upsert_records` tool text promises entries say which matched and which
  were created; the envelope carries no such field. Add `Entry.Created` or
  strike the sentence.
- MCP and `NormalizeAccess` disagree: MCP rejects grants on private/global and
  rejects shared-with-no-grants; the store silently rewrites both. DECISION:
  reject grants on private/global in BOTH, and keep the shared-with-no-grants
  downgrade to private in both, because the UI pins that behaviour.
- Filtering select/status by option ID silently returns zero rows, because
  filters compare by option NAME while reads return ids. Match id first, then
  name. The mock agrees with Go here, so fix both.

Accepted, not fixed: `Filter.Value` cannot express empty vs absent; currency
code on a non-currency attribute is dropped silently; `Attribute` can carry
both options and a relationship in the output type; three spellings of
object_type/typeId; `Preview.ExpiresAt` unused by the UI; no MCP tool for
renaming an object type.

## Triangulation: security and SRE lenses (2026-09-18). ALL THREE CLOSED.

Three CRITICAL findings, every one now fixed and proved by a test that failed
first against the old code. Kept in full because the reasoning is the record of
why the code looks the way it does, and because a future change could reopen
any of them. Status is marked per item below.

1. SECURITY, critical. FIXED 2026-09-18. An absent `X-WUPHF-Agent` header makes the caller the
   operator (`broker_data.go` dataActorFromRequest), and the operator has write
   on every space. Every bot holds WUPHF_BROKER_TOKEN and the broker URL on its
   own command line (`prompts.go:273`) and can run a shell, so any bot can read
   and write every space in the office, including other bots' private ones, and
   escapes rate limiting while doing it. The reserved-slug denylist blocks the
   string "human" but omission defeats it. Verified by reading both files.
   FIX: fail closed; authenticated-but-unidentified is no access.
2. DURABILITY, critical. FIXED 2026-09-18. A zero-length or replaced space file opens cleanly,
   reports schema version 0, gets the v1 DDL, and reads as a brand-new EMPTY
   space while `spaces.db` still claims its old record count. The UI then shows
   the honest empty state over lost data. Proved by execution.
   FIX: refuse to initialise a non-empty file at version 0, and fail loudly when
   the index count and the file disagree.
3. DURABILITY, critical. FIXED 2026-09-18. `migrateSpace` DOWNGRADES a newer file's
   schema_version (`for version < schemaVersion` then an unconditional write),
   so an older binary silently restamps a v2 file as v1 and the next upgrade
   re-runs migrations over it. `migrateIndex` gets this right; the space path
   does not. This ships in an npx binary users downgrade freely. Proved.
   FIX: refuse a file newer than the build; only write the version on change.

Also found, all fixed in the same pass except where noted:
- Two brokers on one home fail ~50% of writes with SQLITE_BUSY_SNAPSHOT in 0ms
  (busy_timeout does not apply to a read-snapshot upgrade), surfacing as a 500
  with no log. This repo routinely has several worktrees and a prod office on
  one machine. FIX: BEGIN IMMEDIATE on write paths plus a retry.
- `removeSpace` drops the index row before unlinking the file, so a crash
  strands an unreachable file. FIX: rename first, then row, then unlink, plus an
  orphan sweep at Open.
- The web proxy's app-builder header exception decides data identity on /data.
- The broker never validates the space id shape, so arbitrary path segments
  become mutex and rate-limit keys; `IsSpaceID` exists and is never called.
- Per-space mutexes, delete tokens and DB handles are unbounded in-process maps;
  the mutex map is keyed before authorization, so denied calls grow it.
- No caps on filter count, search length or value size; a query loads the whole
  object type into memory (100k records = 699ms and 130MB per request).
- A non-owner with write can rename another bot's space and attach apps to it.
- A single store-open failure is memoized for the process lifetime.
- Zero logging anywhere in the store or the routes, so "my data is gone" has
  nothing to look at.

Not a finding, worth recording: a hard store error does NOT render as empty.
The UI distinguishes "could not be loaded" from "no records yet". Only finding
2 slips through, because it is not an error.

## Deferred: read-only propagation into the record surfaces (2026-09-18)

`Space.CallerLevel` now reaches TypeScript and `DataSpacePage` honours it: a
read-only space withholds Share and New object type and says who owns it. The
records grid and the record page do NOT yet honour it. Threading optional
handlers through `records/RecordsPage`, `RecordsTable`, `RecordsTableRow`,
`NameCell`, `RelationshipCell`, `PeekDrawer`, `record/RecordPage`,
`RecordAttributes`, `InPlaceValue` and the settings tabs is mechanical, because
`EditableValueCell.onCommit?` already has the capability-by-withheld-handler
shape, but it is about ten components plus tests and stories.

This is LATENT, not live: the web client authenticates as the operator, who
always has write on every space, so no operator can currently reach a
read-only surface. It becomes live the moment something calls as a bot, which
is the app bridge. Close it in or before that slice, or an app attached to a
space its bot can only read will render controls that always fail.


## Wire-shape corrections applied (2026-09-18)

The Wire shape section above drifted from the code during the backend slices and
has been corrected in place: the query body takes `filters[]` and a single
`sort` object (not `filter[]`/`sort[]`), `records_of_type` is a real delete
kind, and the space PATCH and app attach routes were missing. `types.go` is the
authority; the enum lists are now pinned from TypeScript by
`web/src/api/dataspaces.contract.test.ts`, which parses the Go consts, so this
particular drift cannot recur silently.

Still true and deliberate: `Attribute.Relationship` and `Schema.Relationships`
both exist. The attribute carries the owning side so a single attribute is
self-describing; the schema list carries the pair so nothing has to infer which
side owns it. The UI uses the list and keeps the inference only as a fallback
for a broker that does not send one.


## Landed (2026-09-18)

PR https://github.com/najmuzzaman-mohammad/gawkbot/pull/1242, two commits:
`feat(data): bot-owned data spaces, UI on mock store` and `feat(data): SQLite
store, broker routes and MCP tools for data spaces`. Screenshots skipped at the
founder's explicit request; the repo's FE-screenshot rule otherwise applies.

State at merge: all three Go packages green, the web suite green, no new
dependency. Every triangulation finding is either fixed or recorded above with
its reason.

### What is NOT done, in priority order

1. Read-only propagation into the records grid and record page. Latent while
   only the operator uses the UI; live the moment an app calls as its bot. See
   the deferred section above for the exact component list.
2. `QueryRecords` loads the whole object type to serve one page (699ms and
   130MB at 100k records). The input caps bound the damage; the fix is limit
   and offset pushdown into SQL.
3. No `wuphf data repair`. A space that lost every object type AND whose index
   still claims records refuses to open, and recovery means hand-editing
   spaces.db. Narrow, but sharp.
4. Per-bot credentials. Until they exist a bot can present another bot's slug
   and reach that bot's private space. Repo-wide, not specific to this surface.
5. `Result` cannot distinguish a change from a no-op, and upsert entries do not
   say which matched and which were created, though the tool text implies they
   do. Both are additive envelope fields; do them before the shape sets.
6. Filtering select/status by option ID silently returns nothing, because
   filters compare by option NAME while reads return ids. Go and the mock agree,
   so fix both together.
