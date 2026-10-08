// blobAvatarSmooth.ts — the blob mark as a smooth vector.
//
// Same character system as blobAvatar.ts, drawn without the pixel grid:
// the SAME silhouette and colour (resolveAvatar: the bot's chosen look, else
// the per-slug blobShapeIndex / blobColor), the
// SAME eye placement (eyeSpec), just traced as a curve. A bot keeps its
// identity across the switch; only the finish changes from pixelled to clean.
//
// How the curve is made: each silhouette is a stack of per-row [from, to)
// spans. We take the left and right edge of every row at the row's centre,
// add the flat top and bottom edges, and run a closed Catmull-Rom spline
// through those points. The eyes are rounded rectangles appended to the same
// path, and the path is filled with `evenodd`, so they are HOLES in the body
// (whatever is behind shows through) exactly as in the pixel version.

import {
  type AvatarChoice,
  BLOB_GRID,
  eyeSpec,
  resolveAvatar,
  SILHOUETTES,
} from "./blobAvatar";

type Point = readonly [number, number];

export interface SmoothBlob {
  /** Body outline plus eye holes, in a 0..BLOB_GRID viewBox. Fill evenodd. */
  readonly d: string;
  /** The body outline alone, without the eye holes (for mask-based renderers). */
  readonly body: string;
  readonly color: string;
  /** Eye boxes, for callers that animate the eyes separately. */
  readonly eyes: readonly { x: number; y: number; w: number; h: number }[];
}

function fmt(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/** Outline points of a silhouette, clockwise from the top-left corner. */
export function silhouetteOutline(index: number): Point[] {
  const shape = SILHOUETTES[index % SILHOUETTES.length];
  const rows: { row: number; from: number; to: number }[] = [];
  shape.forEach(([from, to], row) => {
    if (to > from) rows.push({ row, from, to });
  });
  if (rows.length === 0) return [];
  const [first] = rows;
  const last = rows[rows.length - 1];
  const right = rows.map((r): Point => [r.to, r.row + 0.5]);
  const left = rows.map((r): Point => [r.from, r.row + 0.5]).reverse();
  return [
    [first.from + 0.5, first.row],
    [first.to - 0.5, first.row],
    ...right,
    [last.to - 0.5, last.row + 1],
    [last.from + 0.5, last.row + 1],
    ...left,
  ];
}

/** Drops points that sit on a straight line between their neighbours. */
function simplify(points: Point[]): Point[] {
  if (points.length < 4) return points;
  const out: Point[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[(i - 1 + n) % n];
    const [bx, by] = points[i];
    const [cx, cy] = points[(i + 1) % n];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) > 1e-6) out.push(points[i]);
  }
  return out.length >= 3 ? out : points;
}

/** Closed Catmull-Rom spline through `points`, as cubic Béziers. */
function closedSpline(points: Point[], tension = 0.5): string {
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

function roundedRect(x: number, y: number, w: number, h: number): string {
  const r = Math.min(w, h) / 2;
  return (
    `M${fmt(x + r)} ${fmt(y)}` +
    `H${fmt(x + w - r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x + w)} ${fmt(y + r)}` +
    `V${fmt(y + h - r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x + w - r)} ${fmt(y + h)}` +
    `H${fmt(x + r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x)} ${fmt(y + h - r)}` +
    `V${fmt(y + r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x + r)} ${fmt(y)}Z`
  );
}

const cache = new Map<string, SmoothBlob>();

/**
 * The smooth mark for `slug`. openness: 1 wide open, 0 narrowed. `avatar` is
 * the bot's chosen look; its unset fields fall back to the slug's own.
 */
export function smoothBlob(
  slug: string,
  openness = 1,
  avatar?: AvatarChoice | null,
): SmoothBlob {
  const o = Math.round(Math.min(1, Math.max(0, openness)) * 20) / 20;
  const { shapeIndex, color } = resolveAvatar(slug, avatar);
  // Keyed on the resolved look, not the slug: the mark is a pure function of
  // shape, colour and openness, so bots sharing a look share an entry.
  const key = `${shapeIndex}|${color}|${o}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const body = closedSpline(simplify(silhouetteOutline(shapeIndex)));
  const spec = eyeSpec(o);
  // Smooth eyes read a touch narrower than the pixel cells they replace.
  const eyes = [spec.leftX, spec.rightX].map((x) => ({
    x: x + 0.1,
    y: spec.topY,
    w: spec.width - 0.2,
    h: spec.height,
  }));
  const blob: SmoothBlob = {
    d: body + eyes.map((e) => roundedRect(e.x, e.y, e.w, e.h)).join(""),
    body,
    color,
    eyes,
  };
  cache.set(key, blob);
  return blob;
}

export { BLOB_GRID };
