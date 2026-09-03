# gawkbot bot computers

Status: S1, S2, S3 built and live-verified on 2026-09-01 (Go side, sandbox path); S4 cloud path built against a fake provider, unverified against live ascii.dev; web tab in progress. Originally a plan, 2026-09-01. Reopens the per-bot sandbox decision declined on
2026-08-31. Founder asked for: per-bot sandboxes with no subscription on the
local machine, a cloud VM option, and above all a UX where the gawker watches
bots use their computers.

Reference implementation studied: milind-soni/OpenMausBot (Apache-2.0),
`server/container-computer.ts`, `server/box.ts`, `server/vps-computer.ts`,
`server/computer-proxy.ts`, `server/computer-control.ts`.

## Decision (2026-09-01): OpenMausBot infra, Rakazo live viewer

Two open-source references were read end to end:

| | OpenMausBot (milind-soni) | Rakazo (elie222) |
|---|---|---|
| Bot process | Local `claude`/`codex` CLI on the host, computer = one MCP server | Pi bot inside the API server, computer tools are built-in Pi tools |
| Local sandbox | Docker/Podman/Apple `container` per bot, pinned `trycua/xfce-cua` base plus Cua Driver 0.20.0 | Docker per computer via a supervisor service, custom slim Debian image: Xvfb, fluxbox, Chromium, x11vnc, noVNC, Python control server, native capture lib |
| Model tools | Cua Driver, 20+ tools incl. accessibility tree, `docker exec -i … cua-driver mcp` | `computer_observe`, batched `computer_act` (xdotool, coordinates only), shell, files |
| Watching | Poll a JPEG every 6 s while a turn runs, poke after each tool call, settle the last frame into the transcript | Embedded noVNC iframe proxied by the API with a signed view/control capability URL, real live video |
| Take control | Person holds a lease, bot actions refused not queued, bot can only ask for hands | Same lease idea plus HTTP 409 while the bot holds an execution lease |
| Cloud | ascii.dev Box (persistent disk, REST commands), BYO VPS over `docker -H ssh://` | E2B, Daytona, Box, with a provider-neutral workspace checkpoint so providers can be swapped |
| Persistence | Per-bot workspace bind mount | Portable home checkpointed into DATA_DIR at run end, idle, stop |

gawkbot spawns `claude` and `codex` CLIs, so the bot must stay on the host and the
computer must be an MCP server. That rules out Rakazo's in-process tool design and makes
OpenMausBot's infra the right base: pinned Cua image, Cua Driver as the one tool surface,
hardened per-bot container, ascii.dev Box for cloud, BYO VPS free. Rakazo wins on one thing
that matters most to the founder, the feeling of watching a bot work, so its live viewer is
taken too: the broker reverse-proxies the container's noVNC on a signed, expiring,
view-or-control capability path, and the Computer tab embeds it. Screenshot pills in chat and
the settled final frame stay as in OpenMausBot, because the transcript needs still images.

Verified facts about the pinned base image (pulled locally, arm64, 1.26 GB): user `cua`
uid 1000, TigerVNC on 5901, websockify plus noVNC on 6901 over plain http, optional `VNC_PW`,
XFCE via `xstartup.sh`, supervisord as PID 1, resolution 1280x900.

## The shape in one paragraph

The bot process never moves. `claude` and `codex` keep running on the
user's machine exactly as today. A bot's "computer" is one MCP server named
`computer` that the broker mounts into that turn's `--mcp-config` (Claude) or
`mcp_servers.*` overrides (Codex). Behind that one entry sits a Linux desktop
that is one of: a local container per bot (free), a rented VM per bot (paid,
bring your own key), or a container on a Linux box the user already owns
(free, SSH only). The desktop driver is identical in all three, so the model
learns one tool surface and the UI renders one kind of frame.

## ICP tutorial examples (the spec)

1. **Sam, solo founder, 16 GB MacBook Air with OrbStack.** Asks Chief of
   Staff to "file the three invoices in my Gmail into Xero". CoS says it
   needs a computer. Sam clicks "Give Chief of Staff a computer" in the
   Computer tab. The tab shows "building the desktop image, first time only,
   about 2 minutes" with a progress line, then a live XFCE desktop. CoS opens
   Chrome, Sam sees each click land as a frame in the chat thread, Xero asks
   for a login, CoS asks for hands, Sam clicks "Take control", logs in,
   clicks "Give it back", CoS finishes. The bot's Chrome profile keeps the
   Xero login next week.

2. **Priya, ops lead, work Mac with no container runtime and no admin
   rights.** Same request. The Computer tab detects nothing installed and
   offers two paths side by side: "Install OrbStack" (opens the download)
   or "Use a cloud computer" (paste an ascii.dev Box key, $20 covers about
   555 hours). Priya pastes the key. The tab shows a 60 fps cloud desktop
   through the provider's desktop URL. Everything else looks the same as
   Sam's screen, including the frames in chat and Take control.

3. **Dev, runs gawkbot headless on a Hetzner box.** Sets the SSH alias in
   Settings, picks "Self-hosted" for the bot. The bot's container is
   created on the Hetzner box over `docker -H ssh://alias`. The web UI at
   home shows the same frames. Take control tunnels noVNC to a loopback
   port on Dev's laptop. Nothing on the Hetzner box is published.

All three must pass end to end before the website may say "every bot gets
its own computer".

## Decisions to lock (founder call, per steal-borrow-build)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Desktop driver | Cua Driver 0.20.0 (MIT) as a pinned, SHA-verified wheel inside the image, exposed via `cua-driver mcp` | 20+ tools including accessibility tree, one binary, same contract local and cloud, already proven by OpenMausBot. Anthropic's xdotool demo image is screenshot-and-click only and amd64 only. |
| D2 | Local runtime | Detect, in order: `docker` (covers OrbStack and Docker Desktop), Apple `container` (macOS 26, per-container VM, sub-second start, no Docker Desktop), `podman` | Support all by shelling to the CLI. Never bundle a runtime. If none is present, offer install or cloud. |
| D3 | Base image | `docker.io/trycua/xfce-cua` by digest, multi-arch, plus our own layer that installs the driver, supervisord entry, per-bot workspace | Port OpenMausBot's Dockerfile string with our labels. arm64 runs native on Apple silicon. |
| D4 | Cloud backend | ascii.dev Box first | Persistent disk between sessions, so bot logins survive. Cheapest at 4 vCPU/8 GB, billed per second, 60 fps desktop URL, REST command endpoint means no inbound port. OpenMausBot's `box.ts` is a 375-line reference port. Cua Cloud (Pro from $10/mo) and E2B Desktop (free 100 h/month, ephemeral by default) are viable second backends behind the same interface. |
| D5 | Self-hosted | `docker -H ssh://<alias>` with the same image | Free, SSH is the only credential, no code path unique to it beyond the transport. |
| D6 | Host control ("this Mac") | Deferred to the Wails desktop shell | macOS TCC attributes permission to the process that spawns the driver. The Go broker under npx cannot own that grant cleanly. Do not build for the npx path. |
| D7 | Limits | 2 GB RAM, 1 CPU, 512 pids, cap-drop ALL, private ipc and cgroupns, no host mounts except the bot's own workspace dir, no published ports except viewer on 127.0.0.1 ephemeral | OpenMausBot uses 4 GB. A 16 GB Mac with three bots needs the lower number. |
| D8 | Default | `computer: "sandbox"` becomes the default the moment a runtime is detected, but no container exists until a turn first needs it. Image build happens once, when the user first enables a computer, with visible progress. Idle containers sleep after 10 minutes. | Activation principle: no cost until the first real use, and the first use is visible. |

## Data model

On the bot record:

```
computer:        "off" | "sandbox" | "cloud" | "selfhosted"   (default per D8)
cloudBackend:    "box"                                        (room for "cua", "e2b")
autoStartCloud:  bool                                         (default false, external spend)
```

Broker-side, keyed by sha256 of the bot id, never by slug or display name:

```
container name   gawkbot-computer-<sha16>
workspace dir    $GAWKBOT_HOME/computers/<sha16>   (bind-mounted at /home/cua/workspace)
viewer port      127.0.0.1:<ephemeral>  →  6901 in the container
cloud box name   gb-<agentid8>-<sha6>
```

## UX, frontend first with mock data (S0)

Three surfaces, all driven by one SSE event family `computer` with
`{agentSlug, state, frame?, held?, helpReason?}`.

1. **Computer tab** in the bot subspace, next to Chat, App, Notebooks,
   Calendar, Settings. Header: state pill (`off`, `building image`,
   `starting`, `ready`, `asleep`, `bot needs hands`), destination selector,
   three buttons (`Take control` / `Give it back`, `Sleep`, `Console`).
   Body: the latest frame, scaled to fit, 1 to 2 fps while a turn is
   active and frozen at the last frame otherwise. While the user holds
   control the frame is replaced by the noVNC iframe on the loopback
   viewer port (local, self-hosted) or the provider desktop URL (cloud).
2. **Frames in chat.** Every `computer` tool call in a turn produces a
   small screen pill in the thread, using the existing bot-event pill
   component. Click expands to the full frame. A held-control interval
   renders as a system line "Sam took control for 42 s".
3. **Sidebar hands-on dot.** The bot avatar gets a small monitor glyph
   while its computer is `ready` and a turn is running.

Storybook stories for all three states, including the empty state with
"Install OrbStack" and "Use a cloud computer" side by side (Priya's path).

## Broker work

New package `internal/computer` (a distinct subsystem, not a helper).

- `runtime.go`: detect `docker`, `container`, `podman`; version floor.
- `image.go`: Dockerfile string with pinned base digest, driver wheel
  URL and SHA per arch, labels for driver version and layer version;
  `Prepare()` pulls and builds, streams progress lines to SSE.
- `target.go`: per-bot names and dirs from the sha256 of the bot id.
- `lifecycle.go`: provision, start, sleep, remove; per-target mutex; a
  lease per target claimed synchronously at turn start and touched by
  runtime events; idle timer that sleeps the container when no turn owns it.
- `verify.go`: inspect before every attach and refuse a container that
  is missing the managed label, has published ports, host mounts,
  wrong image labels, or missing hardening. Refuse, never repair.
- `screenshot.go`: JPEG frame via the driver over `exec`, cached 10 s,
  scaled to 1024 wide.
- `control.go`: one in-memory record per bot. Only the person takes or
  releases; the bot can only `computer_request_help`. While held, the
  tool proxy refuses actions rather than queueing them.
- `viewer.go`: ephemeral loopback port for noVNC with a per-boot password
  that never reaches the browser as a query string.
- `cloud/box.go`: port of `box.ts`. `selfhosted.go`: `-H ssh://` transport
  reusing `image.go` and `verify.go`.

Routes under `/api/agents/{slug}/computer`: `GET` status, `POST provision`,
`POST join`, `POST sleep`, `POST screenshot`, `POST control` with
`take` or `release`, `POST exec` for the console.

Per-turn mount in `headless_claude.go` and `headless_codex_runner.go`:
when `computer != off`, ensure the target is ready, then add

```
"computer": { "command": "docker", "args": ["exec", "-i", "<name>",
              "cua-driver", "mcp", "--socket", "/run/user/1000/gawkbot-cua.sock"] }
```

with the equivalent `-H ssh://` prefix for self-hosted and, for cloud, a
small stdio proxy that turns the REST command endpoint into the same tool
names with act-and-observe frames. Add a one-line prompt hint that the bot
has a computer and how to ask for hands. Never mount tools a runner cannot
call; Codex needs a check that MCP image blocks reach the model before it
gets the mount.

## Slices, each with unit, integration, and one real-example e2e

| Slice | Deliverable | E2E |
|---|---|---|
| S0 | Computer tab, chat pills, sidebar dot, all on mock SSE data; Storybook | Playwright walks Sam's tab through every state with mocked events |
| S1 | `internal/computer` runtime, image, target, lifecycle, verify, screenshot; routes; fake command runner in tests | Real container on the dev Mac: provision, frame, sleep, refuse a tampered container |
| S2 | Per-turn mount in the Claude runner, prompt hint, frames flow into chat, lease and idle | Sam's invoice scenario against a local container with a stub Gmail page |
| S3 | Take control, hold and refuse, help request card, viewer port | Priya-style login handoff on the local container |
| S4 | ascii.dev Box backend, self-hosted backend, settings for key and alias | Dev's Hetzner scenario over a real SSH alias; Box against the live API with a test key |
| S5 | Codex runner mount, website copy reinstated, docs | Full three-persona pass |

## Risks named up front

- **Runtime install is the activation cliff.** Most non-developer Macs
  have none. The empty state must make cloud feel first-class, not a
  fallback. Apple `container` on macOS 26 lowers the cliff but needs a
  separate install.
- **First image build is minutes.** Progress must stream, and the build
  must be shared across bots, never per bot.
- **Memory.** Three ready containers at 2 GB is 6 GB. Idle sleep is not
  optional.
- **Frames over stdout are unreliable.** OpenMausBot probed base64 over
  command stdout and saw corrupted lengths on cloud boxes. Fetch frames
  over the files or artifacts endpoint there.
- **Codex.** Unverified that Codex forwards MCP image content. Gate the
  Codex mount on that check.
- **Website truth rule.** No "sandboxed machine" copy until S2 passes on
  a fresh machine.

## Wire contract (locked 2026-09-01, both sides build against this)

All broker routes are bearer-protected and reached by the web UI through the `/api` proxy.

### Bot record

`officeMember` gains two fields, both optional on the wire:

```
computer:       "" | "off" | "sandbox" | "cloud"     "" means auto: sandbox when a runtime exists, else off
cloud_backend:  "" | "box"                           "" means box
```

Set through the existing `POST /office-members` with `{"action":"update","slug":..,"computer":"sandbox"}`.

### App config

`POST /config` accepts `box_api_key` (string, blank keeps existing). `GET /config` reports `box_key_set` (bool).

### Runtime (machine-wide, shared image)

```
GET  /computer/runtime
  -> { available, runtime: "docker"|"podman"|"container"|"", daemon_up, image, image_ref,
       driver_version, building, install_hint, runtime_start_hint, problem }
POST /computer/runtime/prepare   body {}   -> 202 { building: true }   (progress arrives as SSE)
```

### Per-bot computer

```
GET  /computer/{slug}
  -> ComputerStatus {
       slug, destination: "off"|"sandbox"|"cloud", cloud_backend: "box",
       state: "off"|"unconfigured"|"runtime_missing"|"image_missing"|"building"|"missing"
             |"provisioning"|"starting"|"waking"|"ready"|"asleep"|"error",
       problem: string|null, busy: bool,
       viewer_url: string|null,          // iframe src for the live desktop, view policy, expires
       control: { held: bool, help_reason: string|null },
       last_frame: { data_url: string, at: number }|null,
       container_name: string|null, workspace_dir: string|null,
       box: { box_id: string, state: string }|null
     }
POST /computer/{slug}/provision    -> ComputerStatus   (create or wake; builds nothing, needs image)
POST /computer/{slug}/start        -> ComputerStatus
POST /computer/{slug}/sleep        -> ComputerStatus
POST /computer/{slug}/remove       -> ComputerStatus   (sandbox only; box has no remove)
POST /computer/{slug}/screenshot   -> { image: data_url }
POST /computer/{slug}/exec  {command} -> { exit_code, stdout, stderr }
POST /computer/{slug}/join         -> { viewer_url }   // control policy, takes the hold first
POST /computer/{slug}/control {action: "take"|"release"|"dismiss-help"} -> { held, help_reason }
```

Every mutation requires `content-type: application/json`.

### SSE (`/events`, event name `computer`)

```
{ slug: string,                 // "" for machine-wide runtime events (image build progress)
  state: string,                // same vocabulary as ComputerStatus.state
  problem?: string,
  message?: string,             // build progress line
  frame?: string,               // data URL, JPEG or PNG, present on live frames
  at?: number,
  held?: bool, help_reason?: string|null }
```

### Bot stream lines (per-bot `/agent-stream/{slug}`)

Turn end appends one settled frame when the turn touched the screen:

```
{ "kind": "computer_frame", "slug": "...", "data_url": "data:image/jpeg;base64,...", "at": 1725..., "final": true }
```

Tool calls to the computer arrive as ordinary `headless_event` tool_use / tool_result lines with
`tool_name` starting `mcp__computer__`. The UI shows the latest live frame as a thumbnail on those cards.

### Viewer

`viewer_url` is served on the web-UI port (no bearer, like `/artist-files/`) at
`/computer-view/{slug}/{policy}/{expires}.{signature}/vnc.html?...` and reverse-proxied to the
container's noVNC on loopback, websocket included. `policy` is `view` or `control`; the signature
is an HMAC over slug, policy, expiry with a per-boot secret; TTL one hour. The VNC password rides
in the URL fragment only.
