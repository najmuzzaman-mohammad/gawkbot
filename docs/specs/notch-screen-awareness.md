# The notch knows what is in front of you

What the notch reads from the screen, when, and what it does with it.
Code: `internal/hostcomputer/screen.go`, `internal/team/broker_host_computer.go`,
`internal/team/broker_notch_hint.go`, `internal/team/notch_app_hints.go`,
`web/src/notch/NotchHint.tsx`.

## What is read, and when

While the notch is open it polls with `open=1`, and only then the office
reads, once a second, the app in front, its window title, and, in a
browser, the page's domain. The polls stop when the notch closes and the
reading stops with them. Nothing is written to disk or to any log; the
"Seeing Chrome" line under the headline is the whole of what is kept, and
it lives only in the reply. A joined human never sees the owner's screen.

Reading a browser's address bar needs Accessibility. Without it the notch
knows the app and the window title and nothing more.

## The integration hint

When the app or page in front belongs to an integration the office does not
have, the notch says one line under the headline, with the integration's
mark: "Connect Gmail so your bots can read this inbox", then Connect and
Not now. It is a hint, not a card: nothing waits on it, the keyboard model
ignores it, and it never opens the notch by itself.

The rules, in order:

- The same platform has to stay in front for 20 seconds. A tab passed
  through is not a place.
- A connected platform is never hinted, and neither is one with a Connect
  card already waiting on you: the card is louder, and enough.
- Three platforms a day, each once a day. "Seen" is counted when the line
  is on screen (`POST /notch/hint/seen`).
- Not now hides it for the day; a second Not now ends that platform's
  hints for good (`POST /notch/hint/dismiss`). Saved to `notch-hints.json`
  beside the broker state.

Which pages map to which platform is a fixed table of first-party domains
and Mac apps (`notch_app_hints.go`); a browser's own bundle id never maps,
the page it shows does, and a test keeps the table inside the curated
catalog.

Connect starts the connection and opens the sign-in page in the default
browser (the Mac app opens it; https only), then watches for it to land.
When the office is not signed in to integrations yet, or the platform wants
typed credentials, the notch opens the full view at Integrations, where
both live.
