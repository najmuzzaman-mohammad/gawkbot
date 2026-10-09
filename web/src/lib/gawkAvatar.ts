// gawkAvatar.ts — the office's bot characters, as geometry.
//
// Every bot is a small soft creature: one rounded body with volume (lit from
// the top left, a glossy highlight, a little bounce light along the bottom
// and a contact shadow underneath), two big glossy eyes, a mouth, and a
// signature accessory per species. Eight species share the eight shape ids
// that have always been on the wire (AVATAR_SHAPES in blobAvatar.ts), so a
// bot that picked "drop" last year is still a drop; it just grew a face.
//
// This module is pure: it turns a look plus an expression into a list of
// drawing primitives in a 0..64 box. components/ui/BlobAvatar.tsx renders
// that list as React SVG, and gawkAvatarSvg() below renders it as a string
// for places with no React (the website sprite, tests).
//
// Why primitives rather than a finished SVG string: the eyes carry CSS
// classes for the blink and working animations (styles/avatar-motion.css,
// global.css), and React needs to own those elements.

import {
  AVATAR_SHAPES,
  type AvatarChoice,
  normalizeAvatarColor,
  resolveAvatar,
} from "./blobAvatar";

export const GAWK_VIEW = 64;

/** How the face reads. NotchBot maps a bot's mood onto one of these. */
export type Expression = "calm" | "focus" | "sleepy" | "ask" | "oops" | "happy";

type Pt = readonly [number, number];

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/** Closed Catmull-Rom spline through `points`, as cubic Béziers. */
function closedSpline(points: readonly Pt[], tension = 0.5): string {
  const n = points.length;
  if (n < 3) return "";
  const k = tension / 3;
  let d = `M${fmt(points[0][0])} ${fmt(points[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) * k;
    const c1y = p1[1] + (p2[1] - p0[1]) * k;
    const c2x = p2[0] - (p3[0] - p1[0]) * k;
    const c2y = p2[1] - (p3[1] - p1[1]) * k;
    d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return `${d}Z`;
}

// ── Bodies ───────────────────────────────────────────────────────────
// Control points, clockwise from the top. Feet sit on y≈57 so every species
// stands on the same floor; the contact shadow goes just under it.

const BODY_POINTS: Record<(typeof AVATAR_SHAPES)[number], readonly Pt[]> = {
  // A plump squircle. The plain one; the antenna is its whole personality.
  block: [
    [32, 11],
    [49, 14],
    [54, 34],
    [49, 55],
    [32, 57],
    [15, 55],
    [10, 34],
    [15, 14],
  ],
  // Flat-bottomed dome with two round ears.
  dome: [
    [32, 10],
    [45, 13],
    [53, 24],
    [55, 42],
    [52, 56],
    [32, 57],
    [12, 56],
    [9, 42],
    [11, 24],
    [19, 13],
  ],
  // A teardrop, heavy at the base, with a curl at the tip.
  drop: [
    [32, 9],
    [38, 17],
    [47, 27],
    [53, 39],
    [51, 51],
    [42, 57],
    [22, 57],
    [13, 51],
    [11, 39],
    [17, 27],
    [26, 17],
  ],
  // A kidney bean leaning back, with a sprout.
  bean: [
    [27, 12],
    [41, 10],
    [51, 16],
    [55, 30],
    [54, 45],
    [47, 55],
    [33, 58],
    [19, 56],
    [11, 47],
    [9, 33],
    [14, 21],
  ],
  // Tall capsule with two antennae.
  pill: [
    [32, 6],
    [43, 8],
    [49, 18],
    [49, 34],
    [48, 48],
    [43, 56],
    [32, 58],
    [21, 56],
    [16, 48],
    [15, 34],
    [15, 18],
    [21, 8],
  ],
  // Wide and low, on two little feet.
  loaf: [
    [32, 17],
    [47, 18],
    [57, 25],
    [60, 38],
    [57, 51],
    [47, 56],
    [32, 57],
    [17, 56],
    [7, 51],
    [4, 38],
    [7, 25],
    [17, 18],
  ],
  // Broad shoulders tapering down, with two small horns.
  shield: [
    [32, 10],
    [46, 11],
    [55, 19],
    [54, 35],
    [47, 49],
    [37, 57],
    [27, 57],
    [17, 49],
    [10, 35],
    [9, 19],
    [18, 11],
  ],
  // Lopsided on purpose, blowing a bubble.
  blob: [
    [29, 10],
    [42, 9],
    [52, 15],
    [57, 29],
    [53, 43],
    [50, 54],
    [37, 58],
    [23, 57],
    [12, 52],
    [8, 40],
    [11, 26],
    [18, 13],
  ],
};

export function bodyPath(shapeIndex: number): string {
  const shape = AVATAR_SHAPES[shapeIndex] ?? AVATAR_SHAPES[0];
  return closedSpline(BODY_POINTS[shape]);
}

// ── Colour ───────────────────────────────────────────────────────────

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): Hsl {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(f(hh + 1 / 3))}${to(f(hh))}${to(f(hh - 1 / 3))}`;
}

/**
 * The three tones a body is painted with, from one stored colour. The lit
 * side goes lighter and a touch warmer; the shaded side darker and a touch
 * cooler, which is what makes a flat colour read as a lit object.
 */
export interface Tones {
  readonly base: string;
  readonly light: string;
  readonly dark: string;
  /** For the accessory's darker parts and the mouth on pale bodies. */
  readonly deep: string;
}

export function tones(base: string): Tones {
  const c = hexToHsl(base);
  return {
    base,
    light: hslToHex({
      h: c.h - 8,
      s: Math.min(1, c.s * 1.05),
      l: c.l + (1 - c.l) * 0.34,
    }),
    dark: hslToHex({ h: c.h + 10, s: Math.min(1, c.s * 1.08), l: c.l * 0.72 }),
    deep: hslToHex({ h: c.h + 14, s: Math.min(1, c.s * 1.1), l: c.l * 0.5 }),
  };
}

/** Eyes and mouth: one deep ink for every bot, so faces match across a roster. */
export const INK = "#1d1b2e";
const CHEEK = "#ff7d9c";

// ── Primitives ───────────────────────────────────────────────────────

interface Paint {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  /** Clipped to the body outline (highlights, bounce light). */
  clipToBody?: boolean;
  /** CSS classes carried by the element (eyes). */
  className?: string;
}

export type Primitive =
  | ({ kind: "path"; d: string } & Paint)
  | ({
      kind: "ellipse";
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      rotate?: number;
    } & Paint)
  | ({ kind: "circle"; cx: number; cy: number; r: number } & Paint);

export interface Gradient {
  readonly kind: "linear" | "radial";
  /** Linear: x1 y1 x2 y2 in box fractions. Radial: cx cy r (fractions). */
  readonly geometry: readonly number[];
  readonly stops: readonly {
    offset: number;
    color: string;
    opacity?: number;
  }[];
}

/** Gradient names used in primitives as `url(#<prefix>-<name>)`. */
export type GradientName = "body" | "sheen" | "bounce" | "shadow" | "ball";

export interface GawkMark {
  readonly shape: (typeof AVATAR_SHAPES)[number];
  readonly shapeIndex: number;
  readonly color: string;
  readonly tones: Tones;
  readonly body: string;
  readonly gradients: Readonly<Record<GradientName, Gradient>>;
  /** Drawn before the body (ears, feet, antennae roots). */
  readonly behind: readonly Primitive[];
  /** Body shading, clipped to the outline. */
  readonly shading: readonly Primitive[];
  /** Drawn after the body (bubbles, curls, the face). */
  readonly front: readonly Primitive[];
  /** The eye elements, separately, so renderers can animate them. */
  readonly eyes: readonly Primitive[];
}

export interface GawkOptions {
  readonly avatar?: AvatarChoice | null;
  readonly expression?: Expression;
  /** 1 wide open, 0 narrowed. Multiplies the expression's own eye height. */
  readonly openness?: number;
  /** Override the colour outright (theme previews, stories). Beats avatar. */
  readonly color?: string;
}

function grad(
  kind: Gradient["kind"],
  geometry: number[],
  stops: Gradient["stops"],
): Gradient {
  return { kind, geometry, stops };
}

function accessory(
  shape: (typeof AVATAR_SHAPES)[number],
  t: Tones,
): { behind: Primitive[]; front: Primitive[] } {
  const behind: Primitive[] = [];
  const front: Primitive[] = [];
  switch (shape) {
    case "block":
      behind.push(
        { kind: "path", d: "M32 12V4", stroke: t.dark, strokeWidth: 2.4 },
        { kind: "circle", cx: 32, cy: 3.6, r: 3, fill: "url(#G-ball)" },
      );
      break;
    case "dome":
      behind.push(
        { kind: "circle", cx: 14, cy: 15, r: 5.5, fill: t.dark },
        { kind: "circle", cx: 50, cy: 15, r: 5.5, fill: t.dark },
        { kind: "circle", cx: 14, cy: 15, r: 2.6, fill: t.light, opacity: 0.6 },
        { kind: "circle", cx: 50, cy: 15, r: 2.6, fill: t.light, opacity: 0.6 },
      );
      break;
    case "drop":
      front.push({
        kind: "path",
        d: "M32.5 10C30 5 33 1 37 2.5C39.5 3.5 39 7 36.5 7",
        stroke: t.dark,
        strokeWidth: 2.6,
      });
      break;
    case "bean":
      behind.push(
        {
          kind: "path",
          d: "M40 12C41 8 42 6 44 4",
          stroke: t.dark,
          strokeWidth: 2.2,
        },
        {
          kind: "ellipse",
          cx: 46.5,
          cy: 3.8,
          rx: 4.2,
          ry: 2.3,
          rotate: -28,
          fill: t.light,
        },
      );
      break;
    case "pill":
      behind.push(
        { kind: "path", d: "M25 9L19 2.5", stroke: t.dark, strokeWidth: 2.2 },
        { kind: "path", d: "M39 9L45 2.5", stroke: t.dark, strokeWidth: 2.2 },
        { kind: "circle", cx: 18.5, cy: 2.4, r: 2.3, fill: "url(#G-ball)" },
        { kind: "circle", cx: 45.5, cy: 2.4, r: 2.3, fill: "url(#G-ball)" },
      );
      break;
    case "loaf":
      behind.push(
        { kind: "ellipse", cx: 20, cy: 57.5, rx: 6.5, ry: 3.4, fill: t.dark },
        { kind: "ellipse", cx: 44, cy: 57.5, rx: 6.5, ry: 3.4, fill: t.dark },
      );
      break;
    case "shield":
      behind.push(
        {
          kind: "path",
          d: "M14 16C11 11 12 5 16 5C19.5 5 21 10 22 14Z",
          fill: t.dark,
        },
        {
          kind: "path",
          d: "M50 16C53 11 52 5 48 5C44.5 5 43 10 42 14Z",
          fill: t.dark,
        },
      );
      break;
    case "blob":
      front.push(
        {
          kind: "circle",
          cx: 55,
          cy: 9,
          r: 3.6,
          stroke: t.dark,
          strokeWidth: 1.6,
        },
        { kind: "circle", cx: 49.5, cy: 15.5, r: 1.5, fill: t.dark },
        {
          kind: "circle",
          cx: 56.2,
          cy: 7.6,
          r: 1,
          fill: "#ffffff",
          opacity: 0.8,
        },
      );
      break;
  }
  return { behind, front };
}

const EYE_L: Pt = [24.5, 31];
const EYE_R: Pt = [39.5, 31];
const EYE_RX = 4.6;
const EYE_RY = 5.8;
const EYE_CLASS = "gawk-eye avatar-motion-eye pixel-avatar-eye";

function face(
  expression: Expression,
  openness: number,
  t: Tones,
): { eyes: Primitive[]; rest: Primitive[] } {
  const o = Math.min(1, Math.max(0, openness));
  const eyes: Primitive[] = [];
  const rest: Primitive[] = [];
  const stroke = { stroke: INK, strokeWidth: 2.2 } as const;

  const openEyes = (scale: number) => {
    // Never fully shut: a shut eye reads as broken rather than blinking.
    const ry = EYE_RY * scale * Math.max(0.18, o);
    for (const [cx, cy] of [EYE_L, EYE_R]) {
      eyes.push({
        kind: "ellipse",
        cx,
        cy,
        rx: EYE_RX,
        ry,
        fill: INK,
        className: EYE_CLASS,
      });
    }
    // The catchlight sits on the eye and is not scaled with it.
    if (ry > 2.2) {
      for (const [cx, cy] of [EYE_L, EYE_R]) {
        rest.push({
          kind: "circle",
          cx: cx - 1.4,
          cy: cy - ry * 0.38,
          r: 1.4,
          fill: "#ffffff",
          opacity: 0.94,
        });
      }
    }
  };

  switch (expression) {
    case "focus":
      openEyes(0.55);
      rest.push({ kind: "path", d: "M29 42.5H35", ...stroke });
      break;
    case "sleepy":
      openEyes(0.3);
      rest.push({ kind: "path", d: "M30.5 42.5Q32 44.2 33.5 42.5", ...stroke });
      break;
    case "ask":
      openEyes(1.12);
      rest.push(
        {
          kind: "path",
          d: "M20.5 22.5Q24.5 19.5 28.5 22.5",
          ...stroke,
          strokeWidth: 1.9,
        },
        {
          kind: "path",
          d: "M35.5 22.5Q39.5 19.5 43.5 22.5",
          ...stroke,
          strokeWidth: 1.9,
        },
        { kind: "ellipse", cx: 32, cy: 43.2, rx: 2.7, ry: 3.1, fill: INK },
      );
      break;
    case "oops":
      openEyes(0.9);
      rest.push(
        { kind: "path", d: "M20.5 22L28.5 24.5", ...stroke, strokeWidth: 1.9 },
        { kind: "path", d: "M43.5 22L35.5 24.5", ...stroke, strokeWidth: 1.9 },
        { kind: "path", d: "M27.5 43.5Q29.75 41 32 43.5T36.5 43.5", ...stroke },
      );
      break;
    case "happy":
      // Eyes closed in a smile: arcs instead of discs. They still carry the
      // eye class so a renderer can find them, but there is nothing to blink.
      for (const [cx, cy] of [EYE_L, EYE_R]) {
        eyes.push({
          kind: "path",
          d: `M${fmt(cx - 4.5)} ${fmt(cy + 1)}Q${fmt(cx)} ${fmt(cy - 5)} ${fmt(cx + 4.5)} ${fmt(cy + 1)}`,
          stroke: INK,
          strokeWidth: 2.5,
          className: EYE_CLASS,
        });
      }
      rest.push(
        {
          kind: "path",
          d: "M26 40.5Q32 47.5 38 40.5",
          ...stroke,
          strokeWidth: 2.4,
        },
        {
          kind: "ellipse",
          cx: 18.5,
          cy: 37.5,
          rx: 3.6,
          ry: 2.2,
          fill: CHEEK,
          opacity: 0.42,
        },
        {
          kind: "ellipse",
          cx: 45.5,
          cy: 37.5,
          rx: 3.6,
          ry: 2.2,
          fill: CHEEK,
          opacity: 0.42,
        },
      );
      break;
    default:
      openEyes(1);
      rest.push({ kind: "path", d: "M28 41.5Q32 45 36 41.5", ...stroke });
  }
  void t;
  return { eyes, rest };
}

/** The character for `slug`, as drawing primitives in a 0..GAWK_VIEW box. */
export function gawkMark(slug: string, options: GawkOptions = {}): GawkMark {
  const look = resolveAvatar(slug, options.avatar);
  const color = normalizeAvatarColor(options.color) ?? look.color;
  const t = tones(color);
  const shape = AVATAR_SHAPES[look.shapeIndex];
  const body = bodyPath(look.shapeIndex);
  const acc = accessory(shape, t);
  const f = face(options.expression ?? "calm", options.openness ?? 1, t);

  const gradients: Record<GradientName, Gradient> = {
    body: grad(
      "linear",
      [0.2, 0, 0.8, 1],
      [
        { offset: 0, color: t.light },
        { offset: 0.5, color: t.base },
        { offset: 1, color: t.dark },
      ],
    ),
    sheen: grad(
      "radial",
      [0.32, 0.22, 0.55],
      [
        { offset: 0, color: "#ffffff", opacity: 0.5 },
        { offset: 1, color: "#ffffff", opacity: 0 },
      ],
    ),
    bounce: grad(
      "radial",
      [0.5, 1.05, 0.6],
      [
        { offset: 0, color: t.light, opacity: 0.45 },
        { offset: 1, color: t.light, opacity: 0 },
      ],
    ),
    shadow: grad(
      "radial",
      [0.5, 0.5, 0.5],
      [
        { offset: 0, color: "#000000", opacity: 0.28 },
        { offset: 1, color: "#000000", opacity: 0 },
      ],
    ),
    ball: grad(
      "radial",
      [0.35, 0.3, 0.75],
      [
        { offset: 0, color: t.light },
        { offset: 1, color: t.dark },
      ],
    ),
  };

  const shading: Primitive[] = [
    // Volume: the lit side and the bounce light are gradients over the body.
    { kind: "path", d: body, fill: "url(#G-sheen)", clipToBody: true },
    { kind: "path", d: body, fill: "url(#G-bounce)", clipToBody: true },
    // The glossy highlight: one soft ellipse up on the lit shoulder.
    {
      kind: "ellipse",
      cx: 23,
      cy: 18.5,
      rx: 7.5,
      ry: 3.6,
      rotate: -26,
      fill: "#ffffff",
      opacity: 0.55,
      clipToBody: true,
    },
  ];

  return {
    shape,
    shapeIndex: look.shapeIndex,
    color,
    tones: t,
    body,
    gradients,
    behind: [
      {
        kind: "ellipse",
        cx: 32,
        cy: 59.6,
        rx: 17,
        ry: 3.4,
        fill: "url(#G-shadow)",
      },
      ...acc.behind,
    ],
    shading,
    front: [...acc.front, ...f.rest],
    eyes: f.eyes,
  };
}

// ── String renderer ──────────────────────────────────────────────────

function attrs(p: Paint): string {
  let s = "";
  if (p.fill) s += ` fill="${p.fill}"`;
  else if (p.stroke) s += ' fill="none"';
  if (p.stroke) {
    s += ` stroke="${p.stroke}" stroke-width="${fmt(p.strokeWidth ?? 2)}" stroke-linecap="round" stroke-linejoin="round"`;
  }
  if (p.opacity !== undefined) s += ` opacity="${fmt(p.opacity)}"`;
  if (p.className) s += ` class="${p.className}"`;
  return s;
}

function primitiveSvg(p: Primitive, prefix: string, clipId: string): string {
  const a = attrs(p).replace(/url\(#G-/g, `url(#${prefix}-`);
  let el: string;
  switch (p.kind) {
    case "path":
      el = `<path d="${p.d}"${a}/>`;
      break;
    case "circle":
      el = `<circle cx="${fmt(p.cx)}" cy="${fmt(p.cy)}" r="${fmt(p.r)}"${a}/>`;
      break;
    case "ellipse": {
      const rot = p.rotate
        ? ` transform="rotate(${fmt(p.rotate)} ${fmt(p.cx)} ${fmt(p.cy)})"`
        : "";
      el = `<ellipse cx="${fmt(p.cx)}" cy="${fmt(p.cy)}" rx="${fmt(p.rx)}" ry="${fmt(p.ry)}"${a}${rot}/>`;
    }
  }
  // The clip goes on a group, not the element: a clip-path on a transformed
  // element is transformed with it, and a rotated clip lets the highlight
  // leak past the body on the narrow species.
  return p.clipToBody ? `<g clip-path="url(#${clipId})">${el}</g>` : el;
}

function gradientSvg(name: string, g: Gradient): string {
  const stops = g.stops
    .map(
      (s) =>
        `<stop offset="${fmt(s.offset)}" stop-color="${s.color}"${s.opacity !== undefined ? ` stop-opacity="${fmt(s.opacity)}"` : ""}/>`,
    )
    .join("");
  if (g.kind === "linear") {
    const [x1, y1, x2, y2] = g.geometry;
    return `<linearGradient id="${name}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
  }
  const [cx, cy, r] = g.geometry;
  return `<radialGradient id="${name}" cx="${cx}" cy="${cy}" r="${r}">${stops}</radialGradient>`;
}

/**
 * The mark's inner SVG markup (defs plus elements), for a 0..GAWK_VIEW
 * viewBox. `prefix` keeps gradient and clip ids unique on a page.
 */
export function gawkMarkSvg(mark: GawkMark, prefix: string): string {
  const clipId = `${prefix}-clip`;
  const defs =
    `<defs>` +
    (Object.keys(mark.gradients) as GradientName[])
      .map((n) => gradientSvg(`${prefix}-${n}`, mark.gradients[n]))
      .join("") +
    `<clipPath id="${clipId}"><path d="${mark.body}"/></clipPath></defs>`;
  const draw = (ps: readonly Primitive[]) =>
    ps.map((p) => primitiveSvg(p, prefix, clipId)).join("");
  return (
    defs +
    draw(mark.behind) +
    `<path d="${mark.body}" fill="url(#${prefix}-body)"/>` +
    draw(mark.shading) +
    draw(mark.eyes) +
    draw(mark.front)
  );
}

/** A complete standalone `<svg>` for `slug`, `size` px square. */
export function gawkAvatarSvg(
  slug: string,
  size: number,
  options: GawkOptions & { prefix?: string } = {},
): string {
  const mark = gawkMark(slug, options);
  const prefix =
    options.prefix ??
    `gawk-${mark.shapeIndex}-${mark.color.slice(1)}-${options.expression ?? "calm"}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${GAWK_VIEW} ${GAWK_VIEW}" overflow="visible">` +
    gawkMarkSvg(mark, prefix) +
    `</svg>`
  );
}
