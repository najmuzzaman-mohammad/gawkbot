import type { NotchAgent, NotchState } from "./types";

// One order for every list of agents in the notch, office bots and
// sessions alike: red (asking for an answer, or stuck), then green (a
// finished turn waiting on the human), then orange (working), then the
// rest, and the latest first within each.

/** The agents whose finished turn is waiting on the human. */
export function finishedSlugs(state: NotchState | null): ReadonlySet<string> {
  return new Set((state?.finished ?? []).map((f) => f.from));
}

export type DotMood = "needs_you" | "error" | "working" | "done";

/**
 * What an agent's dot says. Asking for an answer and being stuck are red,
 * a finished turn waiting on the human is green, work is orange. A finished
 * turn the human marked done, and anything quiet, has no dot.
 */
export function dotMood(
  a: NotchAgent,
  finished: ReadonlySet<string>,
): DotMood | null {
  if (a.mood === "needs_you" || a.mood === "error" || a.mood === "working") {
    return a.mood;
  }
  if (finished.has(a.slug)) return "done";
  return null;
}

/** Red, then green, then orange, then no dot. */
const COLOUR_RANK: Record<DotMood | "none", number> = {
  needs_you: 0,
  error: 0,
  done: 1,
  working: 2,
  none: 3,
};

function lastActive(a: NotchAgent): number {
  const t = a.updated_at ? Date.parse(a.updated_at) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

/** The agents in notch order; a new array, the input untouched. */
export function byNeed(
  agents: readonly NotchAgent[],
  finished: ReadonlySet<string>,
): NotchAgent[] {
  const rank = (a: NotchAgent) => COLOUR_RANK[dotMood(a, finished) ?? "none"];
  return [...agents].sort(
    (a, c) => rank(a) - rank(c) || lastActive(c) - lastActive(a),
  );
}
