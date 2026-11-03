import type { NotchAgent, NotchAttention, NotchState } from "./types";

/**
 * The cards at the top right of the screen: where a bot says what it has
 * to say without opening the notch. One per office bot that is working,
 * waiting on you, or just finished; the lead is the notch itself, and a
 * terminal session you opened by hand is not a bot of the office, so
 * neither gets one. The one "cards" switch hides them all.
 */
export type DockKind = "working" | "needs_you" | "done";

export interface DockCard {
  agent: NotchAgent;
  kind: DockKind;
  /** What it says, in full: the card wraps it, never cuts it. */
  line: string;
  /** More of what it said, behind History. */
  history: string[];
  /** The question behind a needs-you card. */
  question?: NotchAttention;
}

/** How long a done card stays when nobody closes it. */
export const DONE_CARD_MS = 10 * 60_000;

function isOfficeBot(agent: NotchAgent): boolean {
  return !agent.is_lead && agent.kind !== "session";
}

/** The bots at work: the cards the dock always had. */
export function dockAgents(state: NotchState | undefined): NotchAgent[] {
  if (!state || state.jump_out === false) return [];
  return state.agents.filter((a) => a.mood === "working" && isOfficeBot(a));
}

function questionText(q: NotchAttention): string {
  const title = q.title?.trim() ?? "";
  const body = q.question?.trim() ?? "";
  if (!title) return body;
  if (!body || body === title) return title;
  return `${title} ${body}`;
}

/**
 * Every card, newest worry first: questions, then work, then what just
 * finished. `done` holds when each bot was last seen finishing (NotchDock
 * keeps it); `closed` the cards the person closed.
 */
export function dockCards(
  state: NotchState | undefined,
  done: ReadonlyMap<string, number>,
  closed: ReadonlySet<string>,
  now: number,
): DockCard[] {
  if (!state || state.jump_out === false) return [];
  const cards: DockCard[] = [];
  const asked = new Set<string>();
  for (const q of state.attention) {
    const agent = state.agents.find((a) => a.slug === q.from);
    if (!(agent && isOfficeBot(agent)) || asked.has(agent.slug)) continue;
    if (closed.has(`q:${q.id}`)) continue;
    asked.add(agent.slug);
    cards.push({
      agent,
      kind: "needs_you",
      line: questionText(q),
      history: q.context ? [q.context] : [],
      question: q,
    });
  }
  for (const agent of dockAgents(state)) {
    if (asked.has(agent.slug)) continue;
    cards.push({
      agent,
      kind: "working",
      line: agent.detail || "Working",
      history: agent.last?.text ? [agent.last.text] : [],
    });
  }
  for (const [slug, at] of done) {
    const agent = state.agents.find((a) => a.slug === slug);
    if (!agent || agent.mood === "working" || asked.has(slug)) continue;
    if (closed.has(`d:${slug}:${at}`) || now - at > DONE_CARD_MS) continue;
    cards.push({
      agent,
      kind: "done",
      line: agent.last?.text || "Done.",
      history: agent.detail ? [agent.detail] : [],
    });
  }
  return cards;
}

/** The key a card is closed under: a question by its id, a finish by when. */
export function cardKey(
  card: DockCard,
  done: ReadonlyMap<string, number>,
): string {
  if (card.kind === "needs_you" && card.question)
    return `q:${card.question.id}`;
  if (card.kind === "done")
    return `d:${card.agent.slug}:${done.get(card.agent.slug) ?? 0}`;
  return `w:${card.agent.slug}`;
}

/**
 * Bots that were working last poll and are not now: they just finished.
 * Returns the new map; the input is untouched.
 */
export function trackDone(
  prevWorking: ReadonlySet<string>,
  state: NotchState | undefined,
  done: ReadonlyMap<string, number>,
  now: number,
): Map<string, number> {
  const next = new Map(done);
  if (!state) return next;
  for (const agent of state.agents) {
    if (!isOfficeBot(agent)) continue;
    if (agent.mood === "working") {
      next.delete(agent.slug);
    } else if (prevWorking.has(agent.slug)) {
      next.set(agent.slug, now);
    }
  }
  return next;
}

/** The width the Mac app gives the cards (desktop/oswails/dock_darwin.m). */
export const DOCK_WIDTH = 300;
