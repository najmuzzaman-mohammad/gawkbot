// nudge.ts — how often the notch may come out at you.
//
// Agents nudging is the point of the notch, and too much of it is the
// fastest way to get it switched off. So every way an agent can come out
// on its own (the peek that opens the notch for a new question, the flight
// into the ear, a random peek, bored chatter under the notch) draws on one
// budget: one nudge every five minutes. Anything that arrives in between
// still updates the count on the notch, silently.

/** At most one nudge in this long. */
export const NUDGE_EVERY_MS = 5 * 60_000;

/**
 * One nudge can be several things at once (the sound, the peek and the
 * flight for the same new question), so claims this close together count
 * as the same nudge.
 */
export const SAME_NUDGE_MS = 2_000;

let last = Number.NEGATIVE_INFINITY;

/**
 * Asks to nudge the human now. True at most once per NUDGE_EVERY_MS, plus
 * anything else claimed within SAME_NUDGE_MS of that one.
 */
export function claimNudge(now: number = Date.now()): boolean {
  const since = now - last;
  if (since >= 0 && since < SAME_NUDGE_MS) return true;
  if (since < NUDGE_EVERY_MS) return false;
  last = now;
  return true;
}

/** How long until the next nudge is allowed; 0 when one is allowed now. */
export function nudgeWaitMs(now: number = Date.now()): number {
  return Math.max(0, NUDGE_EVERY_MS - (now - last));
}

/** Forget the last nudge (tests). */
export function resetNudges(): void {
  last = Number.NEGATIVE_INFINITY;
}
