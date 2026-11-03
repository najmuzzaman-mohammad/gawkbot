# Daily ideas: bots worth having

Once a day the office looks across the integrations you connected and
proposes a few bots worth having. They wait in one "Suggestions" row at
the top of the notch's sidebar and its hover list, never as notifications:
the row shows how many and the first promise. Opening it shows "Suggested
for you", one card at a time: a character, a name, the integration it
would work through, a promise in its own words that cites what it saw, why
now, how often, and "Want to bring me on as your release checker?". No
sends an idea away; "Yes, make it and go" creates the bot and starts it.
Nothing is created without that click. The morning's look is said out loud
once ("3 ideas for new bots, when you're ready"); the notch never opens by
itself for it.

Code: `internal/team/broker_notch_ideas.go` (cards, store, vetting),
`broker_notch_ideas_scan.go` (the look), `broker_notch_ideas_accept.go`
(the yes), `web/src/notch/NotchIdeas.tsx`.

## What it reads, and what it never does

- Only integrations you connected, and only through actions that are
  read-only by name; the scan refuses anything else before it runs.
- A couple of reads per integration, cut down to the lines a person would
  see in a list: titles, subjects, names, numbers. Bodies, addresses, and
  contents stay out, and what it saw is shown on the card ("Show what it
  saw") and written into the new bot's OPERATIONS file so you can check.
- Counts are logged, contents never. Nothing on the screen is used.
- It never writes to an integration and never creates a bot by itself.

## When

Every day at the hour you chose (Settings, Suggestions; 9 by default), while
this Mac is awake; caught up after sleep, never twice in a day. "Look now"
by hand is allowed once an hour. The look runs under the `notch-ideas`
system cron, so it appears in Scheduled Tasks like any other, and one
switch turns it off.

## How a card is made

The reads become a short list with ids. One bounded call on the lead's
runtime drafts up to five ideas as JSON and nothing else: it cannot call
tools. Every draft is then checked here before it becomes a card: the
integration is one you connected, every cited id is one the scan produced
(from that integration), the cadence parses and is no more often than
hourly, the bot's name is free, and nothing runs past the card's size.
A draft that fails any of these is dropped, with the reason logged.

An idea is named by what it is for (`fingerprint`), not how it was worded:
the same idea proposed again is the same card. At most five new ideas per
look, five visible a day. No rests the idea for two weeks; a second No
ends it. An accepted idea is remembered so it is never proposed again.

## Yes, make it and go

Accepting creates a real office member on the office's default runtime,
writes its OPERATIONS file (the standing rules, then the promise, the
reason, the cadence, and the source details), registers its routine when
the idea has a cadence (the bot's direct message, the promise as the
prompt), and posts its first task into that direct message exactly as a
due routine would. The card then says the bot is on it, with Open.

Routes, owner only: `POST /notch/ideas/{seen,dismiss,accept,scan}`.
Saved beside the broker state in `notch-ideas.json`.
