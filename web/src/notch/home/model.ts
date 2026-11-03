import type { NotchScreen } from "../screens";
import { agentChannel } from "../shared";
import type { NotchAgent, NotchAttention, NotchState } from "../types";

// What the sidebar and the hover list hold, and which pane Home opens on.
// Office bots are rows of their own; terminal sessions found on this Mac
// are one "Sessions" group, and the office's ideas one "Suggestions"
// group, so neither ever reads as a pile of notifications.

export function isSession(agent: NotchAgent): boolean {
  return agent.kind === "session";
}

const NEED_RANK: Record<string, number> = {
  needs_you: 0,
  error: 0,
  working: 1,
};

function lastAt(agent: NotchAgent): number {
  const t = Date.parse(agent.last?.at ?? agent.updated_at ?? "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * The office's bots in sidebar order: the lead first, then whoever needs
 * you, then whoever is working, then the rest, latest first within each.
 */
export function sidebarBots(state: NotchState): NotchAgent[] {
  const rank = (a: NotchAgent) => NEED_RANK[a.mood] ?? 2;
  const bots = state.agents.filter((a) => !isSession(a));
  const lead = bots.filter((a) => a.is_lead);
  const rest = bots
    .filter((a) => !a.is_lead)
    .sort((a, b) => rank(a) - rank(b) || lastAt(b) - lastAt(a));
  return [...lead, ...rest];
}

/** Terminal sessions found on this Mac, latest first. */
export function sessionsOf(state: NotchState): NotchAgent[] {
  return state.agents.filter(isSession).sort((a, b) => lastAt(b) - lastAt(a));
}

/** The questions one bot is waiting on you for, oldest first. */
export function questionsFrom(
  state: NotchState,
  slug: string,
): NotchAttention[] {
  return state.attention.filter((a) => a.from === slug);
}

/** One line under a row's name: what it waits on, does, or last said. */
export function rowLine(agent: NotchAgent, state: NotchState): string {
  const [asked] = questionsFrom(state, agent.slug);
  if (asked) return asked.title || asked.question;
  if (agent.mood === "working" && agent.detail) return agent.detail;
  if (isSession(agent)) return agent.last_said || agent.detail || "";
  return agent.last?.text || agent.detail || "";
}

/** "13:03" for today, "17 Jun" before; "" when unknown. */
export function clockLabel(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "";
  const today = new Date(now);
  if (t.toDateString() === today.toDateString()) {
    return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return t.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** When a row last moved: its newest line, or its session's last update. */
export function rowTime(agent: NotchAgent, now: number): string {
  if (agent.mood === "working") return "Now";
  return clockLabel(agent.last?.at ?? agent.updated_at, now);
}

/** The chat a bot's row opens, or null for a session that cannot be messaged. */
export function chatScreen(
  agent: NotchAgent,
  state: NotchState,
): Extract<NotchScreen, { kind: "agent" }> | null {
  const channel = agentChannel(agent, state);
  if (!channel) return null;
  return { kind: "agent", slug: agent.slug, name: agent.name, channel };
}

/** Whether the suggestions group shows: the daily look is on, or ideas wait. */
export function hasSuggestions(state: NotchState): boolean {
  const { ideas } = state;
  return !!ideas && (ideas.enabled || ideas.items.length > 0);
}

/**
 * Where Home opens: the first bot with a question for you, else the
 * suggestions when ideas wait, else the lead's chat.
 */
export function resolveHome(state: NotchState): NotchScreen {
  for (const card of state.attention) {
    const agent = state.agents.find((a) => a.slug === card.from);
    const chat = agent ? chatScreen(agent, state) : null;
    if (chat) return chat;
  }
  if ((state.ideas?.items.length ?? 0) > 0) return { kind: "suggestions" };
  const lead = state.agents.find((a) => a.is_lead);
  const chat = lead ? chatScreen(lead, state) : null;
  return chat ?? { kind: "suggestions" };
}

/** Rows with something new: an unread line or a question. */
export function sessionsWaiting(state: NotchState): number {
  return sessionsOf(state).filter((s) => s.state === "your_turn").length;
}
