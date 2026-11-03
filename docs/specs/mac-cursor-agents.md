# Bots on the person's own Mac

Status: shipped in slices from 2026-10-15. This is the contract; the
reference for the mechanics is the code it names.

## What it is

A bot whose computer is set to **This Mac** (`officeMember.Computer =
"mac"`) works on the person's own screen through its own virtual cursor: the
person watches it work, and it never moves their pointer or takes their
focus, so they keep using the Mac and several bots can work at once. It is
the visible, trust-first alternative to the container and cloud desktops.

## Who runs what

- The gawkbot Mac app spawns the open-source Cua Driver in its embedded
  mode (`internal/hostcomputer`, `desktop/oswails/host_computer_darwin.go`).
  macOS ties Accessibility and Screen Recording to the app that spawns the
  driver, so the daemon is always the app's child, whether the app owns the
  office or attached to one the CLI serves (`POST /host-computer/attach`).
- The driver never prompts for permissions; the app does, when the notch
  asks (`permission` bridge message). Nothing acts until both grants exist.
- A bot's turn gets the driver as the MCP server `computer`, through
  `gawkbot computer-mcp --host <socket> <slug>` (`internal/computer/host.go`).

## What a bot may do

Only the tools in `internal/hostcomputer/policy.go` reach the driver:
reads of apps, windows and trees; the acting tools (click, type, keys,
scroll, drag, set_value, menus, launch, window frames, batched steps); and
the bot's own cursor. The clipboard, the browser's logged-in profile,
recordings and the driver's configuration are refused on the near side.

Every call carries the bot's session, so the driver draws a cursor in the
bot's colour with its name. Acting calls are always delivered in the
background (`delivery_mode: background`, forced by the bridge): input goes
straight to the app, and the real pointer and keyboard focus stay the
person's. A bot cannot ask for the foreground.

## Consent

Before a bot's first action of a turn, the person is asked in the notch:
a Needs-you card, "Allow this turn" (recommended) / "Always allow" / "No".
The bridge waits up to two minutes; no, or silence, refuses every action of
that turn. "Always allow" flips the one switch (`mac_computer_always_allow`,
Settings, Notch), after which turns do not ask. The card answers through
`POST /computer/{slug}/control`, never `/requests/answer`.

## Stopping

⌥Esc (or ⌃⌥Esc when another app owns ⌥Esc) stops every agent now, through
the governor's stop. A stopped turn closes its bridge, and the bridge ends
the bot's driver session on the way out, so its cursor leaves the screen.

Each bot at work also has a card at the top right of the screen, with its
face, what it is doing, and History, Open, and Stop. The cards are the
notch page again (`notch.html?dock=1`, `web/src/notch/NotchDock.tsx`) in a
second small panel the Mac app floats (`desktop/oswails/dock_darwin.m`).
Stop there is `POST /notch/stop {slug}`: it ends that one bot's turns and
leaves the office running, unlike ⌥Esc. The cards step aside while the
notch is open, and the notch's one "jump out" switch hides them too.

## Not yet

Pointing while the lead speaks (voice), walkthroughs with click detection,
and a per-bot "always allow".
