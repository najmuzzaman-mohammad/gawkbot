// cast.ts — the eight bodies, drawn the way a 1930s studio drew a thing
// with a face: an object first, a character second. A lemon is a lemon
// with a stem and a leaf; a cloud is a cloud; a ghost is a bedsheet; the
// stack is a tiered cake that talks from its middle tier.
//
// Every body is a few closed paths in a 200-unit box (centre about
// 100 100), listed back to front, each with its own flat paint: the bot's
// colour, a lighter tint of it, cream, or ink. Nothing is shaded. The rig
// inks every path with a heavy, slightly uneven line and paints the fill
// flat, so the drawing reads as pen and cel paint, not as vector art.
//
// `face` says where the features sit on the object and how big; `arms`
// and `legs` say where the hoses attach. A body that `floats` has no legs
// and bobs in the air instead of standing.

import type { AvatarShape } from "../../api/memberTypes";

/** Which flat paint a part takes. */
export type Tone = "base" | "tint" | "cream" | "ink" | "shade" | "leaf";

export interface Part {
  d: string;
  tone: Tone;
  /** Ink the outline (default true); off for soft interior marks. */
  ink?: boolean;
  /** Line weight scale (default 1). */
  weight?: number;
}

export interface Body {
  /** Back to front. The first part with `tone: "base"` is the main silhouette. */
  parts: Part[];
  /** Bounding box of the whole drawing [x, y, w, h], for layout. */
  box: readonly [number, number, number, number];
  face: {
    cx: number;
    cy: number;
    /** Feature scale: 1 is a 140-wide face. */
    scale: number;
    /** A ball nose between the eyes and the mouth. */
    nose: boolean;
    /** Mouth drop below the eyes, in face units (default 1). */
    mouthDrop?: number;
    /** The paint under the face: what the eyelids are painted in. */
    skin: Tone;
  };
  /** Shoulder points, left then right. */
  arms: readonly [[number, number], [number, number]];
  /** Hip points, left then right. */
  legs: readonly [[number, number], [number, number]];
  floats?: boolean;
}

const OVAL = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${rx * 2} 0 a${rx} ${ry} 0 1 0 ${-rx * 2} 0 Z`;

/** A petal: a long ellipse rotated `deg` about (cx, cy), reaching `len`. */
function petal(
  cx: number,
  cy: number,
  deg: number,
  len: number,
  w: number,
): string {
  const a = (deg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // Ellipse centred `len/2` out along the angle, built from its 4 bezier arcs.
  const mx = cx + ca * (len / 2);
  const my = cy + sa * (len / 2);
  const rx = len / 2;
  const ry = w / 2;
  const k = 0.5523;
  const pt = (u: number, v: number): string => {
    const x = mx + ca * u - sa * v;
    const y = my + sa * u + ca * v;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  };
  return `M${pt(rx, 0)} C${pt(rx, ry * k)} ${pt(rx * k, ry)} ${pt(0, ry)} C${pt(-rx * k, ry)} ${pt(-rx, ry * k)} ${pt(-rx, 0)} C${pt(-rx, -ry * k)} ${pt(-rx * k, -ry)} ${pt(0, -ry)} C${pt(rx * k, -ry)} ${pt(rx, -ry * k)} ${pt(rx, 0)} Z`;
}

export const CAST: Readonly<Record<AvatarShape, Body>> = {
  lemon: {
    parts: [
      // Stem and leaf, behind the top nub.
      { d: "M101 30 C104 16 110 10 116 8", tone: "ink", weight: 0.8 },
      {
        d: "M112 12 C122 -4 150 -6 160 10 C146 22 124 26 112 12 Z",
        tone: "leaf",
      },
      { d: "M118 10 C134 8 146 8 156 10", tone: "ink", weight: 0.55 },
      // The lemon: an egg with a nub at each end, tilted.
      {
        d: "M98 26 C132 20 172 54 172 104 C172 152 138 188 102 190 C92 196 84 194 86 184 C50 176 26 146 28 104 C30 58 64 28 90 28 C92 20 100 18 98 26 Z",
        tone: "base",
      },
      // Pith dimple lines, light.
      { d: "M60 150 C66 160 76 168 88 172", tone: "shade", ink: false },
    ],
    box: [26, 0, 148, 196],
    face: { cx: 100, cy: 108, scale: 1, nose: true, skin: "base" },
    arms: [
      [34, 118],
      [168, 118],
    ],
    legs: [
      [76, 184],
      [124, 184],
    ],
  },

  drop: {
    parts: [
      {
        d: "M100 10 C112 44 170 86 170 130 C170 170 138 194 100 194 C62 194 30 170 30 130 C30 86 88 44 100 10 Z",
        tone: "base",
      },
      // A smaller drip beading off the tip.
      { d: OVAL(126, 26, 7, 9), tone: "base" },
    ],
    box: [28, 8, 144, 188],
    face: { cx: 100, cy: 122, scale: 1, nose: true, skin: "base" },
    arms: [
      [38, 132],
      [162, 132],
    ],
    legs: [
      [74, 190],
      [126, 190],
    ],
  },

  cloud: {
    parts: [
      {
        d: "M52 160 C22 162 16 124 42 112 C30 82 66 60 90 78 C96 44 150 42 156 80 C186 72 200 112 174 128 C194 150 166 176 142 164 C128 186 80 188 66 170 C58 176 52 170 52 160 Z",
        tone: "base",
      },
      // Two puffs of rain-shadow at the bottom, light.
      { d: "M84 172 C94 180 108 180 118 172", tone: "shade", ink: false },
    ],
    box: [20, 44, 168, 142],
    face: { cx: 110, cy: 118, scale: 0.95, nose: true, skin: "base" },
    arms: [
      [30, 134],
      [184, 128],
    ],
    legs: [
      [80, 180],
      [126, 180],
    ],
    floats: true,
  },

  flower: {
    parts: [
      ...[0, 40, 80, 120, 160, 200, 240, 280, 320].map((deg) => ({
        d: petal(100, 104, deg - 90, 92, 44),
        tone: "base" as Tone,
      })),
      // The face is the flower's centre, a pale disc.
      { d: OVAL(100, 104, 54, 52), tone: "cream" },
      { d: OVAL(100, 104, 44, 42), tone: "tint", ink: false },
    ],
    box: [8, 10, 184, 188],
    face: { cx: 100, cy: 104, scale: 0.78, nose: true, skin: "tint" },
    arms: [
      [50, 120],
      [150, 120],
    ],
    legs: [
      [82, 150],
      [118, 150],
    ],
  },

  ghost: {
    parts: [
      {
        d: "M38 190 C34 150 30 120 34 92 C40 40 160 40 166 92 C170 120 166 150 162 190 C150 176 142 176 132 190 C122 176 112 176 100 190 C88 176 78 176 68 190 C58 176 50 176 38 190 Z",
        tone: "cream",
      },
    ],
    box: [30, 44, 140, 148],
    face: { cx: 100, cy: 110, scale: 1, nose: false, skin: "cream" },
    arms: [
      [40, 126],
      [160, 126],
    ],
    legs: [
      [80, 186],
      [120, 186],
    ],
    floats: true,
  },

  bear: {
    parts: [
      { d: OVAL(46, 54, 26, 26), tone: "base" },
      { d: OVAL(154, 54, 26, 26), tone: "base" },
      { d: OVAL(46, 56, 13, 13), tone: "tint", ink: false },
      { d: OVAL(154, 56, 13, 13), tone: "tint", ink: false },
      { d: OVAL(100, 112, 76, 72), tone: "base" },
      // Muzzle, lighter, with a big black nose on it.
      { d: OVAL(100, 142, 36, 25), tone: "tint", weight: 0.8 },
      { d: OVAL(100, 130, 11, 7.5), tone: "ink" },
      { d: OVAL(97, 128, 3, 2), tone: "cream", ink: false },
    ],
    box: [20, 28, 160, 156],
    face: {
      cx: 100,
      cy: 98,
      scale: 1,
      nose: false,
      mouthDrop: 1.3,
      skin: "base",
    },
    arms: [
      [30, 130],
      [170, 130],
    ],
    legs: [
      [74, 180],
      [126, 180],
    ],
  },

  stack: {
    parts: [
      // Three tiers, bottom to top; the face is the middle tier.
      {
        d: "M30 158 C30 142 44 134 64 134 L136 134 C156 134 170 142 170 158 C170 174 156 184 136 184 L64 184 C44 184 30 174 30 158 Z",
        tone: "base",
      },
      {
        d: "M42 108 C42 94 54 86 72 86 L128 86 C146 86 158 94 158 108 C158 124 146 134 128 134 L72 134 C54 134 42 124 42 108 Z",
        tone: "tint",
      },
      {
        d: "M56 62 C56 50 66 42 80 42 L120 42 C134 42 144 50 144 62 C144 76 134 86 120 86 L80 86 C66 86 56 76 56 62 Z",
        tone: "base",
      },
      // A cherry on top.
      { d: "M100 42 C104 30 110 24 118 20", tone: "ink", weight: 0.7 },
      { d: OVAL(100, 36, 9, 9), tone: "shade" },
    ],
    box: [28, 18, 144, 168],
    face: {
      cx: 100,
      cy: 96,
      scale: 0.82,
      nose: false,
      mouthDrop: 1.15,
      skin: "tint",
    },
    arms: [
      [44, 112],
      [156, 112],
    ],
    legs: [
      [74, 182],
      [126, 182],
    ],
  },

  seacow: {
    parts: [
      // Two little flippers behind.
      { d: OVAL(34, 150, 20, 11), tone: "base" },
      { d: OVAL(166, 150, 20, 11), tone: "base" },
      { d: OVAL(100, 108, 80, 72), tone: "base" },
      // A broad muzzle.
      { d: OVAL(100, 148, 50, 29), tone: "tint" },
      { d: OVAL(86, 132, 5, 3.5), tone: "ink" },
      { d: OVAL(114, 132, 5, 3.5), tone: "ink" },
      // Whisker dots.
      { d: OVAL(66, 152, 2.6, 2.6), tone: "ink", ink: false },
      { d: OVAL(58, 160, 2.6, 2.6), tone: "ink", ink: false },
      { d: OVAL(134, 152, 2.6, 2.6), tone: "ink", ink: false },
      { d: OVAL(142, 160, 2.6, 2.6), tone: "ink", ink: false },
    ],
    box: [14, 36, 172, 148],
    face: {
      cx: 100,
      cy: 98,
      scale: 1,
      nose: false,
      mouthDrop: 1.4,
      skin: "base",
    },
    arms: [
      [28, 128],
      [172, 128],
    ],
    legs: [
      [74, 178],
      [126, 178],
    ],
  },
};
