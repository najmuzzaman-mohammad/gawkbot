import type { MemberLook } from "../api/memberTypes";

/**
 * A character's look on top of its orb: hair, eyes, and one accessory.
 * This module is the vocabulary and the rules; the drawing is
 * components/ui/OrbLookOverlay.tsx, a sibling <svg> in the orb's own
 * viewbox (ORB_VIEWBOX: a 200 unit body centred at 100,100 with 24 units
 * of margin), so the orb core stays unmodified and an orb with no look
 * draws exactly as before. Unknown values draw nothing, so an older
 * client never breaks on a newer look.
 */

export const HAIR = ["none", "tuft", "bob", "mohawk", "curls", "cap"] as const;
export const EYES = ["default", "glasses", "wink", "sparkle"] as const;
export const ACCESSORIES = [
  "none",
  "bow",
  "tie",
  "headphones",
  "scarf",
  "antenna",
] as const;

export type Hair = (typeof HAIR)[number];
export type Eyes = (typeof EYES)[number];
export type Accessory = (typeof ACCESSORIES)[number];

export const LOOK_LABELS: Record<string, string> = {
  none: "None",
  tuft: "Tuft",
  bob: "Bob",
  mohawk: "Mohawk",
  curls: "Curls",
  cap: "Cap",
  default: "Plain",
  glasses: "Glasses",
  wink: "Wink",
  sparkle: "Sparkle",
  bow: "Bow",
  tie: "Tie",
  headphones: "Headphones",
  scarf: "Scarf",
  antenna: "Antenna",
};

export const DEFAULT_HAIR_COLOR = "#2b2b33";

/** The parts a look draws, each known to the overlay, in painting order. */
export interface LookPart {
  kind: "hair" | "eyes" | "accessory";
  id: string;
  color: string;
}

function known<T extends readonly string[]>(
  list: T,
  v: string | undefined,
): v is T[number] {
  return !!v && (list as readonly string[]).includes(v);
}

/** Resolves a look into the parts to draw; empty for no look. */
export function lookParts(
  look: MemberLook | undefined | null,
  bodyColor: string,
): LookPart[] {
  if (!look) return [];
  const hairColor =
    look.hair_color && /^#[0-9a-f]{6}$/i.test(look.hair_color)
      ? look.hair_color
      : DEFAULT_HAIR_COLOR;
  const out: LookPart[] = [];
  const accessory =
    known(ACCESSORIES, look.accessory) && look.accessory !== "none"
      ? look.accessory
      : null;
  // Behind the hair: things worn on the body; in front: things on the head.
  if (accessory && accessory !== "bow" && accessory !== "antenna")
    out.push({ kind: "accessory", id: accessory, color: bodyColor });
  if (known(HAIR, look.hair) && look.hair !== "none")
    out.push({ kind: "hair", id: look.hair, color: hairColor });
  if (known(EYES, look.eyes) && look.eyes !== "default")
    out.push({ kind: "eyes", id: look.eyes, color: "#1a1a1f" });
  if (accessory && (accessory === "bow" || accessory === "antenna"))
    out.push({ kind: "accessory", id: accessory, color: bodyColor });
  return out;
}

/** Whether a look draws anything at all. */
export function hasLook(look: MemberLook | undefined | null): boolean {
  return lookParts(look, "#000000").length > 0;
}
