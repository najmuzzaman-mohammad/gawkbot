import type { NotchAgent, NotchState } from "./types";

// What every notch screen shares: where a reply goes, the DM a bot writes
// into, and the short times and labels the rows use.

export type ReplyTarget =
  | { kind: "answer"; requestId: string; to: string }
  | { kind: "message"; slug: string; name: string; channel: string };

export interface ComposerState {
  target: ReplyTarget;
  text: string;
  listening: boolean;
}

/** The DM a row writes into; null for a session that has no DM yet. */
export function agentChannel(
  agent: NotchAgent,
  state: NotchState,
): string | null {
  if (agent.kind === "session" && !agent.can_message) return null;
  if (agent.is_lead && state.lead_dm) return state.lead_dm;
  return dmChannel("human", agent.slug);
}

export function dmChannel(a: string, b: string): string {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

export function channelPath(channel: string | undefined): string {
  return channel ? `/channels/${encodeURIComponent(channel)}` : "/inbox";
}

/**
 * What opening a terminal session where it runs is called, or null for an
 * office bot (whose home is gawkbot) and a session not yet a bot.
 */
export function sourceLabel(agent: NotchAgent | undefined): string | null {
  if (agent?.kind !== "session" || agent.slug.startsWith("session.")) {
    return null;
  }
  if (agent.tool === "codex") return "Open in Codex";
  return agent.open === false ? "Resume in Terminal" : "Open in its window";
}

/** "now", "4m", "2h": how long since a session last did something. */
export function sinceShort(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const min = Math.floor(ms / 60_000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
}
