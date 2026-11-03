# WUPHF desktop shell (Wails)

A single Go binary that boots the **existing** WUPHF broker + web UI
**in-process** (no sidecar) and attaches a native [Wails](https://wails.io) v2
window to it. The desktop app *is* the `wuphf` process with a window bolted on.

## Why Wails (and not Tauri/Electron/Pake)

`team.Launcher.LaunchWeb(port)` is non-blocking and returns a live loopback URL,
so a Go host can start the broker in-process and attach a window — deleting the
entire sidecar lifecycle (spawn / port-handshake / crash-restart / orphan-kill)
that a Rust (Tauri) or Node (Electron) host would have to build. Full rationale
and the cross-platform de-risk live in
[`docs/specs/desktop-pake-feasibility.md`](../../docs/specs/desktop-pake-feasibility.md).

## OS boundary

This is the **only** Go package allowed to import
`github.com/wailsapp/wails/v2/...` (enforced by depguard + `scripts/check-wails-boundary.sh`).
All app data stays on the existing HTTP/SSE/WebSocket loopback transport
(`internal/team/broker_web_proxy.go`). Wails is reserved for OS verbs only:
native notifications, tray, dock badge, deep-link, autostart, file pickers, and
the single-instance lock.

## How it works

1. `init()` calls `runtime.LockOSThread()` — Cocoa needs the run loop on the
   main thread; the broker boot (below) spawns goroutines that would otherwise
   migrate the main goroutine off it and the window would never appear.
2. `main()` picks a free loopback port and an OS app-data runtime home, then
   boots the broker in a goroutine: `NewLauncher("") → SetNoOpen(true) →
   PreflightWeb() → LaunchWeb(port)`.
3. The Wails window loads an embedded bootstrap page. `bootstrap.go`'s
   asset-server middleware templates the live port into it; the page polls the
   loopback origin and `location.replace`s to `http://127.0.0.1:<port>/` once
   the broker answers. Landing on a real http origin gives the SPA native
   SSE / WebSocket / WebAuthn — the `wails://` custom scheme cannot carry a
   WebSocket.

## The Chief of Staff in the camera notch (macOS)

The app also floats a second, native surface over the MacBook camera notch:
no desktop widget, nothing in the Dock. `notch_darwin.m` is plain Cocoa
because Wails v2 is single-window: a borderless, transparent,
non-activating `NSPanel` at status-bar level on every Space, hosting a
`WKWebView` of `<office>/notch.html` (`web/notch.html`, `web/src/notch/`).

- **Collapsed**: exactly the notch's height, one "ear" wider on each side.
  The left ear is the Chief of Staff acting out the office's mood; the right
  ear shows the agents that most need looking at plus a count of things
  waiting on you. The gawkbots are their orbs (Nex's mascots), animated
  per mood: working, idle, needs you, error, done.
- **Hover**: a Force Touch trackpad tap (`NSHapticFeedbackManager`) and a
  short list drops out of the notch (`web/src/notch/home/NotchPeek.tsx`):
  one "Suggestions" row for the office's ideas, the bots most worth a look
  (face, name, time, last line, a dot when something is new), and one
  "Sessions" row for the terminal sessions on this Mac. Clicking a row opens
  Home on it.
- **Home**: ⌥Space, a row, or a card at the top right opens Home, two panes
  and resizable (default 760x500, remembered): a sidebar with search, a new
  bot, the Suggestions group, every bot, the Sessions group and settings,
  and beside it the picked pane: the suggestions carousel, a bot's chat (its
  open question inside it, what it is doing, the box with its face on the
  microphone), the sessions, a new bot, or settings with its own nav.
- **Nothing pops out by itself**: a new question makes a sound and its
  bot's card appears at the top right; the notch never opens on its own,
  and a terminal session finishing is a dot on its row, never a card, a
  sound, or a line spoken out loud.
- **No notch**: the same strip renders as a pill at the top centre of the
  screen.
- **Full view and back**: the panel's "Full view" button (or O) opens the
  main window at the selected conversation. Closing that window hides it
  (`HideWindowOnClose`, macOS only) instead of quitting, so you are back to
  just the notch. The Dock icon follows: shown while the full view is open
  or minimised, gone when only the notch is left.
- **Sounds**: Saturday-morning foley, one cue per moment: a slide whistle
  and a spring for a question, a counter bell for an approval, the muted sad
  trombone for an error, a xylophone run and a cymbal for a finish, a bubble
  pop for a sent reply. All synthesized live with Web Audio (`web/src/notch/sounds.ts`).
- **Antics**: when several need you they pile onto the strip, and get
  restless if you leave them waiting (`web/src/notch/antics.ts`). Nothing
  hangs below the strip: what a bot has to say goes to its card at the top
  right, where the whole line fits.
- **Keyboard**: ⌥Space opens the notch from anywhere, or ⌃⌥Space when
  another app owns ⌥Space (Carbon `RegisterEventHotKey`, so no Accessibility
  permission is needed). The page is told which one it got (`hk` in the
  page URL). ↑/↓ move through the replies on offer, ↵ sends, 1–9 pick on
  the open question, J/K move between the bots waiting on you, R replies, M
  messages the Chief of Staff, hold V to talk, Esc closes. The
  panel becomes key while open but is non-activating, so the app you were in
  stays active.
- **Voice**: hold V (or the mic button) to talk. `SFSpeechRecognizer` turns
  speech into text, on-device when the Mac supports it. The transcript lands
  in the reply box and nothing is sent until you press ↵. This needs macOS
  10.15+, the `audio-input` entitlement, and the microphone and speech
  usage strings in `build/darwin/Info.plist`.

- **Your Mac as a computer**: the app bundles the open-source Cua Driver
  (`Contents/Helpers/cua-driver`, pinned in `internal/hostcomputer/version.go`,
  put there by `scripts/fetch-cua-driver-host.sh` after `wails build`) and
  starts it in its embedded mode from `host_computer_darwin.go`. Spawned by
  the app itself, the daemon inherits the Accessibility and Screen Recording
  grants macOS gives gawkbot and never prompts on its own; the prompts are
  the app's (`GawkRequestAccessibility`, `GawkRequestScreenCapture` in
  `notch_darwin.m`) and the notch asks for them only when you first use a
  feature that needs one. With the daemon up, the owner's notch state
  carries `permissions`, `capabilities`, and, only while the notch is open,
  `screen` (the app and window in front of you, read a second at a time and
  never stored). Attached to an office served by the CLI (`npx gawkbot` in a
  terminal), the app still spawns the driver, since the grants are the app's,
  and registers its socket with the running office (`POST
  /host-computer/attach`); the broker then reaches the daemon through the
  driver's own proxy and asks Launch Services which app is in front, and the
  notch asks the app itself for permissions through the `permission` bridge
  message. Developers without a packaged build point `WUPHF_CUA_DRIVER` at a
  driver binary.

- **Drawing on the screen**: `overlay_darwin.m` keeps one transparent,
  click-through window per display above menus and popups and paints a
  scene (pointers, labels, arrows, circles, boxes, in global screen points,
  fading after its time; still under reduced motion). Scenes are computed
  by the office (`POST /notch/overlay`, `POST /notch/point`, which finds a
  control by a few words in the window in front through the driver's
  accessibility read and glides the guide cursor to it) and reach the app
  through the notch page: in the reply, and as `overlay` on the notch state
  with a sequence the page draws once. A harness for the native part lives
  outside the repo (`clang ... -DGAWK_OVERLAY_TRACE overlay_darwin.m`).

- **Bots on this Mac**: a bot set to run on "This Mac" gets the embedded
  driver as its `computer` tools, with its own named, coloured cursor,
  acting in the foreground; the notch asks before its first action each
  turn, and ⌥Esc (or ⌃⌥Esc) stops every agent. See
  `docs/specs/mac-cursor-agents.md`.

Data is one poll of `GET /notch/state` (`internal/team/broker_notch.go`).
The page↔native contract is in `web/src/notch/bridge.ts`. The panel refuses
navigation off the office origin, and "open in app" accepts only in-app paths
(`notch_path.go`). Geometry comes from `NSScreen.safeAreaInsets` and the
auxiliary top areas (macOS 12+). Off macOS, `startNotch` is a no-op.

## Build

The shell is behind the `desktop` build tag so `go build ./...` / CI don't pull
in the Wails CGO webview deps (a non-tagged `stub.go` keeps the package valid).

```bash
# macOS / Windows
cd desktop/oswails && wails build -s -skipbindings -tags desktop

# Linux (Ubuntu 24.04 ships WebKitGTK 4.1; the production tag is what wails
# build injects — a plain `go build` without it makes Wails refuse to run)
cd desktop/oswails && wails build -s -skipbindings -tags "desktop webkit2_41"
```

`wails build` produces a GUI-subsystem binary (no console window). A plain
`GOOS=windows go build` would need `-ldflags -H=windowsgui`.

## Single-instance & attach

`SingleInstanceLock` ensures one desktop instance per machine — a second launch
focuses the running window instead of spawning a competing process.

**Shared office, one broker per workspace.** The shell opens the user's active
workspace (the same office an unqualified `wuphf web` uses). Before booting it
calls `team.RunningOfficeURL()`, which reads the `office.json` sidecar (written
next to `office.pid` with the running broker's web URL) and, if a loopback,
WUPHF-identity-verified peer is live, **attaches** the window to it instead of
booting a second broker. The CLI's `wuphf web` does the same — opens the running
office and exits rather than `killStaleBroker`-ing a peer. Clean shutdown clears
the sidecar; a stale one self-heals via the reachability probe. This makes one
broker per workspace the invariant, so the broker port is no longer a concern.

## Known follow-ups

- **Desktop+CLI simultaneous cold-start** has no lock between the attach-check
  and boot, so two front-ends starting within ~ms could both boot
  (`SingleInstanceLock` only covers desktop↔desktop). An advisory boot lock is
  the fix.
- **Identity probe** confirms a WUPHF office via a marker in the served `/`; a
  dedicated broker endpoint on the web port would be more robust.
- **Multi-workspace:** the desktop opens the default `~` office, not
  `cli_current`.
- **Cross-platform:** macOS + Linux WebKitGTK validated by hand; Windows
  WebView2 via `.github/workflows/desktop-webview-probe.yml`.
