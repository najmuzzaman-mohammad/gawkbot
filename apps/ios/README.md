# gawkbot for iOS

Text your bots like people. One thread per bot, the Chief of Staff on top,
bubbles, typing dots, and a bot's asks as cards with buttons. The app is a
thin native client over the office broker: `/members`, `/messages`,
`/requests`, and the live `/events` stream.

## Layout

- `GawkbotKit/` — Swift package, no UIKit. Wire models, `BrokerClient`
  (REST + server-sent events), `MockBroker` (a canned office for previews,
  screenshots, and tests), `Pairing`, and the blob-avatar port so a bot has
  the same mark on the phone as in the office. Tests run on the Mac:
  `cd GawkbotKit && swift test`.
- `Gawkbot/` — the SwiftUI app: `OfficeStore` (the one observable), the
  pairing screen, the conversation list, and the thread view.
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
talk to `MockBroker`. Replies arrive a couple of seconds after you send,
typing dots first. `scripts/screenshots.sh` boots a simulator in this mode
and captures the list and a thread.

## Pair with a real office

1. Open the office web app on a machine the phone can reach (Wi‑Fi,
   Tailscale, or a share link), go to **Access & Health**, and use the
   **Pair your phone** card.
2. Scan the QR code, or type the address and token by hand.

The QR carries `gawkbot://pair?url=<broker>&token=<token>`. The token is
the office's full-access credential, stored in the Keychain. The office
must be reachable at that address from the phone; `localhost` will not be.

## What is not here yet

- Push notifications (needs a small relay on the broker).
- Threads inside a DM, reactions, artifacts and app cards render as text.
- Pairing over the share tunnel with a passcode instead of the raw token.
