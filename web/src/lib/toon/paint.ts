// paint.ts — the toon look's colour: cel paint, nothing shaded. Every bot
// keeps its own colour, printed the way a 1930s three-strip cel came out:
// a little muted and warm, flat, with a lighter tint for muzzles and
// centres, a cream for whites, and one brown-black ink for every line.

export interface Paint {
  /** The body's colour, flat. */
  base: string;
  /** A lighter tint of it: muzzles, inner ears, the flower's centre. */
  tint: string;
  /** A deeper tone of it: a cherry, a dimple line. */
  shade: string;
  /** Leaves and stems. */
  leaf: string;
  /** Gloves, the whites of the eyes, teeth, a ghost. */
  cream: string;
  /** Every outline, the pupils, the hoses. */
  ink: string;
  /** Inside an open mouth. */
  mouth: string;
  tongue: string;
  shoe: string;
}

export const INK = "#1b1511";
const CREAM = "#f6ead0";
const WARM = "#f0c98a";

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
  // A touch less vivid and a touch warmer than the UI swatch: film stock.
  const base = mix(saturate(c, 0.9), parse(WARM), 0.1);
  return {
    base: hex(base),
    tint: hex(mix(base, parse(CREAM), 0.55)),
    shade: hex(mix(base, parse(INK), 0.35)),
    leaf: "#6f9a4c",
    cream: CREAM,
    ink: INK,
    mouth: "#5a1a1e",
    tongue: "#d9566a",
    shoe: "#5a3420",
  };
}
