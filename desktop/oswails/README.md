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
  waiting on you. The gawkbots are the brand mark's hollow eyes, animated
  per mood: working, idle, needs you, error, done.
- **Hover**: a Force Touch trackpad tap (`NSHapticFeedbackManager`) and the
  strip drops into a panel: what needs you (one-tap answers through
  `/requests/answer`), every agent with who made it and where it runs, and a
  box that messages the Chief of Staff's DM through `/messages`.
- **Peek**: when something new needs you, the notch taps and opens for four
  seconds on its own. That is the notification.
- **No notch**: the same strip renders as a pill at the top centre of the
  screen.
- **Sounds**: a different cartoon sound per moment (a question, an approval,
  an error, a finish, a sent reply, a peek, bored chatter), synthesized live
  with Web Audio (`web/src/notch/sounds.ts`), with a mute toggle in the panel.
- **Antics**: now and then an agent peeks out from under the notch for no
  reason. When several need you they pile onto the notch, and if you leave
  them waiting they start talking to each other below it
  (`web/src/notch/antics.ts`). The collapsed panel grows a transparent
  "stage" below the strip for this; only the strip itself reacts to hover.
- **Keyboard**: ⌃⌥Space opens the notch from anywhere (Carbon
  `RegisterEventHotKey`, so no Accessibility permission is needed).
  J/K move between questions, 1–9 answer, ↵ takes the recommended answer,
  R replies, M messages the Chief of Staff, hold V to talk, Esc closes. The
  panel becomes key while open but is non-activating, so the app you were in
  stays active.
- **Voice**: hold V (or the mic button) to talk. `SFSpeechRecognizer` turns
  speech into text, on-device when the Mac supports it. The transcript lands
  in the reply box and nothing is sent until you press ↵. This needs macOS
  10.15+, the `audio-input` entitlement, and the microphone and speech
  usage strings in `build/darwin/Info.plist`.

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
