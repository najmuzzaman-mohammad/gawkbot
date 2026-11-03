# Text Your Bots From an iPhone

The gawkbot iOS app (`apps/ios`) is a Messages-style client for the office:
one thread per bot, the Chief of Staff on top, bubbles, typing dots, and a
bot's asks as cards with buttons. It talks to the same broker the web app
uses. These three scenarios are the spec the app is tested against.

## 1. Sam pairs the phone

Sam runs the office on a Mac mini and uses it from a laptop over Tailscale.

1. On the laptop, Sam opens the office by its Tailscale address
   (`http://100.64.0.5:7891`, not `localhost`), then **Access & Health**.
2. The **Pair your phone** card shows a QR code. It encodes
   `gawkbot://pair?url=http://100.64.0.5:7890&token=…`, the broker address
   the phone can reach plus the office token.
3. In the app, Sam taps **Scan pairing code** and points the camera at the
   laptop. The token is stored in the Keychain.
4. The conversation list appears: **Chief of Staff** first, then the rest
   of the roster, each with its last line and time, and a dot for unread.

If the page was opened on `localhost`, the card says so and the code will
only work from that machine; Sam reopens the office by its Tailscale
address and scans again. Without a camera, the address and token can be
typed by hand.

## 2. Sam texts the Chief of Staff from the train

1. Sam opens the Chief of Staff thread and types
   *"Draft the sponsor follow-up for Thursday and hand the hero to the
   Designer."*
2. The message shows as a blue bubble on the right with a light haptic.
3. Within a few seconds the avatar in the header blinks and three dots
   appear in a gray bubble: the Chief of Staff is typing.
4. The reply lands as a gray bubble on the left. A task card the office
   posted shows as a centered system line.
5. Back on the list, the Designer row now reads *"Designer is typing…"*
   in italics, and later shows an unread dot with its last line.

## 3. Sam approves from the couch

1. The Designer needs a go-ahead. Its thread shows a card: *"Designer
   asks — Start work on Thursday landing page?"* with **Approve** and
   **Reject** buttons. On the list, the row shows an orange question mark
   and *"Needs your call: …"*.
2. Sam taps **Approve**. The card disappears, a system line confirms the
   answer, and the Designer starts typing.
3. Options that need a note (*Reject with steer*) open a short sheet for
   the text before sending.

## Running the app against a canned office

Launch with the `-mock` argument (or `GAWKBOT_MOCK=1`) to skip pairing and
talk to a built-in office with the newsroom roster; replies arrive a couple
of seconds after you send. `apps/ios/scripts/screenshots.sh` boots a
simulator this way and captures the list and two threads.

## Not in this version

Push notifications, threads inside a DM, reactions, rich artifact and app
cards (they render as text), and pairing over the share tunnel with a
passcode instead of the raw token.
