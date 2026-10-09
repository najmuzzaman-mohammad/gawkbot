// paint.ts — the toon look's colour: every bot keeps its own colour, painted
// the way a 1930s three-strip cel was. The base is pushed a little richer
// and warmer, shadows go cool toward plum rather than toward grey, the
// light is a warm cream, and the ink is a brown-black, never pure black.

export interface Paint {
  /** The body's base colour, richer than the bot's chosen swatch. */
  base: string;
  /** The hard-edged shadow side. */
  shade: string;
  /** The airbrushed light on the near side. */
  light: string;
  /** Lids and cheeks: the base, a touch deeper. */
  lid: string;
  /** Ink for every outline and the pupils. */
  ink: string;
  /** Gloves, the whites of the eyes and the shine. */
  white: string;
  /** Cheeks. */
  blush: string;
  /** Inside an open mouth. */
  mouth: string;
  tongue: string;
  shoe: string;
}

export const INK = "#21140f";
const WHITE = "#fffaf0";
const CREAM = "#fff3d6";
const PLUM = "#3a1f4d";

type RGB = [number, number, number];

function parse(hex: string): RGB {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, "$&$&") : h;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: RGB): string {
  const c = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Saturation pushed by `k` around the colour's own grey. */
function saturate([r, g, b]: RGB, k: number): RGB {
  const grey = 0.3 * r + 0.59 * g + 0.11 * b;
  return [grey + (r - grey) * k, grey + (g - grey) * k, grey + (b - grey) * k];
}

/** The painted palette for a bot colour (#rrggbb). */
export function paintFor(color: string): Paint {
  const c = parse(color);
  // Richer and a hair warmer: the swatches are tuned for flat UI chips.
  const base = mix(saturate(c, 1.18), [255, 196, 120], 0.06);
  return {
    base: hex(base),
    shade: hex(mix(mix(base, [0, 0, 0], 0.18), parse(PLUM), 0.28)),
    light: hex(mix(base, parse(CREAM), 0.62)),
    lid: hex(mix(base, parse(PLUM), 0.12)),
    ink: INK,
    white: WHITE,
    blush: hex(mix(base, [255, 92, 110], 0.55)),
    mouth: "#4a1218",
    tongue: "#e8506a",
    shoe: "#4a2a1c",
  };
}
