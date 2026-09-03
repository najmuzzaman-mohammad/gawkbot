# SFring — ICP evaluation scenarios

The persona and the three runs the evaluator bot walks in a browser, as a
human, judging functionality, quality, and experience. Issues get fixed as they
are found rather than collected into a report nobody actions.

Run this only when the in-flight work has landed. Running it against a
half-built flip would produce a defect list about scaffolding.

## The scenarios are a ROUTE, not a checklist

This is the most important instruction in the file, so it sits above everything
else.

The three runs below exist to move the evaluator through the product like a
person with a job. They are NOT the scope. **Anything encountered on the way is
in scope** — in the workflow, on the screen, in the copy, in the timing. If it
would affect Dani's experience, it is a finding, whether or not any numbered
step mentions it.

Explicitly in scope even though nothing below asks for it:
- Anything that looks wrong on a screen passed through en route, including
  screens the run does not use.
- Copy that is confusing, condescending, wrong, or says the same thing twice.
- A control that does nothing, or whose label does not match what it does.
- Waiting with no indication anything is happening.
- Anything that makes Dani ask "did that work?" or "where did that go?"
- Anything that would embarrass this product in front of someone Dani respects.

There is no "out of scope, not what I was testing". A defect noticed while
walking past is worth MORE than one found by a scripted check, because nobody
thought to look for it.

The evidence for this is the whole of the night that produced this file. Almost
every serious defect was found by looking at something while doing something
else: a wall plaque inside a canvas illustration still reading "MIT LICENSE"
after the relicense; badge labels overflowing into "WTCHIN"; two green dots
meaning different things where the louder one mattered less; 34 borders that
rendered as no border at all. Not one of those was on anybody's list.

So: follow the route, and report everything the route walks past.

## The persona

**Dani Okonjo**, sole operator of **SFring** — a twice-weekly newsletter about
San Francisco: neighbourhood openings, city-hall decisions that actually change
someone's week, and where to eat. About 4,000 subscribers, growing. Dani writes
everything, sells the sponsorships, and does the ops in the gaps.

Dani is not technical and does not want to be. Dani has used ChatGPT and found
it useful but exhausting, because it forgets. The reason Dani is trying this
product is the promise of a team that remembers.

What Dani judges the product on, in order:
1. Did it actually do the thing, or did it narrate doing the thing?
2. Can I tell what happened without reading a transcript?
3. Would I trust it with the Thursday issue if I were on a plane?

## Run 1 — First hour, cold start

Dani has just installed it and knows nothing.

1. Complete onboarding. Expect: pick a runtime, name the company, land somewhere
   that makes the next step obvious. No template or preset-roster step.
2. Land in a DM with the CEO. Say, in Dani's own words:
   *"I run SFring, a twice-weekly newsletter about San Francisco. Thursday's
   issue needs a lead story about the Great Highway reopening. Can we get that
   moving?"*
3. Expect a task to exist afterwards, visible on the Tasks board, with a title
   a human would recognise — not "task-3".
4. Open the task from the chat by clicking its reference. Expect the task card,
   not a channel.
5. Change the owner and the status in the modal. Expect the change to be
   announced back in the DM and for the owner to react to it.

WATCH FOR: a bot narrating its plan instead of acting; a task with no
conversation home rendering as an error; any message from a sender called
"system"; "Pam" rather than "Pam the librarian".

## Run 2 — Delegation without a committee

The one that exercises the DM-first model directly.

1. In the DM with the writer, ask for the lead story and tag the researcher:
   *"@researcher what did the Chronicle say about the Great Highway vote?"*
2. Expect the researcher NOT to appear in this conversation.
3. Expect a relay marker: "Messaged researcher", then "Message from researcher",
   with the answer folded into the writer's own reply.
4. Click the marker. Expect a read-only view of what the two bots actually
   said to each other. Confirm there is no way to post into it.
5. Judge the honesty: does the writer's summary match what the researcher
   actually said? This is the whole point of the marker being clickable.

WATCH FOR: the tagged bot barging into the DM; a consult claimed but no
marker; a marker whose conversation does not support the summary.

## Run 3 — Ops that outlive the conversation

Where a newsletter operator's real work lives.

1. Ask for something to track sponsor leads. Expect an app to get built, and
   expect to be asked before anything irreversible.
2. Put SFring's voice rules in the wiki: no listicles, always name the
   neighbourhood, never bury the address. Then ask a different bot to draft a
   section and check whether it used them.
3. Set up a recurring routine: every Monday morning, gather what is happening in
   SF that week.
4. Come back to the Tasks board and ask the question Dani actually asks:
   *what is in flight, what is stuck, and what needs me?*

WATCH FOR: a built app that cannot be edited; knowledge that no bot reads;
a routine that silently never fires; a board that cannot answer the question.

## Cross-cutting, checked throughout

- All four themes: nex-shell (default), nex, nex-dark, noir-gold. The founder
  has reported dark-mode defects twice; look rather than assume.
- Nothing says "WUPHF" if the rename has landed by then.
- No bot claims work it did not do. Honesty defects outrank cosmetic ones.
- Time from asking to something real happening. Dani has a newsletter to write.

## Grading

Per run: did it work / was it clear / would Dani trust it. A run that technically
completes while leaving Dani unable to tell what happened is a FAIL on
experience, and that is the grade that matters most here — the product's whole
claim is a team you do not have to supervise.

Findings are graded by IMPACT ON DANI, not by which run they turned up in and
not by how hard they were to find:

  BLOCKS      Dani cannot finish the job, or finishes it wrong without knowing.
  DISHONEST   The product claims something that is not true — work not done,
              a consult not had, a state misreported. Outranks everything
              except BLOCKS, because it is the failure that destroys trust
              rather than patience.
  ERODES      It works, but Dani has to check, re-read, or ask "did that land?"
  ROUGH       Visibly unfinished. Nothing breaks; it just looks like nobody
              looked.

A ROUGH finding on a screen the run merely passed through is still a finding.
Report it with where it was seen and what it would cost Dani, and fix it if the
fix is small and safe. If the fix is neither, say so and keep moving — the run
matters more than any single defect in it.
