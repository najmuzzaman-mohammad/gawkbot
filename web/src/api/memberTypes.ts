// Member provenance and look, as /office-members serialises them.
// Kept out of client.ts, which is at the repo's file-size ceiling.

/**
 * Who made this bot. Mirrors internal/team/broker_member_origin.go:
 * "user" (you), "chief_of_staff", "bot" (another teammate), "built_in",
 * "adopted" (an agent CLI found on this machine), "imported" (a gateway
 * or Slack bot), "session" (a terminal session you opened on this Mac).
 */
export type MemberOrigin =
  | "user"
  | "chief_of_staff"
  | "bot"
  | "built_in"
  | "adopted"
  | "imported"
  | "session";

/**
 * What a session member is doing. WIRE CONTRACT: mirrors memberSessionInfo
 * in internal/team/broker_session_agents.go. Present only on members whose
 * origin is "session", and only for the owner of this Mac.
 */
export interface MemberSession {
  /** Which tool runs it: "claude-code", "codex". */
  tool: string;
  /** The folder it works in, and its full path. */
  project?: string;
  cwd?: string;
  /** Absent once the session is no longer running. */
  state?: "working" | "your_turn" | "quiet";
  updated_at?: string;
  /** The end of its latest reply. */
  last_said?: string;
  /** True while its terminal window is open. */
  live: boolean;
  /**
   * True only when a message from you would be delivered to the session
   * right now. Absent on a broker that cannot message sessions.
   */
  can_message?: boolean;
  /**
   * Why not, when can_message is false: "open" (open in a terminal, and its
   * tool takes no message there), "folder_gone", or "unknown".
   */
  message_block?: "open" | "folder_gone" | "unknown";
}

/** Where a bot's turns execute: here, or a gateway / Slack / cloud computer. */
export type MemberRunsOn = "this_machine" | "elsewhere";

/**
 * The orb bodies a bot can be, by name. WIRE CONTRACT: mirrors
 * AvatarShapes in internal/team/broker_member_avatar.go, in the order of
 * AVATAR_SHAPES in web/src/lib/blobAvatar.ts (the bodies in
 * vendor/orb-mascot). Older brokers may still send the ids of the previous
 * character set; blobAvatar.ts maps those onto these.
 */
export type AvatarShape =
  | "bear"
  | "lemon"
  | "ghost"
  | "cloud"
  | "drop"
  | "stack"
  | "seacow"
  | "flower";

/**
 * A bot's chosen look. Both fields are optional; an unset one falls back to
 * the look derived from the slug (blobShapeIndex / blobColor), so a bot with
 * no avatar looks exactly as it always did. `color` is `#rrggbb`, lower-case.
 */
export interface MemberAvatar {
  shape?: AvatarShape;
  color?: string;
}
