// rig.ts — draws one toon character from a pose, every frame.
//
// The character is a bot's own body (bodies.gen.ts: the avatar outline it
// has everywhere else) drawn the way a 1930s cartoon would draw it: a heavy
// brown-black ink line, flat paint with one hard-edged shadow and an
// airbrushed light, a shine, pie-cut eyes in big whites with lids and
// brows, a mouth that can grin, gasp or grit its teeth, rubber-hose arms
// and legs with no elbows or knees, white gloves and big shoes.
//
// It is 2.5D, the way those cartoons were: the face slides across the body
// as the head turns, the far eye narrows, the shine moves the other way and
// the shadow side stays put, so the body reads as a ball, not a sticker.
//
// Units: the body sits in the core's 200-unit box (BODY_OUTLINES). The rig
// owns its <svg>; the svg's viewBox has room around the body for arms, legs
// and effects (VIEW). Everything is set as attributes on elements built
// once, so a frame is a few dozen attribute writes.

import type { AvatarShape } from "../../api/memberTypes";
import { BODY_OUTLINES } from "./bodies.gen";
import { type GlovePose, gloveMarkup } from "./glove";
import { type Paint, paintFor } from "./paint";

const NS = "http://www.w3.org/2000/svg";

/** The rig's drawing box, in body units: room for arms up and legs down. */
export const VIEW = { x: -100, y: -120, w: 400, h: 400 } as const;

/** How far below the body the feet stand, in body units. */
export const LEG = 46;

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
  /** Head turn, -1..1 each: the face slides over the ball. */
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
  blush: 0.5,
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
  /** Legs and shoes. */
  legs?: boolean;
  /** Hand-drawn line boil: the outline wobbles a little, a few times a second. */
  boil?: boolean;
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

/** A pie-cut pupil: an ellipse with a wedge out of its upper right. */
function piePath(cx: number, cy: number, rx: number, ry: number): string {
  const a0 = (-80 * Math.PI) / 180;
  const a1 = (-28 * Math.PI) / 180;
  const p = (a: number) =>
    `${f(cx + Math.cos(a) * rx)} ${f(cy + Math.sin(a) * ry)}`;
  // From the wedge's tip at the centre, out along one edge, the long way
  // round the ellipse, and back in along the other edge.
  return `M${f(cx + rx * 0.12)} ${f(cy - ry * 0.18)} L${p(a1)} A${f(rx)} ${f(ry)} 0 1 1 ${p(a0)} Z`;
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
  shine: SVGCircleElement;
  lid: SVGPathElement;
  low: SVGPathElement;
  lidEdge: SVGPathElement;
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

export class ToonRig {
  readonly svg: SVGSVGElement;
  readonly paint: Paint;
  /** Effects (sweat, stars, puffs) in rig units, above the character. */
  readonly fx: SVGGElement;
  readonly box: readonly [number, number, number, number];
  private readonly id: string;
  private readonly bodyG: SVGGElement;
  private readonly faceG: SVGGElement;
  private readonly gloss: SVGGElement;
  private readonly eyes: [Eye, Eye];
  private readonly cheeks: [SVGEllipseElement, SVGEllipseElement];
  private readonly mouthLine: SVGPathElement;
  private readonly mouthFill: SVGPathElement;
  private readonly tongue: SVGEllipseElement;
  private readonly teeth: SVGGElement;
  private readonly arms: [Arm, Arm] | null;
  private readonly legs: [Leg, Leg] | null;
  private readonly shadow: SVGEllipseElement;
  private readonly turb: SVGFETurbulenceElement | null = null;
  private gloves: [GlovePose, GlovePose] = ["open", "open"];

  constructor(opts: RigOptions) {
    this.id = `toon${++uid}`;
    const outline = BODY_OUTLINES[opts.body] ?? BODY_OUTLINES.bear;
    this.box = outline.box;
    this.paint = paintFor(opts.color);
    const P = this.paint;
    const id = this.id;

    const svg = el("svg", {
      viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`,
      "aria-hidden": "true",
      overflow: "visible",
    });
    this.svg = svg;
    const defs = el("defs", {}, svg);
    el(
      "path",
      { id: `${id}-b`, d: outline.d },
      el("clipPath", { id: `${id}-clip` }, defs),
    );
    const air = el(
      "radialGradient",
      { id: `${id}-air`, cx: "0.34", cy: "0.26", r: "0.62" },
      defs,
    );
    el(
      "stop",
      { offset: "0", "stop-color": P.light, "stop-opacity": 0.95 },
      air,
    );
    el(
      "stop",
      { offset: "0.55", "stop-color": P.light, "stop-opacity": 0.18 },
      air,
    );
    el("stop", { offset: "1", "stop-color": P.light, "stop-opacity": 0 }, air);

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
          baseFrequency: "0.035",
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
          scale: 2.2,
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
        cy: bottom + LEG + 6,
        rx: bw * 0.36,
        ry: 7,
        fill: P.ink,
        opacity: 0.2,
      },
      svg,
    );

    const ink = el("g", filterAttr, svg);
    // Legs and the arms' hoses go behind the body; gloves in front of it.
    if (opts.legs) {
      const mk = (): Leg => ({
        hose: el(
          "path",
          {
            fill: "none",
            stroke: P.ink,
            "stroke-width": 8,
            "stroke-linecap": "round",
          },
          ink,
        ),
        shoe: el("g", {}, ink),
      });
      this.legs = [mk(), mk()];
      for (const [i, leg] of this.legs.entries()) {
        const s = i === 0 ? -1 : 1;
        leg.shoe.innerHTML =
          `<path d="M${-6 * s} -2 C${-8 * s} -16 ${10 * s} -19 ${24 * s} -12 C${32 * s} -8 ${30 * s} 2 ${18 * s} 2 Z" fill="${P.shoe}" stroke="${P.ink}" stroke-width="3" stroke-linejoin="round"/>` +
          `<path d="M${8 * s} -14 q${8 * s} -1 ${13 * s} 3" fill="none" stroke="${P.white}" stroke-width="2.6" stroke-linecap="round" opacity="0.75"/>`;
      }
    } else {
      this.legs = null;
    }
    const hoses = el("g", {}, ink);

    this.bodyG = el("g", {}, ink);
    const paintG = el("g", { "clip-path": `url(#${id}-clip)` }, this.bodyG);
    el(
      "rect",
      {
        x: bx - 20,
        y: by - 20,
        width: bw + 40,
        height: bh + 40,
        fill: P.shade,
      },
      paintG,
    );
    // The lit side: the body shifted up-left over its own shadow colour
    // leaves a hard crescent of shadow on the lower right.
    el(
      "use",
      {
        href: `#${id}-b`,
        fill: P.base,
        transform: `translate(${-bw * 0.06} ${-bh * 0.07})`,
      },
      paintG,
    );
    el(
      "rect",
      {
        x: bx - 20,
        y: by - 20,
        width: bw + 40,
        height: bh + 40,
        fill: `url(#${id}-air)`,
      },
      paintG,
    );
    this.gloss = el("g", {}, paintG);
    el(
      "ellipse",
      {
        cx: bx + bw * 0.27,
        cy: by + bh * 0.2,
        rx: bw * 0.085,
        ry: bh * 0.042,
        fill: P.white,
        opacity: 0.92,
        transform: `rotate(-38 ${bx + bw * 0.27} ${by + bh * 0.2})`,
      },
      this.gloss,
    );
    el(
      "circle",
      {
        cx: bx + bw * 0.17,
        cy: by + bh * 0.3,
        r: bw * 0.022,
        fill: P.white,
        opacity: 0.85,
      },
      this.gloss,
    );

    this.faceG = el("g", {}, paintG);
    this.cheeks = [
      el("ellipse", { fill: P.blush }, this.faceG),
      el("ellipse", { fill: P.blush }, this.faceG),
    ];
    const mkEye = (n: number): Eye => {
      const clipId = `${id}-eye${n}`;
      const clip = el("ellipse", {}, el("clipPath", { id: clipId }, defs));
      const white = el("ellipse", { fill: P.white }, this.faceG);
      const inner = el("g", { "clip-path": `url(#${clipId})` }, this.faceG);
      const pupil = el("path", { fill: P.ink }, inner);
      const shine = el("circle", { fill: P.white, opacity: 0.9 }, inner);
      const lid = el("path", { fill: P.lid }, inner);
      const low = el("path", { fill: P.lid }, inner);
      const edge = {
        fill: "none",
        stroke: P.ink,
        "stroke-width": 2.8,
        "stroke-linecap": "round",
      };
      const lidEdge = el("path", edge, inner);
      const lowEdge = el("path", edge, inner);
      const rim = el(
        "ellipse",
        { fill: "none", stroke: P.ink, "stroke-width": 2.8 },
        this.faceG,
      );
      const brow = el(
        "path",
        {
          fill: "none",
          stroke: P.ink,
          "stroke-width": 4.6,
          "stroke-linecap": "round",
        },
        this.faceG,
      );
      return {
        white,
        pupil,
        shine,
        lid,
        low,
        lidEdge,
        lowEdge,
        clip,
        rim,
        brow,
      };
    };
    this.eyes = [mkEye(0), mkEye(1)];
    this.mouthFill = el("path", { fill: P.mouth }, this.faceG);
    this.tongue = el("ellipse", { fill: P.tongue }, this.faceG);
    this.teeth = el("g", {}, this.faceG);
    this.mouthLine = el(
      "path",
      {
        fill: "none",
        stroke: P.ink,
        "stroke-width": 3.4,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      this.faceG,
    );
    el(
      "use",
      {
        href: `#${id}-b`,
        fill: "none",
        stroke: P.ink,
        "stroke-width": 5.6,
        "stroke-linejoin": "round",
      },
      this.bodyG,
    );

    if (opts.arms !== false) {
      const mk = (): Arm => ({
        hose: el(
          "path",
          {
            fill: "none",
            stroke: P.ink,
            "stroke-width": 6.5,
            "stroke-linecap": "round",
          },
          hoses,
        ),
        glove: el("g", {}, ink),
        pose: null,
      });
      this.arms = [mk(), mk()];
    } else {
      this.arms = null;
    }
    this.fx = el("g", {}, svg);
  }

  /** The glove poses, left then right; applied on the next draw. */
  setGloves(left: GlovePose, right: GlovePose): void {
    this.gloves = [left, right];
  }

  showShadow(on: boolean): void {
    this.shadow.style.display = on ? "" : "none";
  }

  /** A new line-boil frame (call a few times a second for the hand-drawn wobble). */
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
    // translate(x, y - lift) · translate(a) · rotate · scale · translate(-a)
    const a = c * p.sx;
    const b = s * p.sx;
    const cc = -s * p.sy;
    const d = c * p.sy;
    const tx = p.x + ax - (a * ax + cc * ay);
    const ty = p.y - p.lift + ay - (b * ax + d * ay);
    return [a, b, cc, d, tx, ty];
  }

  draw(p: Pose): void {
    const [bx, by, bw, bh] = this.box;
    const P = this.paint;
    const m = this.matrix(p);
    this.bodyG.setAttribute("transform", `matrix(${m.map(f).join(" ")})`);

    const ground = this.ground();
    const lift = Math.max(0, p.lift - p.y);
    this.shadow.setAttribute("cx", String(f(bx + bw / 2 + p.x)));
    this.shadow.setAttribute("cy", String(f(ground + 6)));
    const away = Math.max(0.35, 1 - lift / 160);
    this.shadow.setAttribute("rx", String(f(bw * 0.36 * away)));
    this.shadow.setAttribute("opacity", String(f(0.2 * away)));

    // ── Face ──
    const fs = Math.min(bw, bh) / 180;
    const fcx = bx + bw / 2 + p.yaw * bw * 0.14;
    const fcy = by + bh * 0.43 + p.pitch * bh * 0.07;
    this.gloss.setAttribute(
      "transform",
      `translate(${f(-p.yaw * bw * 0.05)} ${f(-p.pitch * 4)})`,
    );
    const es = p.eyeScale;
    const rx = 19 * fs * es;
    const ry = 29 * fs * es;
    for (const [i, e] of this.eyes.entries()) {
      const side = i === 0 ? -1 : 1;
      // The eye on the side the head turns toward narrows: it is round the curve.
      const far = 1 - Math.max(0, p.yaw * side) * 0.28;
      const ex = fcx + side * 19.5 * fs * es * (1 - Math.abs(p.yaw) * 0.12);
      const ey = fcy;
      const erx = rx * far;
      for (const ell of [e.white, e.clip, e.rim]) {
        ell.setAttribute("cx", String(f(ex)));
        ell.setAttribute("cy", String(f(ey)));
        ell.setAttribute("rx", String(f(erx)));
        ell.setAttribute("ry", String(f(ry)));
      }
      const px = ex + (p.lookX * 0.55 + p.yaw * 0.3) * erx;
      const py = ey + (p.lookY * 0.42 + p.pitch * 0.2) * ry + ry * 0.12;
      e.pupil.setAttribute("d", piePath(px, py, erx * 0.56, ry * 0.6));
      e.shine.setAttribute("cx", String(f(px - erx * 0.12)));
      e.shine.setAttribute("cy", String(f(py + ry * 0.3)));
      e.shine.setAttribute("r", String(f(erx * 0.1)));
      // Upper lid: covers from above down to its edge, tilted at the outer corner.
      const top = ey - ry - 2;
      const edge = ey - ry + 2 * ry * Math.min(1, p.lid);
      const tilt = p.lidTilt * ry * 0.45 * side;
      const lidOn = p.lid > 0.02 || Math.abs(p.lidTilt) > 0.05 ? "1" : "0";
      e.lid.setAttribute("opacity", lidOn);
      e.lidEdge.setAttribute("opacity", lidOn);
      e.lidEdge.setAttribute(
        "d",
        `M${f(ex + erx + 3)} ${f(edge + tilt)} Q${f(ex)} ${f(edge + ry * 0.12)} ${f(ex - erx - 3)} ${f(edge - tilt)}`,
      );
      e.lid.setAttribute(
        "d",
        `M${f(ex - erx - 3)} ${f(top - 4)} L${f(ex + erx + 3)} ${f(top - 4)} L${f(ex + erx + 3)} ${f(edge + tilt)} Q${f(ex)} ${f(edge + ry * 0.12)} ${f(ex - erx - 3)} ${f(edge - tilt)} Z`,
      );
      // Lower lid: a happy squint curves up from below.
      const low = ey + ry - 2 * ry * p.lidLow * 0.62;
      e.low.setAttribute(
        "d",
        `M${f(ex - erx - 3)} ${f(ey + ry + 4)} L${f(ex - erx - 3)} ${f(low + ry * 0.2)} Q${f(ex)} ${f(low - ry * 0.35 * p.lidLow)} ${f(ex + erx + 3)} ${f(low + ry * 0.2)} L${f(ex + erx + 3)} ${f(ey + ry + 4)} Z`,
      );
      const lowOn = p.lidLow > 0.02 ? "1" : "0";
      e.low.setAttribute("opacity", lowOn);
      e.lowEdge.setAttribute("opacity", lowOn);
      e.lowEdge.setAttribute(
        "d",
        `M${f(ex - erx - 3)} ${f(low + ry * 0.2)} Q${f(ex)} ${f(low - ry * 0.35 * p.lidLow)} ${f(ex + erx + 3)} ${f(low + ry * 0.2)}`,
      );
      // Brow: an arc over the eye; tilt drops the inner end (cross) or the outer (worried).
      const bY = ey - ry - 8 * fs - p.brow * 9 * fs;
      const inner = -p.browTilt * 7 * fs;
      const outer = p.browTilt * 3 * fs;
      const xin = ex - side * erx * 0.75;
      const xout = ex + side * erx * 0.95;
      e.brow.setAttribute(
        "d",
        `M${f(xin)} ${f(bY - inner)} Q${f(ex)} ${f(bY - 6 * fs - Math.abs(p.brow) * 2)} ${f(xout)} ${f(bY - outer)}`,
      );
    }
    for (const [i, c] of this.cheeks.entries()) {
      const side = i === 0 ? -1 : 1;
      c.setAttribute("cx", String(f(fcx + side * 40 * fs)));
      c.setAttribute("cy", String(f(fcy + 34 * fs)));
      c.setAttribute("rx", String(f(9 * fs)));
      c.setAttribute("ry", String(f(5.5 * fs)));
      c.setAttribute("opacity", String(f(p.blush * 0.75)));
    }

    // ── Mouth ──
    const mx = fcx + p.yaw * 5 * fs;
    const my = fcy + 46 * fs;
    const mw = 22 * fs * p.mouthW;
    const open = Math.max(0, p.mouthOpen);
    const sm = p.smile;
    if (p.grit > 0.5) {
      // Gritted teeth: a wide white bar, top and bottom rows.
      const h = 13 * fs;
      const w = mw * 1.15;
      const d = `M${f(mx - w)} ${f(my - h / 2)} Q${f(mx)} ${f(my - h / 2 - sm * 3)} ${f(mx + w)} ${f(my - h / 2)} L${f(mx + w)} ${f(my + h / 2)} Q${f(mx)} ${f(my + h / 2 + sm * 3)} ${f(mx - w)} ${f(my + h / 2)} Z`;
      this.mouthFill.setAttribute("d", d);
      this.mouthFill.setAttribute("fill", P.white);
      this.mouthLine.setAttribute("d", d);
      this.tongue.setAttribute("rx", "0");
      let lines = `M${f(mx - w)} ${f(my)} L${f(mx + w)} ${f(my)}`;
      for (const k of [-0.5, 0, 0.5])
        lines += ` M${f(mx + k * w)} ${f(my - h / 2)} L${f(mx + k * w)} ${f(my + h / 2)}`;
      this.teeth.innerHTML = `<path d="${lines}" stroke="${P.ink}" stroke-width="1.8" fill="none"/>`;
    } else if (open < 0.06) {
      this.teeth.innerHTML = "";
      this.mouthFill.setAttribute("d", "");
      this.tongue.setAttribute("rx", "0");
      const curve = sm * 13 * fs;
      // Little tucks at the corners when it smiles.
      const tuck = Math.max(0, sm) * 4 * fs;
      this.mouthLine.setAttribute(
        "d",
        `M${f(mx - mw - tuck)} ${f(my - tuck)} L${f(mx - mw)} ${f(my)} Q${f(mx)} ${f(my + curve * 2)} ${f(mx + mw)} ${f(my)} L${f(mx + mw + tuck)} ${f(my - tuck)}`,
      );
    } else {
      this.teeth.innerHTML = "";
      const depth = (8 + open * 26) * fs;
      const top = my - Math.max(0, -sm) * 6 * fs;
      const lipY = top + sm * 3 * fs;
      const d = `M${f(mx - mw)} ${f(top)} Q${f(mx)} ${f(lipY)} ${f(mx + mw)} ${f(top)} Q${f(mx + mw * 0.9)} ${f(top + depth)} ${f(mx)} ${f(top + depth + sm * 4 * fs)} Q${f(mx - mw * 0.9)} ${f(top + depth)} ${f(mx - mw)} ${f(top)} Z`;
      this.mouthFill.setAttribute("d", d);
      this.mouthFill.setAttribute("fill", P.mouth);
      this.mouthLine.setAttribute("d", d);
      this.tongue.setAttribute("cx", String(f(mx)));
      this.tongue.setAttribute("cy", String(f(top + depth * 0.82)));
      this.tongue.setAttribute("rx", String(f(mw * 0.55)));
      this.tongue.setAttribute("ry", String(f(depth * 0.3)));
    }

    // ── Arms ──
    if (this.arms) {
      const sy = by + bh * 0.6;
      const shoulders: [number, number][] = [
        apply(m, bx + bw * 0.14, sy),
        apply(m, bx + bw * 0.86, sy),
      ];
      const hands: [number, number, number, number][] = [
        [p.armLx, p.armLy, p.armLbend, p.armLrot],
        [p.armRx, p.armRy, p.armRbend, p.armRrot],
      ];
      for (const [i, arm] of this.arms.entries()) {
        const [sx0, sy0] = shoulders[i];
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
          arm.glove.innerHTML = gloveMarkup(pose, P.white, P.ink);
          arm.pose = pose;
        }
        const g = Math.max(0.9, bw / 180) * 1.42;
        arm.glove.setAttribute(
          "transform",
          `translate(${f(wx)} ${f(wy)}) rotate(${f(ang)}) scale(${f(g)} ${f(i === 0 ? -g : g)})`,
        );
      }
    }

    // ── Legs ──
    if (this.legs) {
      const hipY = by + bh - 10;
      const hips: [number, number][] = [
        apply(m, bx + bw * 0.36, hipY),
        apply(m, bx + bw * 0.64, hipY),
      ];
      const feet: [number, number][] = [
        [bx + bw * 0.34 + p.legLx + p.x, ground - p.legLy + p.y],
        [bx + bw * 0.66 + p.legRx + p.x, ground - p.legRy + p.y],
      ];
      const show = p.legs;
      for (const [i, leg] of this.legs.entries()) {
        const side = i === 0 ? -1 : 1;
        const [hx, hy] = hips[i];
        // Tucked legs pull the feet up under the body.
        const fx = hx + (feet[i][0] - hx) * show;
        const fy = hy + (feet[i][1] - hy) * show;
        const span = Math.hypot(fx - hx, fy - hy);
        // Slack hose bows outward like a knee; taut hose is straight.
        const slack = Math.max(0, LEG + 6 - span) * 0.9 + 3;
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
}
