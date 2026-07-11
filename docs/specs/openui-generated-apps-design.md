# OpenUI-generated apps

## Scope

Every newly generated WUPHF App uses OpenUI Lang v0.5 as its complete frontend
document. The WUPHF product shell remains React: it is the trusted host that
renders OpenUI and supplies authenticated backend tools. Existing HTML/Vite
apps remain readable and reversible, but App Builder no longer receives the
Vite scaffold or publishes HTML.

## Durable contract

CustomApp becomes a representation-discriminated manifest.

- representation openui requires entry app.openui plus the pinned OpenUI
  version, library, and executable-library hash.
- representation html requires entry index.html and is legacy-only.
- Missing representation means legacy HTML.
- Mixed fields or non-canonical entry paths are corruption.

Detail and version APIs return correlated unions containing either app plus
openui, or a legacy app plus html. Version snapshots retain the exact
representation and body; rollback restores both.

The `wuphf-app-v1` executable library is frozen: incompatible changes mint a
new library id and implementation instead of changing the meaning of its hash.
The host keeps a registry keyed by `(openui_version, library, library_hash,
provider_version)` and must retain an implementation for every readable
snapshot. The initial registry contains the single generated v1 tuple. Current
and historical OpenUI reads require `accept_representation=openui`; older web
bundles receive a stable 426 response rather than an envelope they cannot
render.

New App Builder registration accepts only openui_lang. The broker's legacy HTML
write path and server-side Vite build remain temporarily for migration/tests,
but those fields are excluded from the App Builder's MCP schema and prompt.

Publication is a compare-and-swap using `expected_version`. The per-app lock is
acquired before reading the current manifest; stale writers receive a 409.
App Builder publication is also bound to the reserved app's owning task channel
so text inside an app cannot redirect a builder run to a different app id. The
immutable version snapshot is staged first and the manifest is the final commit
point; current body reads verify the manifest content hash and fail closed on a
partial write.

## Generation

The browser-owned OpenUI app library generates the App Builder system prompt. A
generated prompt file and executable-library hash are embedded in Go; the web
build fails on drift. App Builder writes one bounded OpenUI document, validates
it with a read-only validate_app tool, then publishes through register_app.

Edits call get_app, regenerate or patch the OpenUI document, validate, and
publish the next version. There is no dev server, dependency install, source
tree, or HTML bundle. Build preview polls durable app detail and renders each
published OpenUI version directly.

## Component library

The WUPHF-owned, token-styled library contains:

- layout: App, Stack, Card;
- content: Heading, Text, Badge, Metric, Callout, List;
- data: Table, DataTable, Progress;
- inputs: TextInput, Select;
- actions: Button with OpenUI action plans.

Components render text as text, never HTML or Markdown. No component accepts a
URL, raw style, class name, script, image source, or arbitrary node outside the
library reference system. OpenUrl is rejected. Source and render budgets are
enforced before parsing and after materialization.

## Backend tool provider

The trusted host maps fixed OpenUI tool names to existing authenticated broker
APIs. The document never receives a bearer token or arbitrary path.

Read queries:

- wuphf_list_tasks
- wuphf_list_office_members
- wuphf_list_channels
- wuphf_list_requests
- wuphf_wiki_list
- wuphf_wiki_read
- wuphf_list_integrations
- wuphf_app_db_query

Mutations:

- wuphf_create_task
- wuphf_call_integration
- wuphf_app_db_define
- wuphf_app_db_upsert
- wuphf_app_db_clear

Each function validates a strict, size-bounded argument schema before calling a
fixed endpoint. Every mutation displays non-spoofable host chrome naming the
actual tool and material arguments. Integration calls require that confirmation
regardless of the server's legacy read/write classifier. The existing local
`wuphf_ai` subprocess is intentionally not exposed because it inherits user MCP
configuration and is not a safe declarative-app boundary. Database paths and
budget keys use the host-supplied current app id, never a document value.

Queries may run on mount. Mutations run only from Run actions. Auto-refresh has
a minimum interval and a maximum number of active queries. Tool results are
capped before returning to OpenUI.

## Security boundary

OpenUI replaces the hostile iframe with a hostile declarative document inside a
trusted renderer. The trust boundary moves to:

1. strict persisted and API codecs, including duplicate/unknown/trailing-field
   rejection on publication and Zod validation on browser reads;
2. static OpenUI syntax and resource policy;
3. the exact component library;
4. the fixed tool-provider map and per-tool validators;
5. existing broker authorization and mutation approval.

The document cannot select an endpoint, HTTP method, integration policy, app
id, or authorization header. Runtime errors are contained by an app-local error
boundary. Diagnostics contain ids, versions, hashes, tool names, and error
codes, never app data or document content.

## Compatibility and rollout

- Existing HTML apps continue in the sandboxed CustomAppFrame.
- New OpenUI apps render through OpenUIAppRenderer.
- Old live-dev endpoints return a stable unsupported response for OpenUI apps
  and remain functional for legacy HTML apps.

## Verification

- Go store, API, and MCP tests for variants, version and rollback, bounds,
  canonical paths, and rollout flags.
- Web schema, parser-budget, tool-validator, approval, and renderer tests.
- Full Go and web suites, build, lint, typecheck, and secret scan.
- Real browser flow: create an app, observe OpenUI preview, exercise a backend
  query, trigger a gated mutation, edit and republish, inspect history, and
  rollback.
