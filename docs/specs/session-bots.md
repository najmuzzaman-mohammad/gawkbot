# Session bots: what Claude Code and Codex let another process do

Findings from a live experiment on 2026-10-10 (03:07 to 03:38 CEST) with
`claude` 2.1.296 and `codex-cli` 0.156.1, run in isolated config directories
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) so no real user config was touched. These
decide how gawkbot attaches to a terminal session it did not start.

## How to read this

The model was scripted. Neither tool was logged in inside its isolated
directory, so a local endpoint on `127.0.0.1` returned canned replies: one
shell tool call, one ask-the-user tool call, or the word "ok". Hooks, approval
dialogs, timeouts, session logs, and resume are all client-side, so the
observations below hold. What a real server could change is marked.

- **Confirmed**: observed, and purely client-side.
- **Client only**: observed, but a real server or model could differ.
- **Docs only**: read, not observed.

Re-run before relying on any of this after a tool upgrade. Both tools' hook
surfaces are young and their session files are undocumented.

## The one that decides the design: a pending permission hook

A `PermissionRequest` hook that takes time to answer behaves in opposite ways
in the two tools. Both confirmed.

| | Claude Code | Codex |
|---|---|---|
| Terminal while the hook runs | Normal approval dialog, visible and answerable the whole time | No dialog. "Working · Running hook". Only Esc works, and it cancels the turn |
| Who wins | Whichever answers first, hook or human, in both directions | The hook, or nobody |
| Human answers in the terminal first | Yes runs at once and the hook's later answer is discarded. No kills the hook | Not possible. Typed keys land in the message composer |
| Hook returns no decision | Dialog stays as it was | Dialog appears only after the hook exits |

Consequences:

- **Claude Code**: gawkbot can mirror the prompt in the notch and on the phone
  without taking the terminal away from the person sitting at it. The hook
  holds with its own timeout. `PostToolUse` firing, or the hook being killed,
  means it was answered elsewhere and the card must go.
- **Codex**: a hook that waits for an answer in gawkbot freezes the terminal
  for that long. The hook must return no decision at once and let the terminal
  ask. gawkbot can show that the session is waiting, but answering a Codex
  approval from the notch means taking the prompt away from the terminal.

## Hook events and what they carry

Confirmed for both. Every event carries `session_id`, `transcript_path`, and
`cwd`.

- **Claude Code**, interactive: `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PermissionRequest`, `Notification` (about 6 seconds later,
  only while the dialog is open), `PostToolUse`, `Stop`, `SessionEnd`. The hook
  environment has `CLAUDE_PID`. The model is on interactive `SessionStart`
  only. `PermissionRequest` also fires in `-p` mode.
- **Codex**: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PermissionRequest`, `PostToolUse`, `Stop`, `SessionEnd`, and `Interrupt` on
  Esc. No `Notification`. Carries `model` and `turn_id`, no pid.
  `PermissionRequest` does not fire under `codex exec` (approval is "never").
- `SessionEnd` is not reliable in Claude Code: it was missed on one of two
  interactive exits. Do not treat its absence as "still running".

Allow and deny are the same JSON in both tools (confirmed by whether the
command ran):

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

`"behavior":"deny"` with an optional `"message"` denies.

## Failure behaviour

Confirmed, interactive, for a command that needs approval.

| Hook result | Claude Code | Codex |
|---|---|---|
| exit 1 | normal dialog | normal dialog |
| exit 2 | normal dialog (ignored) | blocked, stderr shown as the reason |
| invalid JSON, exit 0 | normal dialog | normal dialog |
| allow JSON, then exit 1 | **allowed, command ran** | normal dialog |
| slower than its `timeout` | hook killed, dialog stays | "Hook failed: timed out", then normal dialog |
| no decision, headless | denied | hook never fires |

Two rules follow. A gawkbot hook must never exit 2 (Codex reads that as a
deny). It must print a decision only as its very last act, because Claude Code
honours an allow already on stdout even when the hook then crashes.

The per-hook `timeout` (seconds) is honoured by both. The default is 600
seconds (confirmed on the Codex `/hooks` screen, docs only for Claude Code), so
a hook that sets none can hold a decision for ten minutes.

## Installing and trusting a hook

- **Claude Code** has no trust step for user settings. A hook in
  `settings.json` runs in new sessions, and a change to an existing hook's
  command is hot-loaded into a running session within about 3 seconds.
  Confirmed. Adding a brand-new event entry to a running session was not
  tested, so a session that was already open when gawkbot installs its hook
  may not have it until it restarts.
- **Codex** trusts each hook by a hash of its command string in `config.toml`.
  The TUI shows "Hooks need review" at startup with Review, Trust all, and
  Continue without trusting; `codex exec` skips an untrusted hook with no
  message. An edited hook keeps running its old command until trusted again.
  Trust covers the command string, not what the script does. Confirmed.
- On the machine this ran on, `claude` and `codex` on `PATH` are third-party
  wrappers, and the Codex wrapper passes `--dangerously-bypass-hook-trust` on
  every launch. A user's real config may already hold another tool's hooks on
  the same events. gawkbot is a second consumer and must merge, not replace.

## Finding live sessions without a hook

Claude Code keeps `<config dir>/sessions/<pid>.json` for each running process:
`pid`, `sessionId`, `cwd`, `kind` (`interactive`), `status` (`idle`), `name`.
It is removed on exit. Confirmed, undocumented. This answers "is this session
open in a terminal right now" exactly, which the session log cannot.

Codex has no equivalent that was found. Its guard is a writer lock (below).

## Getting a message into a session

| | Claude Code | Codex |
|---|---|---|
| Session has ended | `claude -p --resume <id>` keeps the id and appends to the same log | `codex exec resume <id>` keeps the id and appends to the same log |
| Session is open and idle | A `Stop` hook with `asyncRewake` wakes it within a second, but the text reaches the model labelled as a system notification, not as a message from the user | `codex queue --thread <id> --message <text>` arrives in the idle TUI in about 8 to 10 seconds as a real user prompt |
| Resume while it is open | **Silently accepted. Forks the conversation inside the same file. The open terminal never sees the outside turn** | Refused: "already has an active writer" |

Resume keeping the id and file is client only: the model call was scripted, so
whether the real server accepts a resumed conversation is untested.

Consequences:

- **Codex** can be messaged like any bot, open or ended, through its own queue
  and resume. It protects itself against a second writer.
- **Claude Code** can be messaged once it has ended. While it is open, a
  resume must never be run: nothing stops it and it corrupts the session the
  person is looking at. The `sessions/<pid>.json` registry is the gate. A
  message to an open session can only arrive as a wake-up the model is told is
  not from the user, and it needs a hook that stays running in the background.

### What gawkbot does with it

Built on the table above (`internal/team/headless_session_turn.go`,
`headless_session_runner.go`, and `broker_session_messaging.go`). Not yet run
against a logged-in tool. On by default; `WUPHF_SESSION_MESSAGING=0` in the
office's environment turns it off.

- **Who may message.** Only a message the owner posted through the office's
  own web UI, in that session member's own DM. The proof is the operator key
  the web UI proxy stamps (`requestIsOperator`), noted by message id when the
  message is posted, never the message's `from`. A bot, the system, a joined
  human, and a mention anywhere else start nothing and get the fixed reply.
  The whole decision is one function, `claimOwnerSessionMessage`.
- **What each surface can do.**
  - Web app: messages a session. It posts through the web UI proxy
    (`web/src/api/client.ts`), which stamps the operator key.
  - Notch: messages a session. Its page is served from the web UI origin and
    posts through the same proxy (`web/src/notch/api.ts`). Read from the
    code; not yet confirmed in the running app.
  - iOS app: cannot message a session. It posts to the broker port with the
    token and no operator key (`BrokerClient.swift`), so its message gets
    the fixed reply. The app shows its composer disabled for sessions, which
    is the honest state until the phone has a way to prove the owner.
- **A session is never an office turn.** A message that is not delivered
  gets the fixed reply and nothing else: no turn is queued for the session,
  and neither the Chief of Staff nor any other bot is woken by it. A bot
  writing to a session in a bot-to-bot DM gets no reply at all.
- **Claude Code.** `claude --print --resume <id> --output-format stream-json
  --verbose`, prompt on stdin, only when the session is known to be closed,
  and checked again immediately before it starts. Closed is known when the
  registry names at least one live interactive session and not this one, or
  when no Claude Code process is running at all. Claude Code running with a
  registry that names none of it is unknown, and nothing is resumed.
- **Claude Code, open in a window.** The message is typed into that window
  (`headless_session_typing.go`, through `internal/termsend`), only when the
  window reads `status: "idle"` in its registry entry, read again right before
  typing. Measured on Claude Code 2.1.296 with a real session in tmux on
  2026-10-10: `idle` waiting for input, `busy` while working, `waiting` with
  `waitingFor: "permission prompt"` while it shows "Do you want to proceed?",
  absent before the first prompt, and no registry entry at all while the
  folder-trust dialog is up. Anything but `idle` holds the message (one note
  says so) until the window is free, Stop, or fifteen minutes; a window that
  closes while it holds falls back to the resume above. The answer is read
  back from the log: the text of the first assistant record ending in
  `end_turn` after the point the message was typed, posted as the session's
  reply. Typing works in tmux, Superset (its command-line tool, which must be
  logged in once), Terminal.app, and iTerm2; anything else gets a plain
  sentence naming the app. Not seen from here: text
  the person has half-typed in that window (the message is appended to it).
  A message is flattened to one line and refused if it starts with `/`, `!`,
  or `#`, which the session would run as its own command.
- **Codex.** `codex exec --json resume <id> -`, prompt on stdin. When it
  exits with an error and says "already has an active writer", the message
  goes to `codex queue --thread <id> --message=<text>` and one note says it
  was delivered to the window. The answer is not copied back: the next turn
  to finish in that window need not be the answer to that message. Any other
  failure is reported and never queued.
- **How they run.** No shell. The folder the member was made in, which never
  changes afterwards and must exist. The person's environment without any
  `WUPHF_*` variable. No permission, sandbox, model, system prompt, settings,
  or MCP flag, refused again at run time. Text only, at most 8000
  characters. One turn per session at a time, three more may wait. Fifteen
  minutes, then the process group is killed. Stop, removing the member, and
  the office shutting down all end it.
- **Who may read it.** A session's DM is served to the owner only; a joined
  human is refused it on every route and on the event stream.

Residuals that stay, and why each is accepted:

- A process on the machine that posts through the web UI port is taken for
  the owner (issue #1168). It already runs as the person and can run the
  tool itself.
- A process that can write under `~/.claude` or `~/.codex` can forge session
  logs and Claude Code's list of open sessions, including deleting a real
  entry so an open session reads as closed and a resume forks it. The same
  write access already lets it add a hook to the person's `settings.json`
  and run code at the next launch. Nothing more than that is claimed.
- An office bot can read a session's DM, including what a resumed session
  answered. Bots hold the same broker token as the phone and the notch and
  cannot be told apart from them (issue #1168).

## Questions the tools ask the user

- Claude Code's `AskUserQuestion` goes through `PermissionRequest` with the
  questions in `tool_input`. A hook can answer it by returning allow plus
  `updatedInput` carrying the answers. Confirmed. The tool is not offered in
  `-p` mode.
- Codex's `request_user_input` fires `PreToolUse` only, and is unavailable in
  the default mode. Plan mode was not tested.

## Security

In both tools, any process running as the same macOS user can answer a
permission prompt. Claude Code has no hook trust step. Codex's is a hash of a
command string and can be bypassed with a flag. `codex queue` accepts a prompt
from a logged-out process with no confirmation. Nothing in either tool proves
that a human answered.

So gawkbot has to supply that proof itself. An approval that came in through a
hook must be answerable only by the person, not by an office bot holding the
broker token (see issue #1168). Until that holds, a bot that has read
something hostile could approve a command in the person's terminal.

## Not yet known

- Whether the real servers accept a resumed or forked conversation.
- Whether Claude Code's auto permission mode, the default in a fresh config,
  calls `PermissionRequest` at all. The experiment forced manual mode.
- Real model ids in hook stdin, and real tool-call shapes for Codex
  escalation.
- Codex plan-mode questions.

Answering these needs a one-time login inside an isolated config directory.
