import { announceOn, speak } from "./announce";
import { staysInNotch } from "./hooks";
import type { NotchState } from "./types";

/**
 * The morning nudge: when a new look has produced ideas, the notch says so
 * out loud once, so you hear "3 ideas for new bots" with your coffee and
 * not at all after that. It never opens by itself: the ideas wait in the
 * Suggestions group. Once per look (checked_at), remembered
 * across launches; never while the notch is open, and never when bots are
 * told to stay inside.
 */
const KEY = "gawkbot.notch.ideas.nudged";

export function ideasLine(count: number): string {
  return count === 1
    ? "1 idea for a new bot, when you're ready"
    : `${count} ideas for new bots, when you're ready`;
}

function lastNudged(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberNudged(checkedAt: string): void {
  try {
    window.localStorage.setItem(KEY, checkedAt);
  } catch {
    // Private mode or a full store: the nudge may repeat once; no harm.
  }
}

/** Nudges for a fresh look's ideas; returns what it said, or null. */
export function nudgeForIdeas(
  state: NotchState | null,
  expanded: boolean,
): string | null {
  const ideas = state?.ideas;
  if (!ideas?.checked_at || ideas.items.length === 0) return null;
  if (expanded || staysInNotch(state)) return null;
  if (lastNudged() === ideas.checked_at) return null;
  rememberNudged(ideas.checked_at);
  const line = ideasLine(ideas.items.length);
  if (announceOn(state)) speak(line);
  return line;
}
