// Member provenance and look, as /office-members serialises them.
// Kept out of client.ts, which is at the repo's file-size ceiling.

/**
 * Who made this bot. Mirrors internal/team/broker_member_origin.go:
 * "user" (you), "chief_of_staff", "bot" (another teammate), "built_in",
 * "adopted" (an agent CLI found on this machine), "imported" (a gateway
 * or Slack bot).
 */
export type MemberOrigin =
  | "user"
  | "chief_of_staff"
  | "bot"
  | "built_in"
  | "adopted"
  | "imported";

/** Where a bot's turns execute: here, or a gateway / Slack / cloud computer. */
export type MemberRunsOn = "this_machine" | "elsewhere";

/**
 * The office's blob silhouettes, by name. WIRE CONTRACT: mirrors
 * AvatarShapes in internal/team/broker_member_avatar.go, in the order of
 * SILHOUETTES in web/src/lib/blobAvatar.ts (AVATAR_SHAPES there).
 */
export type AvatarShape =
  | "block"
  | "dome"
  | "drop"
  | "bean"
  | "pill"
  | "loaf"
  | "shield"
  | "blob";

/**
 * A bot's chosen look. Both fields are optional; an unset one falls back to
 * the look derived from the slug (blobShapeIndex / blobColor), so a bot with
 * no avatar looks exactly as it always did. `color` is `#rrggbb`, lower-case.
 */
export interface MemberAvatar {
  shape?: AvatarShape;
  color?: string;
}
