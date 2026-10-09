# gawkbot for iOS

The office's agent inbox in your pocket. Every question from every agent in
one list, answered with a tap, a swipe, or a few typed words; then text or
talk to your agents like people, one thread per agent. The app is a thin
native client over the office broker: `/notch/state`, `/office-members`,
`/messages`, `/requests`, and the live `/events` stream.

The app only answers questions and sends messages. It never runs an action
itself: whatever an answer leads to still goes through the office's own
approval gate.

## What's in it

Three tabs: **Inbox** (first), **Agents**, **Settings**.

### Inbox

- **Questions.** Every pending question and approval from every agent,
  blocking ones first, then oldest first. Each card shows the agent's
  avatar (animated by its mood), name, a tag for where it comes from or
  where it runs (`yours`, `adopted`, `hired by CoS`, `elsewhere · Hermes
  gateway`), the question, and its options as buttons. The recommended
  option is the filled one. Options that need words (`requires_text`) open
  a reply sheet. **Swipe right** to take the recommended (or approve)
  option, **swipe left** to reply in your own words.
- **Live.** Polls `GET /notch/state` every 3 seconds while the app is in
  front, and on pull-to-refresh. Offices too old to serve `/notch/state`
  (404) get an inbox built from `/requests` and the roster instead.

The inbox holds only what is waiting on you. The agents themselves are in
the **Agents** tab.

### Agents

One row per agent, Chief of Staff first, with its last line and unread
count. Tap one to open its thread. Agents that run elsewhere (OpenClaw or
Hermes gateways, Slack, a cloud computer) are messaged exactly like local
ones.

### Talk with your voice

In an agent's thread, hold the mic beside the message box and speak; the
transcript shows as you talk. Let go and the words land in the message box,
after anything you already typed, where you can fix them. Nothing is sent
until you tap **Send** (`POST /messages` into that agent's DM). A short tap
on the mic shows a reminder to hold it.

Recognition is `SFSpeechRecognizer` fed by `AVAudioEngine`, on the phone
when the device supports on-device recognition, otherwise Apple's speech
service (the permission prompt says so). If microphone or speech permission
is refused an alert explains it and offers Settings; typing still works.

### Sounds and haptics

A different little sound per event, all synthesized at runtime from sine
and triangle tones (`CartoonSynth` in GawkbotKit); no audio files are
bundled:

| Event | Sound | Haptic |
|---|---|---|
| New question | bouncy "boing" | medium tap |
| Approval needed | two-note "doo-dee", rising | warning |
| An agent hits a snag | sagging "wah-wah" | error |
| An agent finishes | bright "ta-da" arpeggio | success |
| Your answer or message sent | soft "pop" | light tap |
| Voice start / stop | tiny blips | soft / rigid tap |

The audio session is `.ambient`, so the sounds mix with music and the
silent switch mutes them. Sounds and haptics each have a toggle in
Settings.

### Hardware keyboard (iPad, or iPhone with a keyboard)

In the Inbox:

| Key | Does |
|---|---|
| `J` / `↓` | next question |
| `K` / `↑` | previous question |
| `1`–`9` | pick that option on the selected question |
| `Return` | take the recommended option |
| `R` | reply in your own words |
| `Esc` | clear the selection |

The list is in **Settings → Keyboard shortcuts**. Only bare keys are bound, so `⌘V` (paste) and every other ⌘ shortcut is
left to the system. With nothing selected, `1`–`9`, `Return` and `R` first
select the top question rather than answering blind. The map is pure logic
in `GawkbotKit` (`InboxKeymap`) and unit-tested; the app turns each binding
into a `.keyboardShortcut`. Shortcuts pause while the reply sheet has the
keyboard.

### Look and feel

"Soft", to match the office web app's default: warm off-white (light) or
soft charcoal (dark) canvases, solid rounded cards with a hairline and a
gentle shadow, quiet neutral fills for buttons, large titles, SF Symbols.
System materials are kept for the few things that float over content (the
chat composer, sheets). Colours live in `Views/Theme.swift`
as light/dark pairs.

- **Threads** are iMessage-style: your bubbles on the right in the accent,
  the bot's on the left in a soft neutral bubble with its avatar beside the
  first bubble of each run, tails on the last.
- **Thread header**: a big avatar hero (in the bot's mood) with its name,
  what it is doing, and **Change look**.
- **Empty states** are one large avatar and one line (no questions waiting,
  no bots yet, a new thread, connecting, a failed connection).

### Avatars

Each bot is an orb: a goo body of circles filleted into one blob, a light
and a shadow tint in its own colour (OKLab), and two eyes and a mouth that
sit on the sphere inside. The geometry is `OrbAvatar` in GawkbotKit, ported
from Nex's Orb Mascot (orb-mascot core.js, MIT) and tested against its
numbers, in the office's eight bodies: bear, lemon, ghost, cloud, drop,
stack, sea cow, flower. The app's `BlobAvatarView` paints it with a Canvas
(blur then alpha threshold for the goo). The face follows the mood: narrowed
eyes (working), sleepy (idle), wide-eyed asking (needs you), a frown (hit a
snag), a grin (done). Shape ids an older office stored (block, dome, bean,
pill, loaf, shield, blob) still resolve to the orb each maps to.

- **Chosen or automatic.** A bot wears the `avatar: {shape, color}` the
  office sends on `/office-members` and `/notch/state` when one is set;
  any unset or invalid field falls back to the look derived from the slug,
  the same as the web (`BlobAvatar.resolve`, tested against the web's
  `resolveAvatar`).
- **Squishy.** Each mood has a loop with squash and stretch and a little
  overshoot: two quick hops (needs you), a squishy bob and blink (working),
  a slow breath with some jelly in it (idle), a wobbling shake (hit a snag),
  a big happy hop (done). Tap an avatar and it squashes and springs back,
  with a light haptic. Large avatars (56 pt and up) blink now and then.
  The maths is pure (`MoodMotion` in GawkbotKit) and its envelopes are
  unit-tested: bounded, continuous, back to rest. Reduce Motion keeps every
  avatar still (a tap still gives the haptic); the Haptics toggle in
  Settings covers the tap too.
- **Change look.** In a thread, **Change look** opens a sheet with a live
  preview, the eight shapes (each previewed in the colour being picked),
  the 12-colour palette, a colour picker for anything else, and **Reset to
  automatic**. Save sends `POST /office-members {action:"update", slug,
  avatar:{shape,color}}` (reset sends `avatar: {}`), then re-reads the
  roster and the inbox. A refusal from the office shows in the sheet.

## Layout

- `GawkbotKit/` — Swift package, no UIKit. Wire models (`NotchState` for
  the inbox), `BrokerClient` (REST + server-sent events), `MockBroker` (a
  canned office for previews, screenshots, and tests), `Pairing`, the
  avatar ports (`BlobAvatar` for the look, `OrbAvatar` for the geometry), the
  chosen look (`BotAvatar`, `BlobAvatar.resolve`), and the inbox's pure
  logic: `InboxKeymap`, `InboxCursor`, `InboxEvents` (which
  sound a poll deserves), `CartoonSynth`, `MoodMotion` (mood loops, tap
  squash, blink).
  Tests run on the Mac: `cd GawkbotKit && swift test`.
- `Gawkbot/` — the SwiftUI app: `OfficeStore` (the one observable, which
  also polls the inbox), the pairing screen, the tab shell, the inbox
  (`Views/Inbox/`), the conversation list and thread view, the look picker
  (`Views/AvatarPickerSheet`), the soft theme (`Views/Theme`), settings,
  `Voice/VoiceRecorder` (Speech), and `Feedback/` (sound engine + haptics).
- `project.yml` — XcodeGen spec. The `.xcodeproj` is generated, not committed.

## Build

```bash
brew install xcodegen          # once
cd apps/ios && xcodegen generate
xcodebuild -project Gawkbot.xcodeproj -scheme Gawkbot \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  build
```

Simulator builds are signed ad hoc. Do not pass `CODE_SIGNING_ALLOWED=NO`:
an unsigned app cannot use the Keychain, so the pairing token is not saved
and the app asks to pair again on every launch.

Or open `Gawkbot.xcodeproj` in Xcode and run on a simulator.

## Ship to TestFlight

```bash
scripts/testflight.sh --check                 # no Apple account needed
TEAM_ID=XXXXXXXXXX scripts/testflight.sh      # archive, sign, upload
```

`--check` archives the Release build unsigned and inspects the bundle for
what App Store Connect rejects an upload over: bundle id, version and build
number, the export-compliance answer, every usage description, the privacy
manifest, and an app icon with no alpha channel.

The real run signs automatically (Xcode makes the certificate and the App
Store profile for `bot.gawk.ios`) and uploads. It needs, once:

1. An Apple Developer Program membership, and its team ID as `TEAM_ID`.
2. An app record in App Store Connect with the bundle ID `bot.gawk.ios`.
3. Either that Apple ID signed in under Xcode > Settings > Accounts, or an
   App Store Connect API key passed as `ASC_KEY_ID`, `ASC_ISSUER_ID` and
   `ASC_KEY_PATH`.

The build number is the UTC time unless `BUILD` is set, so each upload is
higher than the last. The version is `MARKETING_VERSION` in `project.yml`.

Internal testers get a build as soon as it finishes processing. External
testers need Beta App Review first. A reviewer has no office to pair with,
so point them at **Look around a demo office** on the pairing screen: it
opens the canned office below, and nothing leaves the phone.

## Run against a canned office

Tap **Look around a demo office** on the pairing screen, or launch with the
`-mock` argument (or `GAWKBOT_MOCK=1`), to skip pairing and talk to
`MockBroker`. The inbox opens on three questions (a blocking
approval, a choice with a write-in option, and an approval from Hermes, a
gateway agent running elsewhere); the Agents tab has a roster across every mood. Replies
arrive a couple of seconds after you send or answer, typing dots first, and
the bot goes working → done (with its sound) → idle. Hermes starts with a
picked shape (blob) and its automatic colour; **Change look** works against
the mock too, with the office's validation. `scripts/screenshots.sh`
boots a simulator in this mode and captures the inbox (light and dark), the
list, and a couple of threads. Deep links: `gawkbot://inbox`,
`gawkbot://agents`, `gawkbot://settings`, `gawkbot://thread/<slug>`.

## Pair with a real office

1. Open the office web app on a machine the phone can reach (Wi‑Fi,
   Tailscale, or a share link), go to **Access & Health**, and use the
   **Pair your phone** card.
2. Scan the QR code, or type the address and token by hand.

The QR carries `gawkbot://pair?url=<broker>&token=<token>`. The token is
the office's full-access credential, stored in the Keychain. The office
must be reachable at that address from the phone; `localhost` will not be.

## What is not here yet

- Push notifications. The inbox only updates while the app is open; a
  question arriving while it is closed waits until you open it. Needs a
  small relay on the broker to send APNs pushes.
- Secret prompts. `/notch/state` hides a secret request's options and
  question; the reply sheet is a plain text field, so answer those from the
  office web app.
- iPad layout. The app is iPhone-only (`TARGETED_DEVICE_FAMILY: 1`) and runs
  on iPad in compatibility mode, where the keyboard shortcuts work; a
  split-view iPad layout is not built.
- Holding a hardware key to talk: `V` toggles instead.
- Threads inside a DM, reactions, artifacts and app cards render as text.
- Pairing over the share tunnel with a passcode instead of the raw token.
