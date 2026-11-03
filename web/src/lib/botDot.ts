import type { OfficeMember } from "../api/client";

/**
 * The one dot that says what a bot is doing, the same on every surface:
 *
 *   working   orange, pulsing   it is processing right now
 *   finished  green             it finished its turn and waits on you
 *   stuck     red               it hit an error
 *   idle      grey, small       nothing to say
 *
 * Never a spinner. Green means finished, never working.
 */
export type BotDot = "working" | "finished" | "stuck" | "idle";

export function botDot(
  member: Pick<OfficeMember, "status" | "session"> | undefined,
): BotDot {
  if (!member) return "idle";
  const session = member.session;
  if (session) {
    if (!session.live) return "idle";
    if (session.state === "working") return "working";
    if (session.state === "your_turn") return "finished";
    if (session.state) return "idle";
    // No state from the log yet: the activity status says what it knows.
  }
  const status = (member.status || "").toLowerCase();
  if (status === "active") return "working";
  if (status === "error") return "stuck";
  return "idle";
}

/** The status-dot class for a bot's dot (global.css). */
export function botDotClass(dot: BotDot): string {
  return dot === "idle" ? "lurking" : dot;
}
