// Office-sheet avatar portraits for built-in bots and dynamic bots.
// Unknown slugs deterministically pick from the generated office catalog so
// newly created teammates do not fall back to the deprecated legacy sprites.

import {
  KNOWN_AVATAR_SPRITES,
  type KnownAvatarSprite,
  resolveKnownPortraitSprite,
} from "./avatarSprites.generated";

const AGENT_COLORS: Record<string, string> = {
  ceo: "#E8A838",
  eng: "#3FB950",
  gtm: "#FFA657",
  human: "#38BDF8",
  pm: "#58A6FF",
  fe: "#A371F7",
  frontend: "#A371F7",
  be: "#3FB950",
  backend: "#3FB950",
  ai: "#D2A8FF",
  "ai-eng": "#D2A8FF",
  ai_eng: "#D2A8FF",
  designer: "#F778BA",
  cmo: "#FFA657",
  cro: "#79C0FF",
  jim: "#8FB3D1",
  pam: "#F4B6C2",
  nex: "#56D4DD",
};

const AGENT_COLOR_ALIASES: Record<string, string> = {
  halpert: "jim",
  "jim-halpert": "jim",
  // Pam the librarian commits to the wiki under the "archivist" git identity
  // (see ArchivistAuthor in internal/team). Bylines, audit rows, and history
  // therefore arrive with slug "archivist" — alias it (and "librarian") onto
  // Pam so her accent colour matches the desk avatar everywhere she appears.
  archivist: "pam",
  librarian: "pam",
  planner: "pm",
  product: "pm",
  "product-manager": "pm",
  builder: "eng",
  "founding-engineer": "eng",
  "workflow-architect": "eng",
  "automation-builder": "eng",
  growth: "gtm",
  "growth-ops": "gtm",
  monetization: "cro",
  revenue: "cro",
  invoicing: "cro",
  operator: "nex",
  ops: "nex",
  operations: "nex",
};

type Rgb = readonly [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/* ─────────────────────────────────────────────────────────────────────────
   GAWK EYES

   Bots wear the gawkbot mark's hollow eyes, tinted per bot so you can
   tell teammates apart at a glance, and the eyes narrow and widen only on
   the bot that is working right now.

   WHY THE SPRITE IS SUPERSAMPLED BEFORE THE EYES ARE DRAWN
   --------------------------------------------------------
   Do not "optimise" the supersample away. It is not a quality tweak, it is
   the only reason this works at all.

   A hollow eye needs at least three pixels across: border, hole, border.
   The catalog sprites are 16x16 and give each eye exactly ONE pixel. Drawing
   a 3x3 ring at native resolution consumes six of the sixteen columns,
   collides with the brow row, and the portrait reads as swimming goggles
   rather than a face. That was rendered and rejected.

   So the sprite is blown up by an integer factor first (nearest-neighbour,
   no smoothing) and the ring is drawn in that larger grid, where it is only
   about 1.4 original pixels wide. The CSS size is unchanged, so nothing in
   any layout moves; only the backing resolution grows. `image-rendering:
   pixelated` on .pixel-avatar keeps it crisp on the way back down.
   ───────────────────────────────────────────────────────────────────────── */

/** Nearest-neighbour blow-up factor. See the note above before changing it. */
const EYE_SUPERSAMPLE = 6;

/** Below this rendered size the eyes are omitted: the ring is illegible at
 *  byline scale and degrades into a smudge, so small avatars stay portraits. */
export const EYES_MIN_SIZE = 24;

/** Ring footprint, in ORIGINAL sprite cells (not supersampled pixels). */
const EYE_WIDTH_CELLS = 1.4;
const EYE_HEIGHT_CELLS = 1.7;

/** How far the eyes narrow at the bottom of the gawk cycle. */
export const EYE_OPENNESS_MIN = 0.42;

/**
 * Eye cell (column, row) per sprite, in ORIGINAL sprite coordinates.
 *
 * This is deliberately an explicit table rather than a "find the dark pixels"
 * heuristic. A heuristic was tried and it is wrong on at least six of these
 * twenty-one: hybridQa's glasses and hybridNex's and hybridCmo's hair read as
 * eye-dark, hybridAe and hybridCro have no dark pixels in the eye rows at all,
 * and hybridGeneric has BROWS BUT NO EYES so there is nothing to find. Six
 * silent misplacements look like a bug in something else entirely, which is
 * worse than no heuristic.
 *
 * Every entry below was derived from the sprite data and then verified by
 * rendering all twenty-one with the chosen cells marked.
 *
 * Keyed by sprite id, not bot slug, because many slugs share one sprite.
 * Sprites absent from this table simply render without eyes.
 */
export const SPRITE_EYE_CELLS: Record<
  string,
  readonly (readonly [number, number])[]
> = {
  hybridAe: [
    [8, 5],
    [11, 5],
  ],
  hybridAi: [
    [7, 6],
    [11, 6],
  ],
  hybridBe: [
    [8, 5],
    [11, 5],
  ],
  hybridCeo: [
    [7, 6],
    [11, 6],
  ],
  hybridCmo: [
    [7, 5],
    [11, 5],
  ],
  hybridContent: [
    [7, 6],
    [11, 6],
  ],
  hybridCro: [
    [8, 5],
    [11, 5],
  ],
  hybridDesigner: [
    [7, 6],
    [11, 6],
  ],
  hybridEng: [
    [7, 6],
    [11, 6],
  ],
  hybridFe: [
    [7, 6],
    [11, 6],
  ],
  // No eyes are drawn on this sprite at all, only brows. The cells below sit
  // under those brows, where the eyes would have been.
  hybridGeneric: [
    [8, 6],
    [11, 6],
  ],
  hybridGtm: [
    [8, 5],
    [11, 5],
  ],
  hybridHuman: [
    [7, 6],
    [11, 6],
  ],
  // The one sprite that is not 16x16. It is 24 rows by 17 columns, which is
  // why nothing here may assume a 16-cell grid.
  hybridJim: [
    [9, 8],
    [13, 8],
  ],
  hybridNex: [
    [8, 5],
    [11, 5],
  ],
  hybridPam: [
    [7, 6],
    [11, 6],
  ],
  hybridPamCute: [
    [7, 6],
    [10, 6],
  ],
  hybridPm: [
    [7, 6],
    [11, 6],
  ],
  hybridQa: [
    [8, 6],
    [11, 6],
  ],
  hybridResearch: [
    [7, 6],
    [11, 6],
  ],
  hybridSdr: [
    [8, 5],
    [11, 5],
  ],
  // Reachable through PORTRAIT_SPRITE_ALIASES (jim / halpert / jim-halpert),
  // not through the generated slug map. Wears glasses; the eyes sit behind
  // the lenses a row lower than the hybrid faces.
  office20: [
    [7, 7],
    [11, 7],
  ],
};

/**
 * Hue arcs the per-bot eye colour is allowed to land in.
 *
 * A fixed list of N swatches was tried first and rejected: with ten swatches a
 * ten-bot roster collided four ways, which defeats the entire purpose of
 * colouring the eyes. Sampling a continuous arc instead gives effectively
 * unlimited distinct identities from the same deterministic hash.
 *
 * One arc only, yellow-green through teal to blue. Everything outside it is
 * spoken for, and a test asserts no generated colour escapes:
 *   241-317  purple, the product accent (--accent / --tertiary-400). The arc
 *            stops at 240 rather than nearer the accent's own ~285 because
 *            violet arrives well before purple does. At this saturation and
 *            luminance, hue 241 is already #6160d5 and hue 262 is #7f56d2,
 *            both of which read as the accent. 240 is the measured last
 *            hue that still reads blue.
 *   318-345  magenta and pink were tried and removed. At this luminance they
 *            render as raspberry (#ce4977), which is close enough to the
 *            danger colour to be a semantic collision at 24px.
 *   346-84   red (danger) through orange and brown, which are the hair, brow,
 *            and skin tones these eyes have to sit against.
 */
const EYE_HUE_ARCS: readonly (readonly [number, number])[] = [[85, 240]];

const EYE_SATURATION = 0.58;

/**
 * Target relative luminance for every eye colour, whatever its hue.
 *
 * This single number is what makes the eyes legible. An eye darker than this
 * band merges into the brow directly above it; an eye lighter than it merges
 * into the surrounding skin. Sprite skin sits near 150-200 and brow/hair near
 * 20-60, so holding every hue at ~104 clears both by a wide margin. Lightness
 * is solved per hue to hit it, because at a fixed HSL lightness a green is far
 * brighter than a blue and the band would not hold.
 */
const EYE_TARGET_LUMINANCE = 104;

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1]: [number, number, number] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Solve HSL lightness for the target luminance at this hue. */
function eyeColourForHue(hue: number): string {
  let lo = 0.12;
  let hi = 0.72;
  let rgb: Rgb = hslToRgb(hue, EYE_SATURATION, 0.4);
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    rgb = hslToRgb(hue, EYE_SATURATION, mid);
    if (relativeLuminance(rgb) < EYE_TARGET_LUMINANCE) lo = mid;
    else hi = mid;
  }
  return rgbToHex(rgb);
}

const eyeColourCache = new Map<string, string>();

/**
 * Deterministic per-bot eye colour, derived from the slug alone.
 *
 * Slug-derived rather than roster-index-derived on purpose: the same teammate
 * must be the same colour on every machine and every reload, and adding an
 * bot must not re-colour everyone else.
 */
export function getBotEyeColor(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  const key = AGENT_COLOR_ALIASES[normalized] ?? (normalized || "unknown");
  const cached = eyeColourCache.get(key);
  if (cached) return cached;

  const span = EYE_HUE_ARCS.reduce(
    (total, [from, to]) => total + (to - from),
    0,
  );
  // 1024 steps across the arcs: fine enough that neighbouring slugs separate,
  // coarse enough that two colours are never imperceptibly different.
  let offset = (pick(hashSlug(key), 21, 1024) / 1024) * span;
  let hue = EYE_HUE_ARCS[0]?.[0] ?? 0;
  for (const [from, to] of EYE_HUE_ARCS) {
    const width = to - from;
    if (offset < width) {
      hue = from + offset;
      break;
    }
    offset -= width;
  }

  const colour = eyeColourForHue(hue);
  eyeColourCache.set(key, colour);
  return colour;
}

function paletteFromHexes(palette: string[]): Record<number, Rgb> {
  return Object.fromEntries(
    palette.map((hex, index) => [index + 1, hexToRgb(hex)]),
  );
}

export function getBotColor(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  const key = AGENT_COLOR_ALIASES[normalized] ?? normalized;
  return AGENT_COLORS[key] ?? proceduralAccentForSlug(key);
}

const RESERVED_DYNAMIC_AVATAR_IDS = new Set([
  "hybridCeo",
  "hybridGeneric",
  "hybridHuman",
  "hybridJim",
  "hybridPam",
  "hybridPamCute",
]);

const DYNAMIC_AVATAR_IDS = Object.keys(KNOWN_AVATAR_SPRITES)
  .filter(
    (id) => id.startsWith("hybrid") && !RESERVED_DYNAMIC_AVATAR_IDS.has(id),
  )
  .sort();

const PROCEDURAL_ACCENTS = [
  "#E8A838",
  "#58A6FF",
  "#A371F7",
  "#3FB950",
  "#D2A8FF",
  "#F778BA",
  "#FFA657",
  "#79C0FF",
  "#FF7B72",
  "#56D4DD",
  "#FFD866",
  "#C9D1D9",
];

const PORTRAIT_SPRITE_ALIASES: Record<string, string> = {
  jim: "office20",
  halpert: "office20",
  "jim-halpert": "office20",
  // Pam's wiki contributions are authored under the "archivist" git identity,
  // so her bylines/audit/edit-log surface with slug "archivist" rather than
  // "pam". Map both that identity and the "librarian" label onto the exact
  // sprite the desk avatar uses (slug "pam" → hybridPam) so Pam wears one face
  // everywhere, not a procedural fallback.
  archivist: "hybridPam",
  librarian: "hybridPam",
};

function hashSlug(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick(hash: number, salt: number, modulo: number): number {
  let h = hash ^ (salt * 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % modulo;
}

function proceduralAccentForSlug(slug: string): string {
  const hash = hashSlug(slug || "unknown");
  return (
    PROCEDURAL_ACCENTS[pick(hash, 9, PROCEDURAL_ACCENTS.length)] ?? "#56D4DD"
  );
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isSkinLike([r, g, b]: Rgb): boolean {
  return r >= 120 && g >= 70 && b <= 190 && r >= g && g >= b;
}

function blend(a: Rgb, b: Rgb, amount: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

function buildProceduralOfficePortrait(slug: string): KnownAvatarSprite {
  const hash = hashSlug(slug || "unknown");
  const ids =
    DYNAMIC_AVATAR_IDS.length > 0 ? DYNAMIC_AVATAR_IDS : ["hybridGeneric"];
  const baseID = ids[pick(hash, 8, ids.length)];
  const base =
    KNOWN_AVATAR_SPRITES[baseID] ??
    KNOWN_AVATAR_SPRITES.hybridGeneric ??
    Object.values(KNOWN_AVATAR_SPRITES)[0];
  if (!base) {
    throw new Error("avatar sprite catalog is empty");
  }

  const accent = hexToRgb(proceduralAccentForSlug(slug));
  const tintStrength = 0.22 + pick(hash, 10, 18) / 100;
  const palette = base.palette.map((hex) => {
    const rgb = hexToRgb(hex);
    if (luminance(rgb) < 38 || isSkinLike(rgb)) {
      return hex;
    }
    return rgbToHex(blend(rgb, accent, tintStrength));
  });

  return {
    ...base,
    id: `procedural:${slug || "unknown"}:${base.id}`,
    palette,
  };
}

export function resolvePortraitSprite(slug: string): KnownAvatarSprite {
  const normalized = slug.trim().toLowerCase();
  const portraitID = PORTRAIT_SPRITE_ALIASES[normalized];
  const portrait = portraitID ? KNOWN_AVATAR_SPRITES[portraitID] : undefined;
  if (portrait) return portrait;

  const known = resolveKnownPortraitSprite(normalized);
  if (known) return known;

  return buildProceduralOfficePortrait(normalized);
}

export function paintPixelAvatarData(
  data: Uint8ClampedArray,
  sprite: readonly (readonly number[])[],
  palette: Record<number, Rgb>,
  cols: number,
): void {
  for (let r = 0; r < sprite.length; r++) {
    for (let c = 0; c < cols; c++) {
      const px = sprite[r]?.[c] ?? 0;
      const idx = (r * cols + c) * 4;
      if (px === 0) {
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 0;
        continue;
      }

      const rgb = palette[px] ?? ([128, 128, 128] as const);
      data[idx] = rgb[0];
      data[idx + 1] = rgb[1];
      data[idx + 2] = rgb[2];
      data[idx + 3] = 255;
    }
  }
}

/** Write one RGBA pixel. `null` means fully transparent. */
function writePixel(
  data: Uint8ClampedArray,
  index: number,
  rgb: Rgb | null,
): void {
  data[index] = rgb ? rgb[0] : 0;
  data[index + 1] = rgb ? rgb[1] : 0;
  data[index + 2] = rgb ? rgb[2] : 0;
  data[index + 3] = rgb ? 255 : 0;
}

/** Fill the `scale` x `scale` block that one sprite cell expands into. */
function fillCellBlock(
  data: Uint8ClampedArray,
  width: number,
  cellX: number,
  cellY: number,
  scale: number,
  rgb: Rgb | null,
): void {
  for (let dy = 0; dy < scale; dy++) {
    const rowStart = (cellY * scale + dy) * width + cellX * scale;
    for (let dx = 0; dx < scale; dx++) {
      writePixel(data, (rowStart + dx) * 4, rgb);
    }
  }
}

/**
 * Paint the sprite into a buffer that is `scale` times larger on each axis,
 * nearest-neighbour. `scale === 1` is the plain native-resolution path.
 */
function paintScaledAvatarData(
  data: Uint8ClampedArray,
  sprite: readonly (readonly number[])[],
  palette: Record<number, Rgb>,
  cols: number,
  rows: number,
  scale: number,
): void {
  const width = cols * scale;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = sprite[r]?.[c] ?? 0;
      const rgb = px === 0 ? null : (palette[px] ?? ([128, 128, 128] as const));
      fillCellBlock(data, width, c, r, scale, rgb);
    }
  }
}

/**
 * Stamp hollow gawk eyes over an already-painted supersampled buffer.
 *
 * The original eye pixel is erased first, using skin sampled from the cell
 * directly below it, because a hollow ring drawn straight over the existing
 * dark eye would show that eye through the hole and read as a pupil. The
 * whole point of the mark is that there is nobody home.
 *
 * Rings are filled as whole rectangles in supersampled space rather than
 * per-row, so the border cannot alias into a seam when the canvas is scaled
 * back down by CSS.
 */
interface EyeRing {
  x0: number;
  y0: number;
  w: number;
  h: number;
  border: number;
}

/** Draw one hollow ring: `colour` on the border, `fill` through the hole. */
function drawEyeRing(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  ring: EyeRing,
  colour: Rgb,
  fill: Rgb | null,
): void {
  const { x0, y0, w, h, border } = ring;
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
    const onVerticalEdge = y < y0 + border || y >= y0 + h - border;
    for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
      const onEdge = onVerticalEdge || x < x0 + border || x >= x0 + w - border;
      writePixel(data, (y * width + x) * 4, onEdge ? colour : fill);
    }
  }
}

function stampGawkEyes(
  data: Uint8ClampedArray,
  sprite: readonly (readonly number[])[],
  palette: Record<number, Rgb>,
  cols: number,
  rows: number,
  scale: number,
  eyeCells: readonly (readonly [number, number])[],
  colour: Rgb,
  openness: number,
): void {
  const width = cols * scale;
  const height = rows * scale;
  const border = Math.max(1, Math.round(scale / 3));
  const clamped = Math.min(1, Math.max(EYE_OPENNESS_MIN, openness));
  const w = Math.max(3, Math.round(scale * EYE_WIDTH_CELLS));
  const h = Math.max(3, Math.round(scale * EYE_HEIGHT_CELLS * clamped));

  for (const [cx, cy] of eyeCells) {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;

    // Skin to erase with: the cheek directly below the eye. Falls back to the
    // eye's own cell so a sprite whose eye sits on the bottom row still works.
    const belowIdx = sprite[cy + 1]?.[cx] ?? sprite[cy]?.[cx] ?? 0;
    const skin = belowIdx === 0 ? null : (palette[belowIdx] ?? null);

    drawEyeRing(
      data,
      width,
      height,
      {
        x0: cx * scale + Math.floor(scale / 2) - Math.floor(w / 2),
        y0: cy * scale + Math.floor(scale / 2) - Math.floor(h / 2),
        w,
        h,
        border,
      },
      colour,
      skin,
    );
  }
}

export interface PixelAvatarOptions {
  /**
   * Draw the hollow gawk eyes. Defaults to `size >= EYES_MIN_SIZE`; below that
   * the ring is illegible and the portrait is left alone.
   */
  eyes?: boolean;
  /** 1 is wide open, EYE_OPENNESS_MIN is fully narrowed. Only used with eyes. */
  openness?: number;
}

/**
 * Paint a pixel-art bot avatar into an existing canvas element.
 * Known bots render from the generated avatar catalog; everything else gets
 * a deterministic generated office portrait.
 */
export function drawPixelAvatar(
  canvas: HTMLCanvasElement,
  slug: string,
  size: number,
  options: PixelAvatarOptions = {},
): void {
  const avatar = resolvePortraitSprite(slug);
  drawPixelAvatarSprite(canvas, avatar, size, getBotEyeColor(slug), options);
}

export function drawKnownPixelAvatar(
  canvas: HTMLCanvasElement,
  spriteID: string,
  size: number,
  options: PixelAvatarOptions = {},
): void {
  const avatar = KNOWN_AVATAR_SPRITES[spriteID];
  if (!avatar) return;

  drawPixelAvatarSprite(
    canvas,
    avatar,
    size,
    getBotEyeColor(spriteID),
    options,
  );
}

/**
 * Procedural sprites carry an id of `procedural:<slug>:<baseSpriteId>`; the
 * eye table is keyed by the underlying base sprite, so take the last segment.
 */
export function baseSpriteID(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1] ?? id;
}

function drawPixelAvatarSprite(
  canvas: HTMLCanvasElement,
  avatar: KnownAvatarSprite,
  size: number,
  eyeColour: string,
  options: PixelAvatarOptions,
): void {
  const sprite = avatar.portrait;
  const palette = paletteFromHexes(avatar.palette);

  const rows = sprite.length;
  const cols = sprite[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return;

  const eyeCells = SPRITE_EYE_CELLS[baseSpriteID(avatar.id)];
  const wantEyes = (options.eyes ?? size >= EYES_MIN_SIZE) && !!eyeCells;
  // Only pay for the bigger backing buffer when eyes are actually drawn.
  const scale = wantEyes ? EYE_SUPERSAMPLE : 1;

  canvas.width = cols * scale;
  canvas.height = rows * scale;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${(size * rows) / cols}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const imgData = ctx.createImageData(cols * scale, rows * scale);
  if (scale === 1) {
    paintPixelAvatarData(imgData.data, sprite, palette, cols);
  } else {
    paintScaledAvatarData(imgData.data, sprite, palette, cols, rows, scale);
  }
  if (wantEyes && eyeCells) {
    stampGawkEyes(
      imgData.data,
      sprite,
      palette,
      cols,
      rows,
      scale,
      eyeCells,
      hexToRgb(eyeColour),
      options.openness ?? 1,
    );
  }
  ctx.putImageData(imgData, 0, 0);
}
