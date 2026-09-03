# gawkbot

[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/gjSySC3PzV)
[![License: Sustainable Use License](https://img.shields.io/badge/license-Sustainable%20Use%20License-A87B4F)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white)](go.mod)

<p align="left">
  <a href="https://news.ycombinator.com/item?id=47899844">
    <img src="website/hn-badge.svg" alt="gawkbot — Hacker News Life of Product Week's #1" width="223" height="48" />
  </a>
</p>

### open source grok bot. gawkbots use local VMs as computers (cloud option available) and build microapps to manage all your work.

https://github.com/user-attachments/assets/84c4b8cf-fb5d-4e9b-b720-213648c2e20b

gawkbot lets anyone turn their manual workflows into microapps across 1200+
integrations in minutes. Describe the job in one sentence — or demo it once on
a call — and your AI builds the bot that runs it: its own screen, its own
schedule, its own tools, with a human approval gate on everything it sends.
Runs local, on your machine, on your account.

gawkbots automate your menial work via AI models and build you microapps to
manage the outcome, so that you have a false sense of control.

> **grok** *(verb)* — to understand something profoundly and intuitively.
> **gawk** *(verb)* — to stare openly and stupidly.

It is named after the second one. Not after the bots. The bots are working.
You are the one with the dashboard open.

## The open source Grok Bot

gawkbot is an open source Grok Bot: always-on AI bots on your own machine
instead of xAI's cloud, free, on the coding bot you already pay for, with
an approval gate on every external action. The honest version, row by row:

| | Grok Bot (xAI) | gawkbot |
|---|---|---|
| Price | Bundled with SuperGrok and Cursor paid plans | Free. No account, no seats, no usage fees |
| Source | Closed | Public, Sustainable Use License |
| Runs on | xAI's cloud | Your machine, with your keys |
| Models | Grok, chosen for you | Claude Code, Codex, Opencode, local models, Hermes, OpenClaw |
| Bot computers | One per bot, in the cloud | Not yet. Per-bot directory and tool allowlist on your machine |
| Approvals | Bots act on your accounts around the clock | Every send, commit, purchase, and delete waits for your click |

Full comparison, where Grok Bot is better, and the other open source
alternatives (Rakazo, OpenMausBot, OpenBot):
[gawk.bot/open-source-grok-bot](https://gawk.bot/open-source-grok-bot.html).
Website: [gawk.bot](https://gawk.bot).

## Get Started

**Prerequisites:** one bot CLI, signed in — [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
by default, or [Codex CLI](https://github.com/openai/codex) / [Opencode](https://opencode.ai).
The first-run screen verifies your runtime before anything else happens.

```bash
npx gawkbot
```

That's it. The browser opens, you verify your runtime, name your office, and
hand off your first workflow — you land on your first bot being built, live.

Prefer a global install?

```bash
npm install -g gawkbot && gawkbot
```

Building from source (requires Go and Bun):

```bash
git clone https://github.com/najmuzzaman-mohammad/gawkbot.git
cd gawkbot
cd web && bun install && bun run build && cd ..
go build -o gawkbot ./cmd/wuphf
./gawkbot
```

Routine execution runs on a small sidecar service (`agent/`). The broker
finds and supervises it automatically on source checkouts (set
`WUPHF_AGENT_DIR` to point elsewhere, or `WUPHF_AGENT_URL` if you manage it
yourself).

## What you get

Every bot ships with all six. Not a chatbot in a trench coat.

| Part | What it is |
|---|---|
| **The app** | A real screen, built live in front of you. Reads and writes real workspace data. |
| **Routines** | "Every Monday 9:00." Versioned prompts, run history, a transcript per run. New bots get a starter weekly routine from the workflow you described. |
| **Tools** | Self-authored. "Score a lead." "Post to #ae-handoffs." Teach more in the bot's chat. |
| **Knowledge** | Wikipedia-style pages about the bot, every claim cited back to its source. |
| **Data + integrations** | Its own typed tables, plus 1200+ integrations. Connect once; every bot shares it. |
| **Approval gate** | Reads are free. Writes are held until you tap approve. Then it runs 24x7. |

If your workflow names a system that is not connected yet ("audit our
HubSpot"), gawkbot asks before building — build against live workspace data
now, or hold while you connect. It never silently re-scopes your job.

## Setup prompt (for AI bots)

Paste this into Claude Code, Codex, or Cursor and let your bot drive the install:

```text
Set up https://github.com/najmuzzaman-mohammad/gawkbot for me. Read `README.md`
first, then run `npx gawkbot` — the web UI opens at http://localhost:7891.

Walk the onboarding: verify the runtime, name the office, and start the first
workflow. Confirm you land on a bot being built (a live build feed beside a
chat), and that when it finishes the bot shows tabs for UI, Routines, Tools,
Data, Knowledge, and Integrations.

For agent conventions read `AGENTS.md`; for internals read `ARCHITECTURE.md`;
for forking read `FORKING.md`.
```

## Options

| Flag | What it does |
|------|-------------|
| `--provider <name>` | Runtime override (`claude-code`, `codex`, `opencode`, `ollama`, `hermes-agent`, `openclaw-http`) |
| `--no-open` | Don't auto-open the browser |
| `--web-port <n>` | Change the web UI port (default 7891) |
| `--workspace <name>` | Use a specific workspace for one command (does not change the active workspace) |
| `--unsafe` | Bypass bot permission checks (local dev only) |

### Local models and custom endpoints

For custom OpenAI-compatible endpoints (LiteLLM, local proxies, Ollama):

```bash
WUPHF_OLLAMA_BASE_URL="http://127.0.0.1:20128/v1" \
WUPHF_OLLAMA_MODEL="openai/gpt-5.4-mini" \
gawkbot --provider ollama --no-open
```

`--provider opencode` shells out to the `opencode` CLI binary; MLX-LM and
Ollama can be set up from the first-run screen with no cloud key at all.

### Other runtimes

Already running [Hermes Bot](https://github.com/NousResearch/hermes-bot)
or an [OpenClaw](https://openclaw.ai) gateway? Point bots at them with
`--provider hermes-agent` (default `http://127.0.0.1:8642/v1`) or
`--provider openclaw-http` (default `http://127.0.0.1:18789/v1`). Endpoints,
models, and auth are overridable via `WUPHF_HERMES_AGENT_*` /
`WUPHF_OPENCLAW_HTTP_*` env vars or `provider_endpoints` in config.

## Memory: the company brain

gawkbot ships with built-in memory — no backend choice, no API key. Your
workspace state lives in local files you can `cat`: bot knowledge, run
transcripts, and the company brain under `~/.wuphf/`. Knowledge pages are
synthesized with citations back to their sources, so you can check the
receipts on anything a bot claims.

## Other Commands

```bash
gawkbot init                    # First-time setup
gawkbot share                   # Invite one team member over Tailscale/WireGuard
gawkbot shred                   # Delete workspace state and reopen onboarding
gawkbot workspace list          # Run multiple isolated workspaces side by side
gawkbot workspace switch <name> # Flip the active workspace
```

## Share With a Team Member

Two ways to invite a teammate, both from the CLI:

**Private network — Tailscale or WireGuard.** Both machines on the same mesh;
the invite never leaves the network:

```bash
gawkbot share
```

**Public tunnel — no shared network needed.** The broker can spin up a
Cloudflare quick tunnel (`POST /api/share/tunnel/start`; the trycloudflare
URL is paired with a 6-digit passcode, invites are one-use and expire in 24
hours, and the join handler is rate-limited per source IP). `cloudflared`
ships with the npm install (pinned SHA256 per platform). The one-click
button for this is being resurfaced in the operator shell — until then the
endpoint is the path.

For the full walkthrough, see
[Share gawkbot With a Team Member](docs/tutorials/share-with-team-member.md).

## External Actions

Bots act through two providers — pick whichever fits:

- **One CLI** (default, local-first): actions execute through a local CLI on
  your machine; credentials never leave it.
- **Composio** (cloud-hosted OAuth): connect Gmail, Slack, HubSpot, and the
  rest of the 1200+ catalog from any bot's **Integrations** tab. Connections
  are shared across the office.

Either way, the approval gate holds every external write until you approve it.

## Privacy & Telemetry

gawkbot can send anonymous product analytics and session recordings (with typed
text masked) to help us improve it. This is **optional**, controlled by you, and
**off unless a PostHog key is configured** — a stock source build and every fork
ship with no key, so they never phone home.

Two independent toggles (onboarding and Settings), both on by default, both
reversible at any time:

- **Product analytics** — anonymous usage events: which flows are used, where
  people get stuck, error counts. We send **counts and shapes only, never your
  content** (no message text, task titles, customer data, or secrets).
- **Session recording** — recordings **mask everything you type**
  (`maskAllInputs: true`): passwords, API keys, and any form field are
  obscured. We capture layout, clicks, and navigation to fix rough edges.

No autocapture, no cookies (localStorage only). Self-hosted operators can
point at their own PostHog (`WUPHF_POSTHOG_KEY` / `WUPHF_POSTHOG_HOST`) or
leave the key unset to keep gawkbot fully dormant. Full taxonomy and policy:
[docs/specs/product-analytics.md](docs/specs/product-analytics.md).

## Why gawkbot

| | |
|---|---|
| **One bot per workflow** | Small enough to read in a minute, real enough to do the whole job — instead of one giant assistant that does everything badly. |
| **You watch it get built** | The build streams live: the screen, the routine, the tools, assembling in front of you. |
| **Honest by default** | No connected data → the app says "simulated" in plain text. Missing integration → it asks before building. Every knowledge claim carries a citation. |
| **Approval gate** | No email, Slack post, or CRM write leaves without a human tap. |
| **Local** | Runs on your machine, on your keys. Workspace state is files you can `cat`. |
| **Cost you can see** | Settings shows exactly what your bots have spent — dollars, tokens, runs. A typical bot build lands in the $1–2 range on Claude Code. |
| **Price** | Free to self-host (Sustainable Use License, your API keys). |

## Claim Status

Every claim in this README, grounded to the code that makes it true.

| Claim | Status | Where it lives |
|---|---|---|
| Describe a workflow → bot builds live with a streaming activity feed | ✅ shipped | `web/src/operator/surfaces/AppBuilderChat.tsx`, `web/src/components/apps/AppActivity.tsx` |
| Onboarding hands the first workflow straight into the build | ✅ shipped | `web/src/operator/firstWorkflowSeed.ts`, `web/src/operator/OperatorApp.tsx` |
| New bots get a starter weekly routine from the described workflow | ✅ shipped | `web/src/operator/surfaces/AppBuilderChat.tsx` |
| Routines: broker-owned cron, versioned prompts, per-run transcripts | ✅ shipped | `internal/team/scheduler_operator_routines.go`, `web/src/operator/routines/RoutinesTab.tsx` |
| The broker spawns and supervises the routine runner | ✅ shipped | `internal/team/bot_service_supervisor.go` |
| Ask-before-building when a referenced integration is not connected | ✅ shipped | `web/src/operator/builder/describedIntegrations.ts` |
| Approval gate on external writes | ✅ shipped | `web/src/operator/components/ApprovalPrompt.tsx`, `internal/team/broker_action_grants.go` |
| Knowledge pages with inline citations | ✅ shipped | `web/src/operator/surfaces/KnowledgeSurface.tsx` |
| Usage readout — cost, tokens, runs | ✅ shipped | `web/src/operator/surfaces/SettingsSurface.tsx` (GET `/usage`) |
| Operator is the only front door; legacy office routes redirect | ✅ shipped | `web/src/routes/RootRoute.tsx`, `web/e2e/tests/route-matrix.spec.ts` |
| Per-bot typed tables (Data tab) | ✅ shipped | `web/src/operator/surfaces/AppDataTab.tsx` |
| Mix runtimes: Claude Code, Codex, Opencode, local models, Hermes, OpenClaw | ✅ shipped | `internal/provider/`, first-run pre-pick screen |
| Multi-workspace, share, and public-tunnel invites | ✅ shipped | `cmd/wuphf/workspace.go`, `cmd/wuphf/tunnel.go`, `internal/workspaces/` |
| Pixel-art bot portraits (every bot has a face) | ✅ shipped | `web/src/components/ui/PixelAvatar.tsx` |
| Routine runner packaged into the npx/desktop installs | 🔜 planned | supervisor adopts it the moment it ships |

Legend: ✅ shipped · 🟡 partial · 🔜 planned. If a claim and a status disagree, the code wins — file an issue.

## Evaluate This Repo

Before you fork, run this prompt against the codebase with any AI coding assistant:

```
You are a cynical senior engineer evaluating whether to fork this repo as the
base for a bots-that-run-workflows product. No prior context — explore it
as you naturally would. Tell me: should I fork this, and what's your honest
take? Be specific: file paths, line numbers, actual evidence. "The docs are
bad" is useless. Under 500 words.
```

We run this ourselves before every release. If the AI finds something we
missed, [file an issue](https://github.com/najmuzzaman-mohammad/gawkbot/issues).

## The Name

Grok is named for a verb that means to understand something completely and
intuitively. That is a confident name. It promises you a machine that gets it.

gawkbot is named for a verb that means to stare at something openly, at
length, and without taking in any of it. That is the honest name for what
actually happens once the bots are running. The work is done. You are
looking at a dashboard about it.

We are a parody of a bot company. We also ship, which is the part they did
not see coming.

## Star History

<a href="https://www.star-history.com/?repos=najmuzzaman-mohammad%2Fgawkbot&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=najmuzzaman-mohammad/gawkbot&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=najmuzzaman-mohammad/gawkbot&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=najmuzzaman-mohammad/gawkbot&type=date&legend=top-left" />
 </picture>
</a>
