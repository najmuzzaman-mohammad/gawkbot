# gawkbot for iOS

The office's agent inbox in your pocket. Every question from every agent in
one list, answered with a tap, a swipe, a few typed words, or your voice;
then text your bots like people, one thread per bot. The app is a thin
native client over the office broker: `/notch/state`, `/office-members`,
`/messages`, `/requests`, and the live `/events` stream.

The app only answers questions and sends messages. It never runs an action
itself: whatever an answer leads to still goes through the office's own
approval gate.

## What's in it

Three tabs: **Inbox** (first), **Chats**, **Settings**.

### Inbox

- **Questions.** Every pending question and approval from every agent,
  blocking ones first, then oldest first. Each card shows the agent's
  avatar (animated by its mood), name, a tag for where it comes from or
  where it runs (`yours`, `adopted`, `hired by CoS`, `elsewhere · Hermes
  gateway`), the question, and its options as buttons. The recommended
  option is the filled one. Options that need words (`requires_text`) open
  a reply sheet. **Swipe right** to take the recommended (or approve)
  option, **swipe left** to reply in your own words.
- **Agents.** The roster under the questions: mood (needs you, working,
  idle, hit a snag, done), what each is doing, and its tags. Agents that run
  elsewhere (OpenClaw or Hermes gateways, Slack, a cloud computer) are
  answered and messaged exactly like local ones. Tap an agent to talk to
  it; swipe or long-press to open its chat.
- **Live.** Polls `GET /notch/state` every 3 seconds while the app is in
  front, and on pull-to-refresh. Offices too old to serve `/notch/state`
  (404) get an inbox built from `/requests` and the roster instead.

### Talk with your voice

Hold the mic in the bar under the inbox and speak; the transcript shows as
you talk. Let go and you get **Send** or **Cancel** (and can fix the text):
nothing is ever sent on its own. The **To** menu picks where it goes:

- **Answer** the selected question (`POST /requests/answer {id, custom_text}`),
- **Message** the selected agent, or
- **Message** the Chief of Staff (`POST /messages` into `lead_dm`).

Recognition is `SFSpeechRecognizer` fed by `AVAudioEngine`, on the phone
when the device supports on-device recognition, otherwise Apple's speech
service (the permission prompt says so). If microphone or speech permission
is refused the bar explains it and offers Settings; typing still works.

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
Settings, which also plays every sound for you to hear.

### Hardware keyboard (iPad, or iPhone with a keyboard)

In the Inbox:

| Key | Does |
|---|---|
| `J` / `↓` | next question |
| `K` / `↑` | previous question |
| `1`–`9` | pick that option on the selected question |
| `Return` | take the recommended option |
| `R` | reply in your own words |
| `V` | start talking; `V` again stops (a key has no "hold") |
| `Esc` | cancel talking, or clear the selection |

Only bare keys are bound, so `⌘V` (paste) and every other ⌘ shortcut is
left to the system. With nothing selected, `1`–`9`, `Return` and `R` first
select the top question rather than answering blind. The map is pure logic
in `GawkbotKit` (`InboxKeymap`) and unit-tested; the app turns each binding
into a `.keyboardShortcut`. Shortcuts pause while the reply sheet or the
voice confirmation has the keyboard.

### Look and feel

System materials over a soft colour wash, large titles, SF Symbols, spring
animations, light and dark mode. Avatars are smooth vector marks: the same
per-slug silhouette and colour as the office web app (a port of
`web/src/lib/blobAvatarSmooth.ts`, tested against it), each with a small
mood animation (bounce, bob, breathe, shake, hop) that Reduce Motion turns
off.

## Layout

- `GawkbotKit/` — Swift package, no UIKit. Wire models (`NotchState` for
  the inbox), `BrokerClient` (REST + server-sent events), `MockBroker` (a
  canned office for previews, screenshots, and tests), `Pairing`, the
  blob-avatar ports (pixel `BlobAvatar` and vector `SmoothBlob`), and the
  inbox's pure logic: `InboxKeymap`, `InboxCursor`, `VoiceTarget`,
  `InboxEvents` (which sound a poll deserves), `CartoonSynth`, `MoodMotion`.
  Tests run on the Mac: `cd GawkbotKit && swift test`.
- `Gawkbot/` — the SwiftUI app: `OfficeStore` (the one observable, which
  also polls the inbox), the pairing screen, the tab shell, the inbox
  (`Views/Inbox/`), the conversation list and thread view, settings,
  `Voice/VoiceRecorder` (Speech), and `Feedback/` (sound engine + haptics).
- `project.yml` — XcodeGen spec. The `.xcodeproj` is generated, not committed.

## Build

```bash
brew install xcodegen          # once
cd apps/ios && xcodegen generate
xcodebuild -project Gawkbot.xcodeproj -scheme Gawkbot \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  build CODE_SIGNING_ALLOWED=NO
```

Or open `Gawkbot.xcodeproj` in Xcode and run on a simulator.

## Run against a canned office

Launch with the `-mock` argument (or `GAWKBOT_MOCK=1`) to skip pairing and
talk to `MockBroker`. The inbox opens on three questions (a blocking
approval, a choice with a write-in option, and an approval from Hermes, a
gateway agent running elsewhere) and a roster across every mood. Replies
arrive a couple of seconds after you send or answer, typing dots first, and
the bot goes working → done (with its sound) → idle. `scripts/screenshots.sh`
boots a simulator in this mode and captures the inbox (light and dark), the
list, and a couple of threads. Deep links: `gawkbot://inbox`,
`gawkbot://chats`, `gawkbot://thread/<slug>`.

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
