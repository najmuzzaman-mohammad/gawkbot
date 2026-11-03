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
 * Why a session member cannot be messaged, in one sentence, when nothing
 * more exact is known. Keep it equal in meaning to
 * sessionNotMessageableReply in internal/team/broker_session_agents.go.
 */
export const SESSION_NOT_MESSAGEABLE =
  "This session is open in your terminal on this Mac, so it cannot be messaged from here yet.";

/**
 * The session is held by something gawkbot cannot type into: a background
 * run, not a terminal window. A session open in a window is messaged by
 * typing into it, so it never shows this.
 */
export const SESSION_OPEN_IN_TERMINAL =
  "This session is running in a background process, not a terminal window. You can message it from here once that run ends.";

/** The folder the session worked in no longer exists. */
export const SESSION_FOLDER_GONE =
  "The folder this session worked in is gone, so it cannot be resumed.";

/**
 * Whether a message typed here would reach this member. Any bot the office
 * runs: yes. A terminal session: only when the broker says a message would
 * be delivered right now.
 */
export function canBeMessaged(
  member: Pick<OfficeMember, "origin" | "session">,
): boolean {
  return !isSessionMember(member) || member.session?.can_message === true;
}

/**
 * Why a session member cannot be messaged right now and what to do, in one
 * sentence. Shown where the composer would be.
 */
export function sessionNotMessageableLine(
  member: Pick<OfficeMember, "session">,
): string {
  switch (member.session?.message_block) {
    case "open":
      return SESSION_OPEN_IN_TERMINAL;
    case "folder_gone":
      return SESSION_FOLDER_GONE;
    default:
      return SESSION_NOT_MESSAGEABLE;
  }
}

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
 * session that cannot take a message from here must not invite a hello; one
 * that can says so, and says it is a session, not one of the office's bots.
 */
export function emptyConversationLine(
  member: Pick<OfficeMember, "slug" | "name" | "origin" | "session">,
): string {
  const name = member.name || member.slug;
  if (!isSessionMember(member)) return `Say hi to ${name}.`;
  return canBeMessaged(member)
    ? `${name} runs in your terminal. You can message it from here.`
    : `${name} runs in your terminal.`;
}
