# OpenUI artifact migration design

## Goal

Replace agent-generated self-contained HTML visual artifacts with declarative
OpenUI Lang rendered by the official OpenUI React runtime. Existing persisted
HTML artifacts remain readable, but new agents no longer receive an HTML write
contract.

## Current flow

1. Agent prompts ask the model to emit a complete HTML document through
   `visual_artifact_create`.
2. The MCP tool posts `html` to `POST /visual-artifacts`.
3. The broker validates HTML/CSS, stores `<id>.html` plus metadata, and returns
   the marker `visual-artifact:<id>`.
4. The web client sanitizes the HTML again and mounts it in a shadow root.

## Target flow

1. Add exact versions of `@openuidev/react-lang` and `zod` to the web app.
2. Define a WUPHF static-review OpenUI library. It contains only inert layout,
   prose, table, list, metric, callout, badge, code, divider, and bar-chart
   components. It contains no image/source URL, Markdown/HTML, form, input,
   action, navigation, query, mutation, or shell components.
3. Generate and commit the library prompt through one Bun script. A drift test
   regenerates the prompt and checks it matches the committed output.
4. Keep the provider-neutral `visual_artifact_create` tool name and existing
   list/read/promote tools and `visual-artifact:<id>` markers. Replace only the
   create argument with required `openui_lang`; the tool description embeds the
   generated OpenUI prompt.
5. New bodies are stored as canonical `wiki/visual-artifacts/<id>.openui`
   files. Existing HTML bodies are never rewritten.
6. All artifact surfaces call one representation dispatcher. OpenUI uses the
   official parser and `<Renderer>`; legacy HTML keeps the existing sanitizer
   and shadow-root renderer.

## Durable representations

Metadata is normalized into exactly one of two variants.

### Legacy HTML

- `representation` is missing or `"html"`.
- `htmlPath` is required and must equal the ID-derived canonical `.html` path.
- `contentPath` is absent.
- `sanitizerVersion` is required.
- OpenUI contract fields are absent.

### OpenUI

- `representation` is `"openui"`.
- `contentPath` is required and must equal the ID-derived canonical `.openui`
  path. Readers derive and compare this path; they never follow arbitrary
  metadata paths.
- `htmlPath` and `sanitizerVersion` are absent.
- `openuiVersion`, `openuiLibrary`, and `openuiLibraryHash` are required and
  must equal a supported pinned contract. The library hash is SHA-256 of the
  executable component-library source and the build fails if its Go and web
  pins drift; the generated agent prompt has a separate prompt hash.

Unknown or mixed variants are corruption, not a legacy fallback. List, read,
and promote use the same metadata validator. True absence maps to 404;
corruption maps to 500 with stable `artifact_corrupt` diagnostics.

## Detail API and old-client compatibility

New clients request `?accept_representation=openui` and decode a runtime-checked
correlated union:

- `{ artifact: HtmlArtifact, html: string }`
- `{ artifact: OpenUIArtifact, openui: string }`

An OpenUI artifact requested without the capability query receives HTTP 426
with the stable `openui_client_upgrade_required` code. The broker never
masquerades an OpenUI body as a durable HTML artifact. List metadata remains
representation-aware.

## Validation and resource policy

Create and promotion requests are read through HTTP request-size limits, checked for raw
UTF-8 validity, and strictly decoded as one JSON object. Unknown fields,
duplicate keys, trailing values, `html`, empty OpenUI, NUL bytes, overlong
metadata, and oversize bodies are rejected.

The broker enforces a conservative static subset before persistence:

- maximum body bytes, statements, and line length;
- required canonical `root = Stack(...)` entry;
- forbidden Query, Mutation, state, action, URL, and network-bearing syntax.

The web client applies source-byte, line, and active-syntax budgets before
calling the official OpenUI parser, then validates the parsed semantic
state/query/mutation/orphan collections before mounting. It fails
closed on parse errors, unresolved references, unsupported contract hashes, or
budgets for statements, nodes, depth, arrays, and strings. Each artifact has a
local error boundary and user-visible failure card. The renderer receives no
tool provider and no action handler. Telemetry contains identifiers, hashes,
contract versions, surfaces, and error codes only—never artifact content.

Because the Go broker cannot execute the JavaScript reference parser, newly
persisted artifacts are explicitly server-policy-validated rather than claimed
to be reference-parser-validated. Promotion re-runs the same durable metadata,
content-hash, and static-subset validation. The client parser is the final
rendering gate.

## Identity, retries, and rollout

- Existing HTML IDs retain their historical composite derivation.
- New OpenUI IDs use a representation-domain-separated deterministic digest of
  author, title, exact decoded body bytes, summary, source path, task/message,
  and receipt IDs. `contentHash` remains lowercase SHA-256 of exact body bytes.
  A retry of the same request returns the existing artifact instead of writing
  another commit.
- `WUPHF_ALLOW_LEGACY_HTML_ARTIFACT_WRITES=1` is an explicit drain-only escape
  hatch for old agent sessions; default behavior rejects HTML writes.
- `WUPHF_DISABLE_OPENUI_ARTIFACT_CREATION=1` stops new writes without disabling
  HTML/OpenUI reads, providing a rollback lever.
- The same tool name avoids allowlist churn; the capability projection protects
  old readers. Operators can drain/restart old MCP sessions before removing the
  legacy-write escape hatch in a later release.

## Existing issues fixed in the touched boundary

- Agent promotion requires ownership of the artifact. Human actors retain the
  explicit review authority to promote any artifact.
- Artifact titles and summaries are byte-bounded and normalized so they cannot
  inject new Markdown lines or extra artifact markers into generated notebook
  homes.

## Verification

- Go tests: strict decoding, raw invalid UTF-8, request/body bounds, duplicate
  keys, HTML rejection/escape hatch, deterministic retry, both metadata
  variants, path mismatch/traversal, unknown representation, corruption status,
  ownership on promotion, and legacy HTML reads.
- Web tests: runtime detail decoding, both render branches, unsupported
  contracts, official parser errors, resource budgets, local error containment,
  and all artifact embedding surfaces.
- Prompt test: regenerate the exact prompt from the exact library and compare
  with the committed prompt.
- Build and focused/full Go and web suites run before handoff.
