# Interbot experience: learnings from the OpenMausBot codebase

Status: research notes, 2026-09-02. Source: full clone of
`milind-soni/OpenMausBot` (server/, docs/plans/), read against our broker
(`internal/team`). Written to inform improvements to gawkbot's interbot
experience. Nothing here is implemented yet.

## Where the two products stand today

| Axis | OpenMausBot | gawkbot |
|---|---|---|
| Primary surface | 1:1 bot chats + rooms/channels | Task channels + human↔bot DMs |
| Bot↔bot talk | `ask_bot` / `delegate_bot` tools, mirrored into an auto-created `A ⇄ B` pair channel | @mention in a shared channel auto-promotes to a tag and wakes the peer (`broker_messages.go:118`) |
| Bot↔bot DMs | Yes, as observable pair channels the human can open and join | None, by design; DM slugs always pair with `human` (`broker_dm.go:36`) |
| Loop protection | Structural: `MAX_COMMS_DEPTH = 1`, peer turns get no bots tools | Prompt-level plus self-heal cap; no structural hop cap |
| Team runs | Bounded goal runs, 13 turns, coordinator owns completion | CoS routes freely; no turn budget or terminal statuses |
| Busy peers | Woken later, never skipped; visible wait chips; bounded retries | Per-slug queues exist (`headless_codex_queue.go`), but no visible wait state |
| Concurrency | Serialized per bot, decided in a written record | Serialized per slug, undocumented as a contract |

Our open-channel model is the more legible one and we should keep it as the
primary surface. What OpenMausBot does better is everything around the
edges: observability chips, structural caps, honest completion, and
crash-safe handoffs.

## Learnings worth adopting

### 1. Make every bot-to-bot wake observable where the human is looking

`server/comms-visibility.ts` mirrors every peer exchange three ways: the
full text into the `A ⇄ B` pair channel, a "Messaged @B" activity chip
into the source bot's thread, and a "Message from @A" chip into the
target's thread, each chip linking to the channel. The stated rationale:
peer turns cost the user tokens, and "a hidden exchange is exactly the
kind of mistake peer coordination is supposed to avoid." Terminal states
of async handoffs are mirrored too, citing A2A and MCP Tasks prior art.

gawkbot gap: a tag-wake between bots is visible only if you are looking
at that channel. Nothing in the human's DM or inbox says "Writer asked
Editor for a pass in WAVE-22."

Proposal: when a bot's tag wakes another bot, append a small system
chip to the human-facing surface (inbox or the CoS DM) linking to the
channel and message. No new channel primitive needed; our task channels
already hold the exchange itself.

### 2. Two peer verbs with different contracts, taught in the prompt

OpenMausBot separates a short synchronous consultation (`ask_bot`,
4-minute ceiling, reply folded into the current answer, degrades into a
delegation ticket if the peer cannot finish in time) from an async
handoff (`delegate_bot`, queued until the source turn settles, peer gets
a fresh turn, durable receipt readable later via `check_delegation` /
`wait_delegation`). The system prompt teaches the split: "Use
delegate_bot for assigned or independent work so you remain available;
use ask_bot only for a short consultation whose reply is required in your
current answer."

gawkbot gap: one mechanism (tagged message) for both intents, and the
delegating bot has no way to read back the outcome later.

Proposal: add a delegation receipt: when bot A tags bot B with an
assignment inside a task, record a receipt row (target, status
done/failed/denied/busy_gave_up, bounded result) that A's later turns can
query. OpenMausBot bounds the drawer at 100 receipts, 48 hours, 4k chars
per result; do the same.

### 3. Structural loop protection, not prompt-level hope

`MAX_COMMS_DEPTH = 1`: a peer turn spawned by another bot runs at depth 1
and receives no bots tools at all, so A→B→C chains and ping-pong loops
are structurally impossible. Delegation retries against a busy target are
bounded (`MAX_BUSY_ATTEMPTS = 3`), and peer wakes draw from a
`DelegationWakeBudget`.

gawkbot gap: bot-originated tags auto-promote like human ones
(`senderMayAutoPromoteLocked` allows any registered bot), so nothing
structural stops two bots from re-waking each other.

Proposal: carry a hop count on bot-originated wakes. A turn at hop 1
still posts freely, but its @mentions do not auto-promote to tags; the
lead relays if a further wake is genuinely needed. One integer on the
message record, one guard in the auto-promote loop.

### 4. Busy means "woken later," and the transcript says so honestly

`waitForGroupMemberBot` parks a room turn on a busy member using store
change events (no polling, no model turns burned), posts one chip when
the wait begins ("Editor is finishing another conversation — will reply
here when free"), and, when the wait cap expires, rewrites that same chip
in place "so the promise never outlives the truth." Stop releases the
wait without touching the turn the busy bot is actually running.
`channel-queue.ts` holds follow-up messages typed mid-turn off the
transcript until the turn settles, "so the current responder cannot
appear to answer words it never saw."

gawkbot gap: per-slug queues handle the mechanics, but the channel shows
nothing while a tagged bot is busy elsewhere, and a human message
posted mid-turn lands on the transcript immediately even though the
running turn never saw it.

Proposal: (a) post a broker chip when a tag lands on a busy bot, and
patch it when the turn starts or the wake is dropped; (b) consider the
transcript-visibility rule for mid-turn human messages in task channels.

### 5. Bounded objective runs with a coordinator that owns completion

`group-goal-run.ts`: a goal run is capped at 13 team turns, odd by design
so the coordinator always takes the final turn "for an honest completion
decision." The coordinator must pick one of continue / completed /
needs-input / blocked, is told "Do not continue merely to generate
discussion. Do not claim completion unless the requested deliverable or
answer is present in the conversation," and treats the conversation as
the progress ledger. Harness observations (a teammate stayed busy past
the wait cap) are fed to the coordinator as data so the lead decides to
reassign or report blocked; the harness never silently kills the run.

gawkbot gap: CoS fans out work but nothing bounds an objective, and
"completed" is whatever a bot last said. The known approve-loop bug
(hires approved, CoS never creates the teammates) is precisely a missing
honest-completion check.

Proposal: adopt a bounded run primitive for objectives: turn budget per
objective, lead takes the last turn, and needs-input / blocked are
first-class terminal states that land in the human inbox instead of
silence.

### 6. Optional per-bot gate on waking peers

`peer-approval.ts`: a bot flagged `approvePeerComms` cannot contact a
peer without a human approving that specific contact via the existing
options-card flow. Notable details: approval is checked at drain time,
not queue time (the setting may change in between); an approval granted
for an ask carries over when the ask degrades into a delegation, so the
user is never asked twice for the same action; and cards always settle so
a dangling card can never wedge the composer.

Proposal: a per-bot "ask before waking teammates" toggle on expensive
or external-facing bots, reusing our approval-card machinery (and its
sanitizer pattern).

### 7. Crash-safe handoffs

Pending delegations persist to `delegations.json` (atomic write, mode
0600) and reload at boot: "a handoff queued right before a restart runs
after it." Receipts are durable with count and age pruning. Their audit
also flags string-matched control flow ("already working" matched as
text in three retry paths) as a prerequisite fix before touching gates.

gawkbot gap: per-slug turn queues live in the Launcher process; a queued
wake likely dies with a broker restart. Worth verifying and, if so,
persisting the queue.

### 8. Write the concurrency contract down

`docs/plans/2026-09-02-bot-concurrency.md` is a decision record we should
imitate in form and mostly agree with in substance: membership fans out,
execution is serialized per bot, a busy bot is woken later and never
skipped, a user's DM outranks background work, and parallel turns for one
bot are an explicit opt-in gated on listed prerequisites (per-thread
privilege keying, single-writer memory, typed error codes, stop routing
by bot and thread). gawkbot already behaves mostly this way; the value is
saying so in one place and testing the visible waiting behavior the way
their `room-chat-wait.e2e` and `group-goal-wait-cap.e2e` suites do.

## Suggested order

1. Hop cap on bot-originated tag promotion (small, structural, closes
   the loop risk). Learning 3.
2. Busy-wait chips plus wake-drop honesty in task channels. Learning 4.
3. Bounded objective runs with lead-owned completion. Learning 5. This is
   also the fix shape for the approve-loop bug.
4. Delegation receipts readable by the delegating bot. Learning 2.
5. Observability chips for cross-bot wakes in the human surface.
   Learning 1.
6. Peer-comms approval toggle, queue persistence, and the concurrency
   decision record. Learnings 6, 7, and 8.

## Video note

The current promo depicts gawkbot's real model (open assignments and
handoffs in shared task channels) and needs no correction. If we later
ship learnings 1 or 4, the film could show a "Messaged @editor" chip or a
busy-wait chip, both of which read well on camera.

## 2026-09-02 update

Main's consult relay (internal/team/broker_consult_relay.go) landed
learning 1 in parallel, with a stronger design than proposed here: relay
markers are DERIVED on read from the bot-to-bot messages themselves,
so a bot cannot fabricate a consult it never had, and clicking a
marker opens the pair thread read-only. The hardening commit that
accompanies this note adds the pieces the relay still lacked: the
server-side human write-block, the per-DM wake cap (learning 3), the
listing exclusion, and the MCP domain-suppressor fix that was stalling
live consults.
