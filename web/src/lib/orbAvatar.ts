// orbAvatar.ts — the bot characters: Nex's Orb Mascot.
//
// A bot is an orb: a soft body (one of eight, each a few circles melted
// together) in one colour, with two eyes and a mouth that sit on a sphere
// inside it, so a look to the side reads as the head turning. The drawing
// and the motion are vendor/orb-mascot/core.js (MIT, unmodified); this
// module is the typed door into it plus the two things gawkbot adds: which
// orb a bot is (lib/blobAvatar.ts decides the body and colour) and what face
// it pulls for a mood.
//
// The core is a UMD build that registers itself on `window`; importing it
// for effect and reading it back keeps the vendored file byte-identical to
// upstream.

import "../vendor/orb-mascot/core.js";

import type { AvatarShape } from "../api/memberTypes";
import type MascotClass from "../vendor/orb-mascot/core";
import { AVATAR_SHAPES, type AvatarChoice, resolveAvatar } from "./blobAvatar";

export type Mascot = InstanceType<typeof MascotClass>;
export type { LiveValues, Status } from "../vendor/orb-mascot/core";

const host = (typeof window !== "undefined" ? window : globalThis) as {
  Mascot?: typeof MascotClass;
};
if (!host.Mascot) {
  throw new Error("orb-mascot core did not register window.Mascot");
}

/** The mascot class (vendor/orb-mascot/core.d.ts documents it). */
export const Orb: typeof MascotClass = host.Mascot;

/** The orb's drawing box: everything is drawn in these viewBox units. */
export const ORB_VIEWBOX = "-24 -24 248 248";

/**
 * The face a bot pulls. NotchBot maps a mood onto one; the office app uses
 * `calm`, and `working` for the bot processing right now.
 */
export type Face = "calm" | "working" | "sleepy" | "asking" | "oops" | "happy";

/**
 * How each face is drawn: `still` is a pose for a mark that is not
 * animating (every list, byline and picker tile); `status` is the orb's own
 * looping state for a live mark (the notch, a working bot). `set` are live
 * values layered on top of the status for a face the orb has no state for.
 */
export interface FaceSpec {
  readonly still: {
    readonly eyeScale?: number;
    readonly squash?: number;
    readonly mouth?: number;
    readonly mouthLen?: number;
  };
  readonly status: "idle" | "thinking" | "speaking" | "success" | "error";
}

export const FACES: Record<Face, FaceSpec> = {
  calm: { still: {}, status: "idle" },
  // Concentrating: narrowed eyes while still; the eyes spin while live.
  working: { still: { squash: 0.7, mouth: 0.15 }, status: "thinking" },
  // Half-closed eyes, a small smile. No looping state: a sleepy bot is calm.
  sleepy: { still: { squash: 0.4, mouth: 0.2 }, status: "idle" },
  // Wide eyes and a small "o": it is asking you something; live, it talks.
  asking: {
    still: { eyeScale: 1.15, mouth: 0.1, mouthLen: 0.6 },
    status: "speaking",
  },
  // A frown and flattened eyes; live, a short head shake too.
  oops: { still: { mouth: -0.6, squash: 0.82 }, status: "error" },
  // A big smile; live, star eyes first.
  happy: { still: { mouth: 0.9, squash: 0.85 }, status: "success" },
};

/**
 * The brand mark: gawkbot itself is an orb too, the sky-blue flower. The
 * same look is the favicon, the app icons and the website's mark
 * (scripts/brand-assets.mjs bakes those from this choice).
 */
export const BRAND_AVATAR: AvatarChoice = {
  shape: "flower",
  color: "#5aa9ff",
};

export interface OrbLook {
  readonly body: AvatarShape;
  readonly color: string;
}

/** Which orb `slug` is, honouring a chosen look. */
export function orbLook(slug: string, avatar?: AvatarChoice | null): OrbLook {
  const r = resolveAvatar(slug, avatar);
  return { body: AVATAR_SHAPES[r.shapeIndex], color: r.color };
}

/**
 * The options every gawkbot orb is built with: the avatar preset (calm in
 * a list: no cursor follow, no wander, no lean, no breathing, no tap) with
 * the gradient shade on, so the body has light and shadow at every size.
 */
export function orbOptions(look: OrbLook) {
  return {
    preset: "avatar" as const,
    body: look.body,
    color: look.color,
    shade: "gradient" as const,
    autoBlink: true,
  };
}

/**
 * Put a still mark into a face: the pose is applied at once, with no loop
 * running. `blink` is 0 open to 1 shut; the eyes also narrow for it.
 */
export function poseStill(
  m: Mascot,
  face: Face,
  opts: { yaw?: number; pitch?: number; blink?: number } = {},
): void {
  const s = FACES[face].still;
  m.manual = true;
  m.snap(opts.yaw ?? 0, opts.pitch ?? 0);
  m.setNow({
    eyeScale: s.eyeScale ?? 1,
    squash: s.squash ?? 1,
    mouth: s.mouth ?? null,
    mouthLen: s.mouthLen ?? 1,
    mouthSide: 0,
    mouthTilt: 0,
    blink: opts.blink ?? 0,
  });
  m.render();
}

/**
 * Put a live mark (loop running) into a face: the orb's own looping state,
 * then the face's live values on top for faces without a state of their
 * own. The status call resets the face first, so the order matters.
 */
export function poseLive(m: Mascot, face: Face): void {
  const spec = FACES[face];
  m.setStatus(spec.status);
  if (spec.status === "idle") {
    const s = spec.still;
    m.set({
      eyeScale: s.eyeScale ?? 1,
      squash: s.squash ?? 1,
      mouth: s.mouth ?? null,
      mouthLen: s.mouthLen ?? 1,
    });
  }
}

/** True when the person has asked for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * A finished, filter-free SVG string of a still mark, for places without
 * React (the website sprite). Needs a canvas, so a real browser.
 */
export function orbStillSvg(
  look: OrbLook,
  face: Face,
  opts: {
    size?: number;
    id?: string;
    yaw?: number;
    pitch?: number;
    blink?: number;
  } = {},
): string {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const m = new Orb(svg, { ...orbOptions(look), lean: false });
  poseStill(m, face, opts);
  return m.toSVG({ size: opts.size ?? 240, id: opts.id ?? "orb" });
}
