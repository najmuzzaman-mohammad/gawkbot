// nudge.ts — how often the notch may come out at you.
//
// Agents nudging is the point of the notch, and too much of it is the
// fastest way to get it switched off. So every way an agent can come out
// on its own (the peek that opens the notch for a new question, the flight
// into the ear, a random peek, bored chatter under the notch) is rationed
// to one every five minutes. Anything that arrives in between still
// updates the count on the notch, silently. Playing never spends a real
// question's turn; a real question does quiet the playing.

/** At most one nudge in this long. */
export const NUDGE_EVERY_MS = 5 * 60_000;

/**
 * One nudge can be several things at once (the sound, the peek and the
 * flight for the same new question), so claims this close together count
 * as the same nudge.
 */
export const SAME_NUDGE_MS = 2_000;

/** What is asking to come out: a real question, or an agent just playing. */
export type NudgeKind = "ask" | "play";

let lastAsk = Number.NEGATIVE_INFINITY;
let lastAny = Number.NEGATIVE_INFINITY;

/**
 * Asks to nudge the human now.
 *
 * A real question ("ask": its sound, the peek, the flight) gets through at
 * most once per NUDGE_EVERY_MS, counted against other questions only, so
 * play can never use up a question's turn. Play (a random peek, bored
 * chatter) waits NUDGE_EVERY_MS after anything at all. Claims within
 * SAME_NUDGE_MS of a granted one of the same kind are the same nudge.
 */
export function claimNudge(
  kind: NudgeKind = "ask",
  now: number = Date.now(),
): boolean {
  const last = kind === "ask" ? lastAsk : lastAny;
  const since = now - last;
  if (kind === "ask" && since >= 0 && since < SAME_NUDGE_MS) return true;
  if (since < NUDGE_EVERY_MS) return false;
  if (kind === "ask") lastAsk = now;
  lastAny = now;
  return true;
}

/** How long until play may come out again; 0 when it may now. */
export function nudgeWaitMs(now: number = Date.now()): number {
  return Math.max(0, NUDGE_EVERY_MS - (now - lastAny));
}

/** Forget every nudge (tests). */
export function resetNudges(): void {
  lastAsk = Number.NEGATIVE_INFINITY;
  lastAny = Number.NEGATIVE_INFINITY;
}
