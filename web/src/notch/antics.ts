// The strip's personality, as pure functions so it can be tested and tuned
// without a browser:
//
//   gang-up   when several agents need the human they pile onto the notch
//             together instead of queueing politely.
//   boredom   leave them waiting and they get restless on the strip.

import type { NotchAgent, NotchAttention } from "./types";

/** 0 patient · 1 fidgeting · 2 restless, more than one waiting. */
export type Boredom = 0 | 1 | 2;

export const FIDGET_AFTER_S = 30;
export const CHAT_AFTER_S = 75;

/** How restless the waiting agents are, from the oldest unanswered ask. */
export function boredom(
  attention: readonly NotchAttention[],
  nowMs: number,
  firstSeenMs: ReadonlyMap<string, number>,
): Boredom {
  if (attention.length === 0) return 0;
  let oldest = nowMs;
  for (const a of attention) {
    const created = a.created_at ? Date.parse(a.created_at) : Number.NaN;
    const seen = firstSeenMs.get(a.id) ?? nowMs;
    // Trust the broker's timestamp, but never let clock skew make an ask
    // older than the moment this notch first saw it plus a minute.
    const since = Number.isFinite(created)
      ? Math.max(created, seen - 60_000)
      : seen;
    oldest = Math.min(oldest, since);
  }
  const waited = (nowMs - oldest) / 1000;
  if (attention.length >= 2 && waited >= CHAT_AFTER_S) return 2;
  if (waited >= FIDGET_AFTER_S) return 1;
  return 0;
}

/** The agents piled on the notch: one per asker, oldest ask first. */
export function gang(
  attention: readonly NotchAttention[],
  agents: readonly NotchAgent[],
): NotchAgent[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const out: NotchAgent[] = [];
  const seen = new Set<string>();
  for (const item of attention) {
    if (seen.has(item.from)) continue;
    seen.add(item.from);
    out.push(
      bySlug.get(item.from) ?? {
        slug: item.from || "someone",
        name: item.from_name || item.from || "someone",
        mood: "needs_you",
      },
    );
  }
  return out;
}
