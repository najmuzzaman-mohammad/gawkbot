/**
 * Which avatar system the product draws.
 *
 * "blob" is the shipped look: a per-bot silhouette with the eyes punched out
 * of it. "sprite" is the previous pixel-character portrait system, kept whole
 * and reachable so reverting is this one constant rather than a revert commit.
 *
 * Both paths are exercised by tests. A switch whose other branch is never run
 * is not a switch, it is dead code with a comment on it.
 */
export type AvatarMode = "blob" | "sprite";

export const AVATAR_MODE: AvatarMode = "blob";
