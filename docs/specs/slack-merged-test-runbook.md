# Slack bot-coordination — merged end-to-end test runbook

This branch (`integ/slack-agent-coordination`) is the integration of the whole
Slack bot-coordination stack on top of current `main`:

| Layer | PR | What |
|---|---|---|
| Egress core | #1051 | `internal/packer` — classify/redact/deliver + prerequisites |
| Brain adapter | #1056 (PR-B) | `internal/team/packer_adapter.go` — packer↔broker seam |
| Slack bridge | #1061 (PR-C) | `internal/team/slack_transport.go` + `slack_bridge.go` — Socket Mode + `packer.SlackBridge` |
| Wiki link | #1059 (PR-E) | `internal/teammcp/wiki_link_tools.go` — `link_task_wiki` |
| Gate (already on main) | #1049 | `ExternalActionApprovalCard` + `broker_approval_action.go` |

It builds clean and the packer/scanner/teammcp suites + the Slack/packer/wiki
`team` tests all pass on this branch.

## What still needs the live workspace (the "together" session)

Two pieces are deliberately finished against real Slack rather than built blind:

1. **`/slack/connect` flow** — the transport maps `broker.SurfaceChannels("slack")`
   → office channels, but nothing creates those surface channels yet (Telegram
   has `/telegram/connect`; Slack needs the equivalent: `POST /slack/connect
   { channel_id, name }` → office channel with a `slack` `channelSurface`). ~200
   lines modeled on `broker_telegram_connect.go`. Until it lands, connect a
   channel by writing a `channelSurface{Platform:"slack", RemoteID:<C…>}` into
   broker state directly (see "Manual channel connect" below).
2. **PR-D — Slack Block Kit approval gate** — render the first-egress / external-
   action gate as a Block Kit card with Approve/Reject and handle the
   `block_actions` interaction back into `broker_approval_action.go`. The
   transport's Socket Mode loop already has the seam (`handleEvent`); it needs an
   `EventTypeInteractive` branch. Best validated live (Slack interactive
   components can't be exercised without a workspace).

The **core compounding loop does not require either** — it can run with a manual
channel connect, and the first-egress gate can surface via the existing web
`ExternalActionApprovalCard` (or be pre-approved for the test).

## 1. Slack app setup (founder, ~5 min)

1. api.slack.com/apps → Create New App → From scratch, in the test workspace.
2. **Socket Mode** → enable. Generate an **app-level token** (`xapp-`) with
   scope `connections:write`. → `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `channels:read`,
   `channels:history`, `groups:history`, `users:read`. Install to workspace →
   **Bot User OAuth Token** (`xoxb-`). → `SLACK_BOT_TOKEN`.
4. **Event Subscriptions** → enable; subscribe to bot events `message.channels`
   (and `message.groups` for private channels).
5. Invite the bot to a test channel: `/invite @<your-app>`. Note the channel id
   (`C…`, from the channel details).
6. Add a second "foreign" bot to the same channel (any vendor bot, or a second
   simple app) to play the delegate.

## 2. Boot the broker from this branch

```bash
# from the integ/slack-agent-coordination worktree
go build -o wuphf ./cmd/wuphf
export SLACK_BOT_TOKEN=xoxb-…
export SLACK_APP_TOKEN=xapp-…
# boot on a non-prod port (see scripts/dev-mvp.sh for the full dev recipe)
./wuphf serve --addr 127.0.0.1:7900
```

On boot, `launcher_transports.go` starts the Slack transport **only when both
tokens are set AND ≥1 slack surface channel exists**. With no connected channel
it skips silently — connect one first (next step).

## 3. Manual channel connect (until `/slack/connect` lands)

Create an office channel bound to the Slack channel id. The minimal path is a
broker channel carrying a `slack` surface with `RemoteID = <C…>`; mirror the
shape `broker_telegram_connect.go` writes (`channelSurface`). A `/slack/connect`
endpoint that does this in one call is the first thing to build in the session.

## 4. Test scenario (the compounding loop)

1. In the connected Slack channel, a human posts a plain goal (e.g. "reconcile
   June invoices and report totals").
2. CEO triage creates a task; plan mode drafts + a human approves.
3. The packer (`Pack` → `Deliver` via `SlackBridge`) injects egress-classified,
   redacted context into the @-mention the foreign bot reads — **untrusted bot
   gets only the redacted ask + approved plan step; no raw task body, no free
   wiki/learning** (assert in the `PackerInjectionSink` audit log).
4. The foreign bot works in the channel; the Librarian observes and curates a
   learning into the wiki (the sole wiki writer).
5. Re-run a similar task → the first-party path now surfaces the task-scoped
   learning + any `link_task_wiki`-linked article: the loop compounds.

### Assertions

- The injected mention never contains secrets (scanner redaction) or Slack
  control sequences (`escapeText=true`).
- `PackerInjectionSink.History()` shows a `DeliverySent` record per delegation
  with the full identity tuple + `RenderedHash`.
- An untrusted bot's bundle is a strict subset of a first-party bot's.
