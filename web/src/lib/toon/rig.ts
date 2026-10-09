// rig.ts — draws one toon character from a pose, every frame, the way a
// 1930s studio would have inked and painted it.
//
// The character is one of the cast (cast.ts: a lemon, a cloud, a bedsheet
// ghost...) painted flat in cel colours, with a heavy brown-black ink line
// that is thicker on the lower right than the upper left, as a brush is.
// On that object sits the face of the era: two tall eyes close together,
// big black pie-cut pupils, heavy lids, thick brows, a ball nose with a
// shine, and a mouth that can grin with a full row of teeth, gasp, or grit
// them. Rubber-hose arms and legs with no elbows or knees, white
// four-finger gloves, bulbous shoes. No gradients, no gloss, no blush.
//
// It is 2.5D the way those cartoons were: the face slides across the
// object as the head turns and the far eye narrows, so it reads as a thing
// turning, not a sticker. A boil filter (reseeded on twos by Toon) makes
// every line wobble like a drawing redrawn each frame.
//
// Units: the body sits in the cast's 200-unit box. The rig owns its <svg>;
// the svg's viewBox has room around the body for arms, legs and effects
// (VIEW), or just the body for a head-only mark (markView). Everything is
// set as attributes on elements built once.

import type { AvatarShape } from "../../api/memberTypes";
import { type Body, CAST, type Part, type Tone } from "./cast";
import { type GlovePose, gloveMarkup } from "./glove";
import { type Paint, paintFor } from "./paint";

const NS = "http://www.w3.org/2000/svg";

/** The rig's drawing box, in body units: room for arms up and legs down. */
export const VIEW = { x: -100, y: -120, w: 400, h: 400 } as const;

/** How far below the body the feet stand, in body units. */
export const LEG = 44;

/** The drawing box for a head-only mark: the body, a little air. */
export function markView(body: AvatarShape): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const [x, y, w, h] = (CAST[body] ?? CAST.bear).box;
  const m = Math.max(w, h) + 16;
  return { x: x + w / 2 - m / 2, y: y + h / 2 - m / 2, w: m, h: m };
}

/** Everything a frame needs. Numbers tween; gloves switch. */
export interface Pose {
  /** Root offset, rotation (deg) and squash about the feet. */
  x: number;
  y: number;
  rot: number;
  sx: number;
  sy: number;
  /** The body's height above its feet (the legs stretch to reach). */
  lift: number;
  /** Head turn, -1..1 each: the face slides over the object. */
  yaw: number;
  pitch: number;
  /** Pupils inside the whites, -1..1. */
  lookX: number;
  lookY: number;
  eyeScale: number;
  /** Upper lids, 0 open to 1 shut; tilt -1 sad (outer corners down) to 1 cross. */
  lid: number;
  lidTilt: number;
  /** Lower lids up, 0..1: a happy squint. */
  lidLow: number;
  /** Brows: raise -1..1, tilt -1 worried to 1 cross. */
  brow: number;
  browTilt: number;
  /** Mouth: open 0..1, smile -1..1, width ~0.6..1.6, gritted teeth 0..1. */
  mouthOpen: number;
  smile: number;
  mouthW: number;
  grit: number;
  /** Kept for callers; the era painted no blush. */
  blush: number;
  /** Hands, relative to each shoulder; bend of the hose; extra glove turn. */
  armLx: number;
  armLy: number;
  armLbend: number;
  armLrot: number;
  armRx: number;
  armRy: number;
  armRbend: number;
  armRrot: number;
  /** Feet, relative to where they stand at rest; lifted off the ground by y. */
  legLx: number;
  legLy: number;
  legRx: number;
  legRy: number;
  /** Legs shown 0..1 (they tuck up into the body). */
  legs: number;
}

export type PoseKey = keyof Pose;

export const REST: Pose = {
  x: 0,
  y: 0,
  rot: 0,
  sx: 1,
  sy: 1,
  lift: 0,
  yaw: 0,
  pitch: 0,
  lookX: 0,
  lookY: 0,
  eyeScale: 1,
  lid: 0,
  lidTilt: 0,
  lidLow: 0,
  brow: 0,
  browTilt: 0,
  mouthOpen: 0,
  smile: 0.6,
  mouthW: 1,
  grit: 0,
  blush: 0,
  armLx: -22,
  armLy: 44,
  armLbend: 0.5,
  armLrot: 0,
  armRx: 22,
  armRy: 44,
  armRbend: -0.5,
  armRrot: 0,
  legLx: 0,
  legLy: 0,
  legRx: 0,
  legRy: 0,
  legs: 1,
};

export interface RigOptions {
  body: AvatarShape;
  color: string;
  /** Arms and gloves. Off for list-size marks. */
  arms?: boolean;
  /** Legs and shoes (a floating body never has them). */
  legs?: boolean;
  /** Hand-drawn line boil: the outline wobbles a little, on twos. */
  boil?: boolean;
  /** Draw into this <svg> instead of making one (React-owned marks). */
  svg?: SVGSVGElement;
}

let uid = 0;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

const f = (n: number) => Math.round(n * 100) / 100;

/** The outline weight, in body units. */
const LINE = 6.4;
/** How far the paint sits up-left of the ink, so the line swells lower right. */
const BRUSH = 1.4;

/** A pie-cut pupil: an oval with a wedge out of its upper right. */
function piePath(cx: number, cy: number, rx: number, ry: number): string {
  const a0 = (-78 * Math.PI) / 180;
  const a1 = (-18 * Math.PI) / 180;
  const p = (a: number) =>
    `${f(cx + Math.cos(a) * rx)} ${f(cy + Math.sin(a) * ry)}`;
  return `M${f(cx + rx * 0.08)} ${f(cy - ry * 0.12)} L${p(a1)} A${f(rx)} ${f(ry)} 0 1 1 ${p(a0)} Z`;
}

/** A teardrop, point up, centred on its round end. */
export function dropPath(x: number, y: number, r: number): string {
  return `M${f(x)} ${f(y - r * 2.2)} C${f(x + r * 0.4)} ${f(y - r * 1.2)} ${f(x + r)} ${f(y - r * 0.6)} ${f(x + r)} ${f(y)} A${f(r)} ${f(r)} 0 0 1 ${f(x - r)} ${f(y)} C${f(x - r)} ${f(y - r * 0.6)} ${f(x - r * 0.4)} ${f(y - r * 1.2)} ${f(x)} ${f(y - r * 2.2)} Z`;
}

/** A four-point cartoon twinkle. */
export function starPath(x: number, y: number, r: number): string {
  const i = r * 0.32;
  return `M${f(x)} ${f(y - r)} Q${f(x + i * 0.4)} ${f(y - i * 0.4)} ${f(x + r)} ${f(y)} Q${f(x + i * 0.4)} ${f(y + i * 0.4)} ${f(x)} ${f(y + r)} Q${f(x - i * 0.4)} ${f(y + i * 0.4)} ${f(x - r)} ${f(y)} Q${f(x - i * 0.4)} ${f(y - i * 0.4)} ${f(x)} ${f(y - r)} Z`;
}

type Mat = [number, number, number, number, number, number];

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

interface Eye {
  white: SVGEllipseElement;
  pupil: SVGPathElement;
  lid: SVGPathElement;
  lidEdge: SVGPathElement;
  low: SVGPathElement;
  lowEdge: SVGPathElement;
  clip: SVGEllipseElement;
  rim: SVGEllipseElement;
  brow: SVGPathElement;
}

interface Arm {
  hose: SVGPathElement;
  glove: SVGGElement;
  pose: GlovePose | null;
}

interface Leg {
  hose: SVGPathElement;
  shoe: SVGGElement;
}

/** A classic bulbous shoe, toe pointing to `s` (-1 left, 1 right). */
function shoeMarkup(s: number, P: Paint): string {
  const d = `M${-9 * s} -2 C${-13 * s} -14 ${4 * s} -21 ${20 * s} -16 C${31 * s} -12 ${33 * s} -2 ${22 * s} 1 L${-7 * s} 1 Z`;
  return (
    `<path d="${d}" fill="${P.ink}" stroke="${P.ink}" stroke-width="${LINE * 0.8}" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="${P.shoe}" transform="translate(${-BRUSH * 0.8 * s} ${-BRUSH * 0.9})"/>` +
    `<path d="M${-2 * s} -15 q${9 * s} -3 ${15 * s} 0" fill="none" stroke="${P.cream}" stroke-width="2.2" stroke-linecap="round" opacity="0.85"/>`
  );
}

function toneOf(P: Paint, t: Tone): string {
  switch (t) {
    case "base":
      return P.base;
    case "tint":
      return P.tint;
    case "cream":
      return P.cream;
    case "shade":
      return P.shade;
    case "leaf":
      return P.leaf;
    default:
      return P.ink;
  }
}

export class ToonRig {
  readonly svg: SVGSVGElement;
  readonly paint: Paint;
  /** Effects (sweat, stars, puffs) in rig units, above the character. */
  readonly fx: SVGGElement;
  /** The body's bounding box [x, y, w, h] in body units. */
  readonly box: readonly [number, number, number, number];
  readonly body: Body;
  private readonly id: string;
  private readonly root: SVGGElement;
  private readonly faceG: SVGGElement;
  private readonly eyes: [Eye, Eye];
  private readonly nose: SVGGElement | null;
  private readonly mouthLine: SVGPathElement;
  private readonly mouthFill: SVGPathElement;
  private readonly teeth: SVGPathElement;
  private readonly teethLines: SVGPathElement;
  private readonly tongue: SVGEllipseElement;
  private readonly arms: [Arm, Arm] | null;
  private readonly legs: [Leg, Leg] | null;
  private readonly shadow: SVGEllipseElement;
  private readonly turb: SVGFETurbulenceElement | null = null;
  private gloves: [GlovePose, GlovePose] = ["open", "open"];

  constructor(opts: RigOptions) {
    this.id = `toon${++uid}`;
    const body = CAST[opts.body] ?? CAST.bear;
    this.body = body;
    this.box = body.box;
    this.paint = paintFor(opts.color);
    const P = this.paint;
    const id = this.id;
    const hasArms = opts.arms !== false;
    const hasLegs = !!opts.legs && !body.floats;
    const mark = !(hasArms || opts.legs);
    const v = mark ? markView(opts.body) : VIEW;

    const svg = opts.svg ?? el("svg", { "aria-hidden": "true" });
    svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    svg.setAttribute("overflow", "visible");
    this.svg = svg;
    const defs = el("defs", {}, svg);

    let filterAttr: Record<string, string> = {};
    if (opts.boil) {
      const filt = el(
        "filter",
        {
          id: `${id}-boil`,
          x: "-20%",
          y: "-20%",
          width: "140%",
          height: "140%",
        },
        defs,
      );
      this.turb = el(
        "feTurbulence",
        {
          type: "fractalNoise",
          baseFrequency: "0.028",
          numOctaves: 1,
          seed: 1,
          result: "n",
        },
        filt,
      );
      el(
        "feDisplacementMap",
        {
          in: "SourceGraphic",
          in2: "n",
          scale: 3.2,
          xChannelSelector: "R",
          yChannelSelector: "G",
        },
        filt,
      );
      filterAttr = { filter: `url(#${id}-boil)` };
    }

    const [bx, by, bw, bh] = this.box;
    const bottom = by + bh;
    this.shadow = el(
      "ellipse",
      {
        cx: bx + bw / 2,
        cy: bottom + (hasLegs ? LEG : 10) + 6,
        rx: bw * 0.34,
        ry: 6,
        fill: P.ink,
        opacity: 0.18,
      },
      svg,
    );

    const ink = el("g", { class: "toon-ink", ...filterAttr }, svg);
    this.root = el("g", {}, ink);

    // Legs and the arms' hoses go behind the body; gloves in front of it.
    if (hasLegs) {
      const mk = (): Leg => ({
        hose: el(
          "path",
          {
            fill: "none",
            stroke: P.ink,
            "stroke-width": 8.5,
            "stroke-linecap": "round",
          },
          this.root,
        ),
        shoe: el("g", {}, this.root),
      });
      this.legs = [mk(), mk()];
      for (const [i, leg] of this.legs.entries()) {
        leg.shoe.innerHTML = shoeMarkup(i === 0 ? -1 : 1, P);
      }
    } else {
      this.legs = null;
    }
    const hoses = el("g", {}, this.root);

    // The object, back to front, inked then painted.
    const bodyG = el("g", { class: "toon-object" }, this.root);
    let main = true;
    for (const part of body.parts) {
      this.part(bodyG, part, main && part.tone !== "ink");
      if (part.tone !== "ink") main = false;
    }

    // The face.
    this.faceG = el("g", {}, this.root);
    const skin = toneOf(P, body.face.skin);
    const mkEye = (n: number): Eye => {
      const clipId = `${id}-eye${n}`;
      const clip = el("ellipse", {}, el("clipPath", { id: clipId }, defs));
      const white = el(
        "ellipse",
        { class: "toon-eye", fill: P.cream },
        this.faceG,
      );
      const inner = el("g", { "clip-path": `url(#${clipId})` }, this.faceG);
      const pupil = el("path", { fill: P.ink }, inner);
      const lid = el("path", { fill: skin }, inner);
      const low = el("path", { fill: skin }, inner);
      const edge = {
        fill: "none",
        stroke: P.ink,
        "stroke-width": 3.4,
        "stroke-linecap": "round",
      };
      const lidEdge = el("path", edge, inner);
      const lowEdge = el("path", edge, inner);
      const rim = el(
        "ellipse",
        { fill: "none", stroke: P.ink, "stroke-width": 3.4 },
        this.faceG,
      );
      const brow = el(
        "path",
        {
          fill: "none",
          stroke: P.ink,
          "stroke-width": 5.4,
          "stroke-linecap": "round",
        },
        this.faceG,
      );
      return { white, pupil, lid, lidEdge, low, lowEdge, clip, rim, brow };
    };
    this.eyes = [mkEye(0), mkEye(1)];
    if (body.face.nose) {
      this.nose = el("g", {}, this.faceG);
      this.nose.innerHTML =
        `<ellipse rx="8" ry="6.4" fill="${P.ink}"/>` +
        `<ellipse cx="-2.6" cy="-2.2" rx="2.3" ry="1.6" fill="${P.cream}"/>`;
    } else {
      this.nose = null;
    }
    this.mouthFill = el("path", { fill: P.mouth }, this.faceG);
    this.tongue = el("ellipse", { fill: P.tongue }, this.faceG);
    this.teeth = el("path", { fill: P.cream }, this.faceG);
    this.teethLines = el(
      "path",
      {
        fill: "none",
        stroke: P.ink,
        "stroke-width": 2,
        "stroke-linecap": "round",
      },
      this.faceG,
    );
    this.mouthLine = el(
      "path",
      {
        class: "toon-mouth",
        fill: "none",
        stroke: P.ink,
        "stroke-width": 4.2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      this.faceG,
    );

    if (hasArms) {
      const mk = (): Arm => ({
        hose: el(
          "path",
          {
            fill: "none",
            stroke: P.ink,
            "stroke-width": 8,
            "stroke-linecap": "round",
          },
          hoses,
        ),
        glove: el("g", { class: "toon-glove" }, this.root),
        pose: null,
      });
      this.arms = [mk(), mk()];
    } else {
      this.arms = null;
    }
    this.fx = el("g", {}, svg);
  }

  /** One part of the object: ink pass, then paint sitting a touch up-left. */
  private part(g: SVGGElement, part: Part, main: boolean): void {
    const P = this.paint;
    const w = LINE * (part.weight ?? 1);
    const open = part.tone === "ink" && !part.d.trim().endsWith("Z");
    if (open) {
      el(
        "path",
        {
          d: part.d,
          fill: "none",
          stroke: P.ink,
          "stroke-width": w,
          "stroke-linecap": "round",
        },
        g,
      );
      return;
    }
    if (part.ink !== false) {
      el(
        "path",
        {
          d: part.d,
          fill: P.ink,
          stroke: P.ink,
          "stroke-width": w,
          "stroke-linejoin": "round",
        },
        g,
      );
    }
    const paint: Record<string, string> = {
      d: part.d,
      fill: toneOf(P, part.tone),
    };
    if (main) paint.class = "toon-body";
    if (part.ink !== false) {
      paint.transform = `translate(${-BRUSH} ${-BRUSH * 1.15})`;
    }
    el("path", paint, g);
  }

  /** The glove poses, left then right; applied on the next draw. */
  setGloves(left: GlovePose, right: GlovePose): void {
    this.gloves = [left, right];
  }

  showShadow(on: boolean): void {
    this.shadow.style.display = on ? "" : "none";
  }

  /** A new line-boil frame. */
  boil(seed: number): void {
    this.turb?.setAttribute("seed", String(seed));
  }

  /** Where the feet stand at rest, in rig units. */
  ground(): number {
    return this.box[1] + this.box[3] + (this.legs ? LEG : 0);
  }

  /** The body's root transform for a pose (squash about the feet). */
  private matrix(p: Pose): Mat {
    const [bx, by, bw, bh] = this.box;
    const ax = bx + bw / 2;
    const ay = by + bh;
    const r = (p.rot * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const a = c * p.sx;
    const b = s * p.sx;
    const cc = -s * p.sy;
    const d = c * p.sy;
    const tx = p.x + ax - (a * ax + cc * ay);
    const ty = p.y - p.lift + ay - (b * ax + d * ay);
    return [a, b, cc, d, tx, ty];
  }

  draw(p: Pose): void {
    const [bx, , bw, bh] = this.box;
    const m = this.matrix(p);
    this.root.setAttribute("transform", `matrix(${m.map(f).join(" ")})`);

    const ground = this.ground();
    const lift = Math.max(0, p.lift - p.y);
    this.shadow.setAttribute("cx", String(f(bx + bw / 2 + p.x)));
    this.shadow.setAttribute("cy", String(f(ground + 6)));
    const away = Math.max(0.35, 1 - lift / 160);
    this.shadow.setAttribute("rx", String(f(bw * 0.34 * away)));
    this.shadow.setAttribute("opacity", String(f(0.18 * away)));

    this.drawFace(p, bw, bh);
    this.drawArms(p);
    this.drawLegs(p, m, ground);
  }

  private drawFace(p: Pose, bw: number, bh: number): void {
    const F = this.body.face;
    const fs = F.scale;
    const fcx = F.cx + p.yaw * bw * 0.16;
    const fcy = F.cy + p.pitch * bh * 0.06;
    const es = p.eyeScale;
    const rx = 15.5 * fs * es;
    const ry = 23 * fs * es;
    for (const [i, e] of this.eyes.entries()) {
      const side = i === 0 ? -1 : 1;
      // The eye round the curve, on the side the head turns toward, narrows.
      const far = 1 - Math.max(0, p.yaw * side) * 0.3;
      const ex = fcx + side * 16.5 * fs * es * (1 - Math.abs(p.yaw) * 0.14);
      const ey = fcy;
      const erx = rx * far;
      for (const ell of [e.white, e.clip, e.rim]) {
        ell.setAttribute("cx", String(f(ex)));
        ell.setAttribute("cy", String(f(ey)));
        ell.setAttribute("rx", String(f(erx)));
        ell.setAttribute("ry", String(f(ry)));
      }
      const px = ex + (p.lookX * 0.5 + p.yaw * 0.3) * erx;
      const py = ey + (p.lookY * 0.4 + p.pitch * 0.2) * ry + ry * 0.1;
      e.pupil.setAttribute("d", piePath(px, py, erx * 0.6, ry * 0.6));
      // Upper lid: the skin comes down over the white, inked along its edge.
      const top = ey - ry - 2;
      const edge = ey - ry + 2 * ry * Math.min(1, p.lid);
      const tilt = p.lidTilt * ry * 0.45 * side;
      const lidOn = p.lid > 0.02 || Math.abs(p.lidTilt) > 0.05 ? "1" : "0";
      e.lid.setAttribute("opacity", lidOn);
      e.lidEdge.setAttribute("opacity", lidOn);
      const lidCurve = `Q${f(ex)} ${f(edge + ry * 0.14)} ${f(ex - erx - 3)} ${f(edge - tilt)}`;
      e.lid.setAttribute(
        "d",
        `M${f(ex - erx - 3)} ${f(top - 4)} L${f(ex + erx + 3)} ${f(top - 4)} L${f(ex + erx + 3)} ${f(edge + tilt)} ${lidCurve} Z`,
      );
      e.lidEdge.setAttribute(
        "d",
        `M${f(ex + erx + 3)} ${f(edge + tilt)} ${lidCurve}`,
      );
      // Lower lid: a happy squint curves up from below.
      const low = ey + ry - 2 * ry * p.lidLow * 0.62;
      const lowOn = p.lidLow > 0.02 ? "1" : "0";
      e.low.setAttribute("opacity", lowOn);
      e.lowEdge.setAttribute("opacity", lowOn);
      const lowCurve = `M${f(ex - erx - 3)} ${f(low + ry * 0.2)} Q${f(ex)} ${f(low - ry * 0.35 * p.lidLow)} ${f(ex + erx + 3)} ${f(low + ry * 0.2)}`;
      e.low.setAttribute(
        "d",
        `M${f(ex - erx - 3)} ${f(ey + ry + 4)} L${f(ex - erx - 3)} ${f(low + ry * 0.2)} ${lowCurve.slice(lowCurve.indexOf("Q"))} L${f(ex + erx + 3)} ${f(ey + ry + 4)} Z`,
      );
      e.lowEdge.setAttribute("d", lowCurve);
      // Brow: a thick arc; tilt drops the inner end (cross) or the outer (worried).
      const bY = ey - ry - 7 * fs - p.brow * 9 * fs;
      const inner = -p.browTilt * 8 * fs;
      const outer = p.browTilt * 3 * fs;
      const xin = ex - side * erx * 0.7;
      const xout = ex + side * erx * 1.05;
      e.brow.setAttribute(
        "d",
        `M${f(xin)} ${f(bY - inner)} Q${f(ex + side * 2)} ${f(bY - 7 * fs - Math.abs(p.brow) * 2)} ${f(xout)} ${f(bY - outer)}`,
      );
    }

    if (this.nose) {
      this.nose.setAttribute(
        "transform",
        `translate(${f(fcx + p.yaw * 6 * fs)} ${f(fcy + 18 * fs)}) scale(${f(fs)})`,
      );
    }
    this.drawMouth(p, fcx, fcy, fs);
  }

  private drawMouth(p: Pose, fcx: number, fcy: number, fs: number): void {
    const F = this.body.face;
    const mx = fcx + p.yaw * 7 * fs;
    const my = fcy + 38 * fs * (F.mouthDrop ?? 1) + (this.nose ? 2 * fs : 0);
    const mw = 24 * fs * p.mouthW;
    const open = Math.max(0, p.mouthOpen);
    const sm = p.smile;
    this.teethLines.setAttribute("d", "");
    if (p.grit > 0.5) {
      // Gritted teeth: a wide cream bar with a row of lines.
      const h = 14 * fs;
      const w = mw * 1.15;
      const d = `M${f(mx - w)} ${f(my - h / 2)} Q${f(mx)} ${f(my - h / 2 - sm * 3)} ${f(mx + w)} ${f(my - h / 2)} L${f(mx + w)} ${f(my + h / 2)} Q${f(mx)} ${f(my + h / 2 + sm * 3)} ${f(mx - w)} ${f(my + h / 2)} Z`;
      this.mouthFill.setAttribute("d", "");
      this.teeth.setAttribute("d", d);
      this.mouthLine.setAttribute("d", d);
      this.tongue.setAttribute("rx", "0");
      let lines = `M${f(mx - w)} ${f(my)} L${f(mx + w)} ${f(my)}`;
      for (const k of [-0.6, -0.2, 0.2, 0.6]) {
        lines += ` M${f(mx + k * w)} ${f(my - h / 2)} L${f(mx + k * w)} ${f(my + h / 2)}`;
      }
      this.teethLines.setAttribute("d", lines);
      return;
    }
    if (open < 0.06) {
      this.mouthFill.setAttribute("d", "");
      this.teeth.setAttribute("d", "");
      this.tongue.setAttribute("rx", "0");
      const curve = sm * 14 * fs;
      // Little tucks at the corners when it smiles.
      const tuck = Math.max(0, sm) * 4.5 * fs;
      this.mouthLine.setAttribute(
        "d",
        `M${f(mx - mw - tuck)} ${f(my - tuck)} L${f(mx - mw)} ${f(my)} Q${f(mx)} ${f(my + curve * 2)} ${f(mx + mw)} ${f(my)} L${f(mx + mw + tuck)} ${f(my - tuck)}`,
      );
      return;
    }
    const depth = (10 + open * 28) * fs;
    const top = my - Math.max(0, -sm) * 6 * fs;
    const lipY = top + sm * 4 * fs;
    const d = `M${f(mx - mw)} ${f(top)} Q${f(mx)} ${f(lipY)} ${f(mx + mw)} ${f(top)} Q${f(mx + mw * 0.92)} ${f(top + depth)} ${f(mx)} ${f(top + depth + sm * 5 * fs)} Q${f(mx - mw * 0.92)} ${f(top + depth)} ${f(mx - mw)} ${f(top)} Z`;
    this.mouthFill.setAttribute("d", d);
    this.mouthLine.setAttribute("d", d);
    this.tongue.setAttribute("cx", String(f(mx)));
    this.tongue.setAttribute("cy", String(f(top + depth * 0.84)));
    this.tongue.setAttribute("rx", String(f(mw * 0.5)));
    this.tongue.setAttribute("ry", String(f(depth * 0.28)));
    if (sm > 0.15) {
      // A grin shows a full row of teeth along the top lip.
      const th = Math.min(depth * 0.5, 9 * fs);
      this.teeth.setAttribute(
        "d",
        `M${f(mx - mw * 0.96)} ${f(top + 1)} Q${f(mx)} ${f(lipY + 1)} ${f(mx + mw * 0.96)} ${f(top + 1)} Q${f(mx + mw * 0.8)} ${f(top + th)} ${f(mx)} ${f(top + th + sm * 2)} Q${f(mx - mw * 0.8)} ${f(top + th)} ${f(mx - mw * 0.96)} ${f(top + 1)} Z`,
      );
      let lines = "";
      for (const k of [-0.5, 0, 0.5]) {
        lines += ` M${f(mx + k * mw)} ${f(top + 2)} L${f(mx + k * mw)} ${f(top + th * 0.9)}`;
      }
      this.teethLines.setAttribute("d", lines);
    } else {
      this.teeth.setAttribute("d", "");
    }
  }

  private drawArms(p: Pose): void {
    if (!this.arms) return;
    const hands: [number, number, number, number][] = [
      [p.armLx, p.armLy, p.armLbend, p.armLrot],
      [p.armRx, p.armRy, p.armRbend, p.armRrot],
    ];
    for (const [i, arm] of this.arms.entries()) {
      const [sx0, sy0] = this.body.arms[i];
      const [hx, hy, bend, rot] = hands[i];
      const wx = sx0 + hx;
      const wy = sy0 + hy;
      const len = Math.hypot(hx, hy) || 1;
      // A noodle: one smooth bow, no elbow.
      const cx = (sx0 + wx) / 2 + (-hy / len) * bend * len * 0.35;
      const cy = (sy0 + wy) / 2 + (hx / len) * bend * len * 0.35;
      arm.hose.setAttribute(
        "d",
        `M${f(sx0)} ${f(sy0)} Q${f(cx)} ${f(cy)} ${f(wx)} ${f(wy)}`,
      );
      const ang =
        (Math.atan2(wy - cy, wx - cx) * 180) / Math.PI +
        rot * (i === 0 ? -1 : 1);
      const pose = this.gloves[i];
      if (arm.pose !== pose) {
        arm.glove.innerHTML = gloveMarkup(
          pose,
          this.paint.cream,
          this.paint.ink,
        );
        arm.pose = pose;
      }
      const g = 1.5;
      arm.glove.setAttribute(
        "transform",
        `translate(${f(wx)} ${f(wy)}) rotate(${f(ang)}) scale(${f(g)} ${f(i === 0 ? -g : g)})`,
      );
    }
  }

  private drawLegs(p: Pose, m: Mat, ground: number): void {
    if (!this.legs) return;
    const feet: [number, number][] = [
      [this.body.legs[0][0] - 6 + p.legLx + p.x, ground - p.legLy + p.y],
      [this.body.legs[1][0] + 6 + p.legRx + p.x, ground - p.legRy + p.y],
    ];
    const show = p.legs;
    for (const [i, leg] of this.legs.entries()) {
      const side = i === 0 ? -1 : 1;
      const [hx, hy] = apply(m, this.body.legs[i][0], this.body.legs[i][1] - 6);
      // Tucked legs pull the feet up under the body.
      const fx = hx + (feet[i][0] - hx) * show;
      const fy = hy + (feet[i][1] - hy) * show;
      const span = Math.hypot(fx - hx, fy - hy);
      // Slack hose bows outward like a knee; taut hose is straight.
      const slack = Math.max(0, LEG + 4 - span) * 0.9 + 3;
      const cx = (hx + fx) / 2 + side * slack;
      const cy = (hy + fy) / 2;
      leg.hose.setAttribute(
        "d",
        `M${f(hx)} ${f(hy)} Q${f(cx)} ${f(cy)} ${f(fx)} ${f(fy)}`,
      );
      leg.hose.setAttribute("opacity", show > 0.05 ? "1" : "0");
      leg.shoe.setAttribute(
        "transform",
        `translate(${f(fx)} ${f(fy)}) scale(${f(Math.max(0.01, show))})`,
      );
    }
  }
}
