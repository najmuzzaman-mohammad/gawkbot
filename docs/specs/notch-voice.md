# Talking to the office, and it talking back

What the talk key does in the notch, in both of its forms, and what the
office says on its own. Code: `web/src/notch/realtime/`,
`web/src/notch/announce.ts`, `internal/team/broker_realtime.go`,
`internal/team/broker_realtime_notch.go`, `desktop/oswails/notch_darwin.m`.

## The talk key

Hold V (⌥V inside a reply box), or the microphone in a reply box.

- **With a reply box open** the key dictates into the box, on device
  (`SFSpeechRecognizer` in the Mac app, the Web Speech API elsewhere).
  Nothing is sent until ↵. This never needs a key.
- **With no reply box open**, and an OpenAI key configured
  (`GET /realtime/status` says `configured`), the key is a conversation
  with the office: hold to talk, let go, and the office answers out loud.
  Without a key it dictates as before, after opening the reply box.

## The conversation

The broker mints a short-lived Realtime key (`POST /realtime/session`)
with the whole session set, so the page never edits it and never sees the
real key: who the lead is, the routing rule, the tools, hold-to-talk (no
server turn detection; the page commits the audio when the key comes up),
input transcription (so the notch can show what was heard), and the voice
(`realtime_voice`, default marin; `realtime_model`, default
gpt-realtime-2.1). The page does the WebRTC handshake with the ephemeral
key, keeps the microphone track off except while the key is down, plays
the answer, and shows one line under the headline: Listening, Thinking,
Speaking, then what was heard and what was said. Pressing the key over an
answer cuts it off. Esc ends the session; a quiet session closes itself
after 90 seconds.

When the Mac app holds Screen Recording, letting go of the key also
sends one picture of the screen with the words (`POST
/notch/screen/capture`, as an `input_image` item), so "what is this PR
waiting on?" has the page to look at. It is taken only at key-up, never
on a timer, and never kept; if it takes longer than a moment, the answer
goes without it.

The voice is the notch, not a bot. It answers office questions itself,
answers a card when told the choice, and passes work to the lead:

| Tool | What it does |
|---|---|
| `get_office_state` | the headline, each bot's mood and detail, the cards with ids and options |
| `ask_agent` | a message into a bot's direct message; the lead when no slug |
| `answer_card` | answers a card by option id or in words |
| `stop` | stops one bot (`POST /notch/stop`) or everyone (the governor) |

Each runs in the page against the office exactly as a click would.

The microphone belongs to the page, so the Mac app grants the office's
own origin the microphone through `WKUIDelegate` (no second dialog; macOS
asked once, for the app) and refuses every other origin and the camera.
Opened from a terminal, macOS attributes the prompt to the terminal and
the grant is refused, as with dictation.

## Speaking up on its own

When a new card needs you, and when a turn finishes, the notch says one
line in the Mac's own voice (`AVSpeechSynthesizer`, no key, no
permission): "Ops needs you: move the screenshots?", "Ops is done: moved
14 screenshots into Shots." Each card is said once; the backlog on the
first look is not news; nothing is said while the talk key is down, and
what arrived meanwhile is on screen, not repeated. One switch in
Settings, Notch ("Speaking up"), on unless chosen off, read on every poll.

In an open thread the bot talks back the same way: each new line it
writes is read out loud as it lands (`useThreadVoice`). The lines already
there when the thread opens stay quiet, and so does everything while the
talk key is down or the switch is off.

## Not yet

Pointing while it speaks, hands-free mode with semantic turn detection,
and a speed picker.
