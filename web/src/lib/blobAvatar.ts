// blobAvatar.ts — retro blob bot marks.
//
// WHAT THIS IS COPYING, AND WHERE IT DELIBERATELY DIVERGES.
//
// Grok Bot's avatar is one filled body with two white eyes CUT OUT of it (holes
// in the silhouette, not shapes drawn on top), user-picked shape and colour,
// and a clean flat iMessage-ish finish. That "one character system, many
// costumes" bet is the good idea and we take it.
//
// Three deliberate differences:
//
//  1. RETRO, NOT FLAT. Theirs is a smooth vector blob. Ours is drawn on a
//     coarse pixel grid with hard edges and no antialiasing, because the
//     product's whole visual language is pixel-art and a smooth blob would be
//     the one un-pixelled thing on the screen.
//  2. DERIVED, NOT PICKED. Theirs asks the user for a shape and a colour at
//     creation. Ours derives both from the bot's slug, so a bot looks the
//     same everywhere forever without anyone choosing, and a roster of bots
//     is automatically varied. Nobody wants to fill in a colour field for
//     their eleventh bot.
//  3. NOT THEIR GEOMETRY. The silhouettes and palette here are ours. We are
//     not reproducing a measured copy of their mark.
//
// The eyes are holes, like theirs, and that part matters: punching the eye out
// of the body means the eye reads as the body's own colour hole rather than a
// white sticker, and it clips correctly at the silhouette edge.

/** Grid resolution. Coarse on purpose — this is pixel art, not a vector blob. */
export const BLOB_GRID = 16;

/**
 * Body silhouettes, as per-row [start, end) spans on a 16x16 grid.
 * Hand-plotted rather than generated so each one is a deliberate shape with a
 * flat bottom that sits on the baseline, the way the reference marks do.
 */
type Span = readonly [number, number];
type Silhouette = readonly Span[];

const EMPTY: Span = [0, 0];

/** Rounded square — the plain one. */
const BLOCK: Silhouette = [
  EMPTY,
  EMPTY,
  [4, 12],
  [3, 13],
  [2, 14],
  [2, 14],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [2, 14],
  [2, 14],
  [3, 13],
  EMPTY,
  EMPTY,
];

/** Dome — flat bottom, arched top. */
const DOME: Silhouette = [
  EMPTY,
  [6, 10],
  [4, 12],
  [3, 13],
  [2, 14],
  [2, 14],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  EMPTY,
];

/** Teardrop — narrow crown widening to a heavy base. */
const DROP: Silhouette = [
  EMPTY,
  [7, 9],
  [6, 10],
  [6, 10],
  [5, 11],
  [4, 12],
  [3, 13],
  [2, 14],
  [2, 14],
  [1, 15],
  [1, 15],
  [1, 15],
  [2, 14],
  [3, 13],
  [5, 11],
  EMPTY,
];

/** Kidney — a soft bean with a dipped crown. */
const BEAN: Silhouette = [
  EMPTY,
  EMPTY,
  [3, 6],
  [2, 7],
  [2, 14],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [2, 14],
  [2, 14],
  [4, 12],
  EMPTY,
  EMPTY,
];

/** Tall capsule. */
const PILL: Silhouette = [
  [5, 11],
  [4, 12],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [3, 13],
  [4, 12],
  [5, 11],
];

/** Wide loaf — squat and broad. */
const LOAF: Silhouette = [
  EMPTY,
  EMPTY,
  EMPTY,
  [3, 13],
  [1, 15],
  [0, 16],
  [0, 16],
  [0, 16],
  [0, 16],
  [0, 16],
  [0, 16],
  [1, 15],
  [2, 14],
  EMPTY,
  EMPTY,
  EMPTY,
];

/** Shield — broad shoulders tapering to a point. */
const SHIELD: Silhouette = [
  EMPTY,
  [3, 13],
  [2, 14],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [2, 14],
  [2, 14],
  [3, 13],
  [4, 12],
  [5, 11],
  [6, 10],
  [7, 9],
  EMPTY,
];

/** Blob — deliberately lopsided, the odd one out. */
const BLOB: Silhouette = [
  EMPTY,
  [5, 10],
  [3, 12],
  [2, 13],
  [2, 14],
  [1, 14],
  [1, 15],
  [1, 15],
  [1, 15],
  [1, 15],
  [2, 15],
  [2, 14],
  [3, 14],
  [4, 12],
  [6, 10],
  EMPTY,
];

export const SILHOUETTES: readonly Silhouette[] = [
  BLOCK,
  DOME,
  DROP,
  BEAN,
  PILL,
  LOAF,
  SHIELD,
  BLOB,
];

/**
 * Body colours. Muted and slightly desaturated rather than primary, so a
 * sidebar of a dozen bots reads as a set instead of a paint chart, and so
 * the black eyes stay the highest-contrast thing on the mark.
 */
export const BLOB_COLORS: readonly string[] = [
  "#8a7a2e", // olive
  "#6b7fd7", // periwinkle
  "#b3702f", // amber-brown
  "#3f9c8f", // teal
  "#a8546b", // rose
  "#6f8f43", // moss
  "#8b6bb1", // violet
  "#c08a3e", // ochre
  "#4d8bb8", // steel blue
  "#a35a45", // clay
  "#5f9e6b", // sage
  "#9a6f9c", // mauve
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
 * from the same value correlates them, so every olive bot would also be a
 * dome and the roster would look like half as many variants as it has.
 */
export function blobShapeIndex(slug: string): number {
  return hashSlug(slug) % SILHOUETTES.length;
}

export function blobColor(slug: string): string {
  return BLOB_COLORS[(hashSlug(slug) >>> 8) % BLOB_COLORS.length];
}

/** Eye geometry, in grid cells. */
interface EyeSpec {
  readonly leftX: number;
  readonly rightX: number;
  readonly topY: number;
  readonly width: number;
  readonly height: number;
}

/**
 * openness is 1 (wide) down to 0 (narrowed to a slit). The eye never fully
 * closes: a blinked-shut mark reads as broken rather than as blinking, and at
 * 16px a one-row eye is already almost nothing.
 */
export function eyeSpec(openness: number): EyeSpec {
  const o = Math.min(1, Math.max(0, openness));
  // 4 rows open, 2 narrowed. The first pass used 5 and the eyes read as tall
  // BARS rather than eyes -- at this grid size an eye more than about a
  // quarter of the body's height stops looking like an eye and starts looking
  // like a slot. Judged by rendering the roster, not by picking a number.
  const height = Math.max(2, Math.round(2 + o * 2));
  return { leftX: 5, rightX: 9, topY: 5, width: 2, height };
}

export interface DrawBlobOptions {
  /** 1 wide open, 0 narrowed. Only the working bot should animate. */
  readonly openness?: number;
  /** Override the derived colour (theme previews, stories). */
  readonly color?: string;
}

/**
 * Paint the mark into a canvas context, scaled to `size` px.
 *
 * Draws the body, then CLEARS the eye rectangles rather than filling them with
 * a colour. Clearing is what makes them holes: whatever is behind the avatar
 * shows through, so the mark composites correctly on any surface and in any
 * theme without needing to know the background — which is the bug that made
 * the previous eye work theme-dependent.
 */
export function drawBlobAvatar(
  ctx: CanvasRenderingContext2D,
  slug: string,
  size: number,
  options: DrawBlobOptions = {},
): void {
  const shape = SILHOUETTES[blobShapeIndex(slug)];
  const color = options.color ?? blobColor(slug);
  const cell = size / BLOB_GRID;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = color;

  for (let row = 0; row < BLOB_GRID; row++) {
    const span = shape[row] ?? EMPTY;
    const [from, to] = span;
    if (to <= from) continue;
    // Round to whole device pixels so edges stay hard. Fractional rects get
    // antialiased by the canvas and the mark stops looking pixelled.
    const x = Math.round(from * cell);
    const y = Math.round(row * cell);
    const w = Math.round(to * cell) - x;
    const h = Math.round((row + 1) * cell) - y;
    ctx.fillRect(x, y, w, h);
  }

  const eye = eyeSpec(options.openness ?? 1);
  for (const ex of [eye.leftX, eye.rightX]) {
    const x = Math.round(ex * cell);
    const y = Math.round(eye.topY * cell);
    const w = Math.round((ex + eye.width) * cell) - x;
    const h = Math.round((eye.topY + eye.height) * cell) - y;
    ctx.clearRect(x, y, w, h);
  }
}

/**
 * Canvas-level entry point, mirroring drawPixelAvatar's contract.
 *
 * The backing buffer is the GRID, not the display size, and CSS scales it up.
 * That is what keeps the mark crisp: the browser upscales 16x16 with
 * `image-rendering: pixelated` (see .pixel-avatar), so the pixels stay square
 * at any size instead of the canvas antialiasing them at draw time.
 */
export function drawBlobAvatarCanvas(
  canvas: HTMLCanvasElement,
  slug: string,
  size: number,
  options: DrawBlobOptions = {},
): void {
  canvas.width = BLOB_GRID;
  canvas.height = BLOB_GRID;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawBlobAvatar(ctx, slug, BLOB_GRID, options);
}
