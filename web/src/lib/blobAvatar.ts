// blobAvatar.ts — which look a bot has.
//
// A bot's look is a BODY (one of the eight orb bodies) and a COLOUR. Both
// are derived from the slug by default, so a roster is varied and a bot
// looks the same everywhere without anyone choosing; a person can override
// either field (MemberAvatar on the wire, resolveAvatar below), and an unset
// field keeps the derived value, so bots made before avatars were pickable
// are unchanged.
//
// This module decides WHAT a bot looks like. lib/orbAvatar.ts draws it.

import type { AvatarShape } from "../api/memberTypes";

/**
 * Body ids: the orb bodies in vendor/orb-mascot, by their own names. WIRE
 * CONTRACT: the same list, in the same order, as AvatarShapes in
 * internal/team/broker_member_avatar.go and BotAvatar.shapeIDs on iOS.
 */
export const AVATAR_SHAPES: readonly AvatarShape[] = [
  "bear",
  "lemon",
  "ghost",
  "cloud",
  "drop",
  "stack",
  "seacow",
  "flower",
];

/**
 * The previous character set's ids, as bots that chose one before the orbs
 * still carry them. Each maps onto the orb that stands in for it. Mirrored
 * in the broker and on iOS.
 */
export const LEGACY_AVATAR_SHAPES: Readonly<Record<string, AvatarShape>> = {
  block: "stack",
  dome: "bear",
  drop: "drop",
  bean: "seacow",
  pill: "lemon",
  loaf: "cloud",
  shield: "ghost",
  blob: "flower",
};

/**
 * Body colours. Saturated but soft, picked so twelve of them next to each
 * other read as one set. The orb derives its eye colour and its light and
 * shadow tints from whichever it gets, so any of these works.
 */
export const AVATAR_COLORS: readonly string[] = [
  "#ff7a59", // coral
  "#ffa53d", // tangerine
  "#f2c94c", // butter
  "#9ad44e", // lime
  "#45cfa0", // mint
  "#3cc3df", // aqua
  "#5aa9ff", // sky
  "#7b7dff", // indigo
  "#b48cff", // lavender
  "#ff79c6", // pink
  "#ff6b8b", // rose
  "#8ea0b8", // slate
];

/** Human names for AVATAR_COLORS, index-aligned (picker labels). */
export const AVATAR_COLOR_NAMES: readonly string[] = [
  "Coral",
  "Tangerine",
  "Butter",
  "Lime",
  "Mint",
  "Aqua",
  "Sky",
  "Indigo",
  "Lavender",
  "Pink",
  "Rose",
  "Slate",
];

/** FNV-1a. Small, stable, and good enough to spread slugs across two tables. */
function hashSlug(slug: string): number {
  let h = 0x811c9dc5;
  const s = slug.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Shape and colour are drawn from SEPARATE bits of the hash. Deriving both
 * from the same value correlates them, so every coral bot would also be a
 * dome and the roster would look like half as many variants as it has.
 */
export function blobShapeIndex(slug: string): number {
  return hashSlug(slug) % AVATAR_SHAPES.length;
}

export function blobColor(slug: string): string {
  return AVATAR_COLORS[(hashSlug(slug) >>> 8) % AVATAR_COLORS.length];
}

/**
 * A chosen look, as the broker sends it (MemberAvatar). Typed loosely here
 * because it is untrusted wire data: anything unknown falls back.
 */
export interface AvatarChoice {
  readonly shape?: string;
  readonly color?: string;
}

export interface ResolvedAvatar {
  readonly shapeIndex: number;
  /** `#rrggbb`, lower-case. */
  readonly color: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** A `#rrggbb` colour, lower-cased, or undefined if it is not one. */
export function normalizeAvatarColor(
  color: string | undefined,
): string | undefined {
  const c = color?.trim().toLowerCase();
  return c && HEX_COLOR.test(c) ? c : undefined;
}

/**
 * The AVATAR_SHAPES index for a shape name, or -1 if it is not one. A
 * legacy id counts as the orb it maps to.
 */
export function avatarShapeIndex(shape: string | undefined): number {
  const s = shape?.trim().toLowerCase();
  if (!s) return -1;
  const legacy = Object.hasOwn(LEGACY_AVATAR_SHAPES, s)
    ? LEGACY_AVATAR_SHAPES[s]
    : undefined;
  return AVATAR_SHAPES.indexOf((legacy ?? s) as AvatarShape);
}

/** True when `avatar` sets at least one valid field, i.e. is not automatic. */
export function hasAvatarChoice(avatar?: AvatarChoice | null): boolean {
  return (
    avatarShapeIndex(avatar?.shape) >= 0 ||
    normalizeAvatarColor(avatar?.color) !== undefined
  );
}

/**
 * The shape and colour to draw for `slug`. Each field of `avatar` that is
 * set and valid wins; an unset or unrecognised one falls back to the slug's
 * derived value, so a malformed avatar degrades to the automatic look rather
 * than to nothing.
 */
export function resolveAvatar(
  slug: string,
  avatar?: AvatarChoice | null,
): ResolvedAvatar {
  const picked = avatarShapeIndex(avatar?.shape);
  return {
    shapeIndex: picked >= 0 ? picked : blobShapeIndex(slug),
    color: normalizeAvatarColor(avatar?.color) ?? blobColor(slug),
  };
}
