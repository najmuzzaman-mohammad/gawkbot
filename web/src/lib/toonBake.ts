// toonBake.ts — the toon drawn still, as markup, for scripts that bake
// assets outside the app (scripts/brand-assets.mjs runs this in headless
// Chromium): the website's sprite, the favicon, the app icons.

import type { AvatarShape } from "../api/memberTypes";
import { markView, type Pose, REST, ToonRig } from "./toon/rig";

export interface BakeLook {
  body: AvatarShape;
  color: string;
  /** Where it looks at rest, -1..1. */
  yaw?: number;
  pitch?: number;
}

/** A head-only mark as an <svg> string, with `pose` on top of REST. */
export function bakeMark(look: BakeLook, pose: Partial<Pose> = {}): string {
  const rig = new ToonRig({
    body: look.body,
    color: look.color,
    arms: false,
    legs: false,
  });
  rig.draw({
    ...REST,
    yaw: look.yaw ?? 0,
    pitch: look.pitch ?? 0,
    lookX: (look.yaw ?? 0) * 0.6,
    ...pose,
  });
  // The shadow has no place in a mark.
  rig.showShadow(false);
  const v = markView(look.body);
  rig.svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  rig.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  return rig.svg.outerHTML;
}

(window as unknown as { GawkBake: unknown }).GawkBake = { bakeMark, markView };
