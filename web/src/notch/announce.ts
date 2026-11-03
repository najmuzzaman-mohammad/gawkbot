import { isInMacApp, postNative } from "./bridge";
import type { NotchAttention, NotchState } from "./types";

/**
 * Bots speak up: when a new card needs you, or a turn finishes, the notch
 * says so out loud, one line each, in the Mac's own voice. Never on the
 * first look (the backlog is not news), never while you are talking to
 * it, never when the switch is off.
 */

/** What has been said already, so each card is announced once. */
export interface Known {
  attention: ReadonlySet<string>;
  finished: ReadonlySet<string>;
}

const MAX_LINE = 140;

export function known(state: NotchState): Known {
  return {
    attention: new Set(state.attention.map((a) => a.id)),
    finished: new Set((state.finished ?? []).map((a) => a.id)),
  };
}

function shorten(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= MAX_LINE) return one;
  const cut = one.slice(0, MAX_LINE);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(", "));
  return (stop > 40 ? cut.slice(0, stop) : cut).trim() + "…";
}

function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(one);
  return shorten(m ? m[1] : one);
}

function whoIs(card: NotchAttention, state: NotchState): string {
  if (card.from_name) return card.from_name;
  const agent = state.agents.find((a) => a.slug === card.from);
  return agent?.name ?? card.from;
}

/** The line for a card that needs you. */
export function askLine(card: NotchAttention, state: NotchState): string {
  const what = card.title || card.question || "";
  const who = whoIs(card, state);
  return what ? `${who} needs you: ${shorten(what)}` : `${who} needs you.`;
}

/** The line for a finished turn. */
export function doneLine(card: NotchAttention, state: NotchState): string {
  const who = whoIs(card, state);
  const reply = card.recap?.reply ?? "";
  return reply ? `${who} is done: ${firstSentence(reply)}` : `${who} is done.`;
}

/**
 * What to say for this poll, and what is known after it. The first poll
 * says nothing and only remembers; a card seen before is never repeated.
 */
export function announcements(
  prev: Known | null,
  state: NotchState,
): { known: Known; lines: string[] } {
  const next = known(state);
  if (prev === null) return { known: next, lines: [] };
  const lines: string[] = [];
  for (const card of state.attention) {
    if (prev.attention.has(card.id)) continue;
    lines.push(askLine(card, state));
  }
  for (const card of state.finished ?? []) {
    if (prev.finished.has(card.id)) continue;
    // Terminal sessions finish all day; only the office's bots say so.
    const from = state.agents.find((a) => a.slug === card.from);
    if (from?.kind === "session") continue;
    lines.push(doneLine(card, state));
  }
  return { known: next, lines };
}

/** Whether the person turned announcements off. On unless chosen. */
export function announceOn(state: NotchState | null): boolean {
  return state?.announce !== false;
}

/** Says a line out loud: the Mac app's voice, or the browser's. */
export function speak(text: string): void {
  if (!text) return;
  if (isInMacApp()) {
    postNative({ type: "say", text });
    return;
  }
  const synth = (window as { speechSynthesis?: SpeechSynthesis })
    .speechSynthesis;
  if (synth && typeof SpeechSynthesisUtterance !== "undefined") {
    synth.speak(new SpeechSynthesisUtterance(text));
  }
}

/** Stops whatever is being said: the person started talking. */
export function hush(): void {
  if (isInMacApp()) {
    postNative({ type: "hush" });
    return;
  }
  (window as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.cancel();
}
