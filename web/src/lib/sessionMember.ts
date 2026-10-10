import type { MemberOrigin, OfficeMember } from "../api/client";

// Session members: terminal sessions you opened on this Mac (a Claude Code
// or Codex window), kept on the roster so they show next to the office's
// own bots. The office reads them; it does not run them. See
// internal/team/broker_session_agents.go.

/** A terminal session kept as a member, not a bot the office runs. */
export function isSessionMember(member: { origin?: MemberOrigin }): boolean {
  return member.origin === "session";
}

/**
 * Why a session member cannot be messaged, in one sentence. Shown where the
 * composer would be; keep it equal in meaning to sessionNotMessageableReply
 * in internal/team/broker_session_agents.go.
 */
export const SESSION_NOT_MESSAGEABLE =
  "This session is open in your terminal on this Mac, so it cannot be messaged from here yet.";

/** The folder a session works in, or "" when the broker did not say. */
export function sessionProject(member: Pick<OfficeMember, "session">): string {
  return member.session?.project?.trim() ?? "";
}

/**
 * A session row's status line. It says only what the session's own log
 * says, never the office's idle copy: a terminal session that is doing
 * nothing must not be described as doing something.
 */
export function sessionStatusLabel(
  member: Pick<OfficeMember, "session">,
): "Working" | "Your turn" | "Quiet" | "Closed" {
  const { session } = member;
  if (!session?.live) return "Closed";
  if (session.state === "working") return "Working";
  if (session.state === "your_turn") return "Your turn";
  return "Quiet";
}

/**
 * The one line under the bot's face in an empty conversation. A terminal
 * session cannot be messaged from here, so it must not invite a hello.
 */
export function emptyConversationLine(
  member: Pick<OfficeMember, "slug" | "name" | "origin">,
): string {
  const name = member.name || member.slug;
  return isSessionMember(member)
    ? `${name} runs in your terminal.`
    : `Say hi to ${name}.`;
}
