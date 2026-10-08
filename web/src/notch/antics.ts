// The notch's personality, as pure functions so it can be tested and tuned
// without a browser:
//
//   peeks     now and then an agent peeks out from under the notch for no
//             reason at all, looks around, and ducks back.
//   gang-up   when several agents need the human they pile onto the notch
//             together instead of queueing politely.
//   boredom   leave them waiting and they get restless, then start talking
//             to each other about it.
//
// Every line of banter here is written for gawkbot. Lines can mention the
// asker and what they asked; nothing else about the human is used.

import type { NotchAgent, NotchAttention } from "./types";

export type Rand = () => number;

/** Seconds between unprompted peeks: rare enough to stay a surprise. */
export const PEEK_MIN_S = 90;
export const PEEK_MAX_S = 300;
/** How long one peek lasts on screen. */
export const PEEK_DURATION_MS = 3200;

export function nextPeekDelayMs(rand: Rand): number {
  return Math.round((PEEK_MIN_S + rand() * (PEEK_MAX_S - PEEK_MIN_S)) * 1000);
}

/**
 * Who peeks: anyone not already on the notch for a reason. Returns null when
 * nobody is free (everyone is waiting on the human, which is its own show).
 */
export function pickPeeker(
  agents: readonly NotchAgent[],
  busySlugs: ReadonlySet<string>,
  rand: Rand,
): NotchAgent | null {
  const free = agents.filter(
    (a) => !busySlugs.has(a.slug) && a.mood !== "needs_you",
  );
  if (free.length === 0) return null;
  return free[Math.min(free.length - 1, Math.floor(rand() * free.length))];
}

/** 0 patient · 1 fidgeting · 2 chatting among themselves. */
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

export interface BanterLine {
  speaker: string;
  text: string;
}

function short(s: string | undefined, max = 38): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function topic(item: NotchAttention): string {
  return short(item.title || item.question) || "my thing";
}

// Two-speaker exchanges. {a}/{b} are agent names, {ta}/{tb} their asks.
const DUETS: readonly (readonly [string, string][])[] = [
  [
    ["a", "I was here first. “{ta}”"],
    ["b", "Mine is more urgent. Probably."],
    ["a", "Rock paper scissors for who goes first?"],
  ],
  [
    ["b", "Do you think they can see us?"],
    ["a", "They have a camera RIGHT HERE."],
    ["b", "Act natural."],
  ],
  [
    ["a", "Is the human even there?"],
    ["b", "Cursor moved four minutes ago. I'm counting that."],
  ],
  [
    ["b", "I've rehearsed my question eleven times."],
    ["a", "Read it to me."],
    ["b", "“{tb}”"],
    ["a", "Riveting."],
  ],
  [
    ["a", "Should we just do it without asking?"],
    ["b", "No. That's the whole point of the approval gate."],
    ["a", "I know. I just like saying it."],
  ],
  [
    ["b", "Want to start a band while we wait?"],
    ["a", "We'd be called Pending Approval."],
  ],
];

// For a lone waiting agent: muttering to itself.
const SOLO: readonly string[] = [
  "Still here. About “{ta}”.",
  "I'll just wait. Patiently. Very patiently.",
  "Pretending to look busy…",
  "Tapping my foot. Do I have feet?",
];

function fill(
  text: string,
  a: NotchAgent,
  b: NotchAgent | undefined,
  ia: NotchAttention,
  ib: NotchAttention | undefined,
): string {
  return text
    .replaceAll("{a}", a.name)
    .replaceAll("{b}", b?.name ?? "")
    .replaceAll("{ta}", topic(ia))
    .replaceAll("{tb}", ib ? topic(ib) : topic(ia));
}

/**
 * A short script for the bored gang, deterministic for a given seed so a
 * conversation does not reshuffle on every poll.
 */
export function banterScript(
  attention: readonly NotchAttention[],
  agents: readonly NotchAgent[],
  seed: number,
): BanterLine[] {
  const crew = gang(attention, agents);
  if (crew.length === 0) return [];
  const ask = (slug: string) =>
    attention.find((x) => x.from === slug) ?? attention[0];
  const a = crew[Math.abs(seed) % crew.length];
  if (crew.length === 1) {
    const line = SOLO[Math.abs(seed) % SOLO.length];
    return [
      {
        speaker: a.slug,
        text: fill(line, a, undefined, ask(a.slug), undefined),
      },
    ];
  }
  const b = crew[(Math.abs(seed) + 1) % crew.length];
  const duet = DUETS[Math.abs(seed) % DUETS.length];
  return duet.map(([who, text]) => {
    const speaker = who === "a" ? a : b;
    return {
      speaker: speaker.slug,
      text: fill(text, a, b, ask(a.slug), ask(b.slug)),
    };
  });
}

/** Stable small hash for per-speaker voice pitch and script choice. */
export function seedOf(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
