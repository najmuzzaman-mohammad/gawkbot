// toon.ts — a bot as a 1930s rubber-hose cartoon character, alive.
//
// Toon puts a ToonRig on the page and moves it like an animator would: a
// pose is tweened toward key poses with anticipation, overshoot and
// settle, and on top of that runs the life every character of that era
// has between beats: a bounce in time with an unheard band, blinks, little
// glances. The moves:
//
//   birth()      "Poof!" a cloud of smoke and a burst of stars, and it pops
//                out stretched, lands with a squash and waves
//   wave() point() clap() thumbsUp() hop()
//   flyTo(x, y)  crouches, launches stretched, sails along an arc leaning
//                into it with its legs trailing and dust puffs behind, and
//                lands with a squash
//   depart()     a hop and a zip up and away in a puff
//   holdDown()   grips a bar over its head (a blind's pull bar) with both
//                gloves and leans back on it, teeth gritted, sweating;
//                tug() is the bar yanking it onto tiptoe and the toon
//                hauling it back down
//   letGo()      the bar flies away: it stumbles, sighs, wipes its brow
//                and flicks the sweat off, relieved
//   setFace()    the moods the rest of the app uses
//
// Under prefers-reduced-motion every move ends in its final pose at once,
// and nothing loops.

import type { AvatarShape } from "../../api/memberTypes";
import { Fx, worldPuff } from "./fx";
import type { GlovePose } from "./glove";
import { type Pose, type PoseKey, REST, ToonRig, VIEW } from "./rig";

export type ToonFace =
  | "calm"
  | "working"
  | "sleepy"
  | "asking"
  | "oops"
  | "happy";

/** Expressions as pose deltas over REST. */
export const FACE_POSES: Record<ToonFace, Partial<Pose>> = {
  calm: { smile: 0.6, mouthOpen: 0, lid: 0, lidLow: 0, brow: 0, browTilt: 0 },
  working: {
    smile: 0.15,
    lid: 0.32,
    lidTilt: 0.25,
    browTilt: 0.5,
    brow: -0.2,
    lookX: 0.4,
    lookY: 0.5,
  },
  sleepy: { smile: 0.3, lid: 0.62, brow: -0.3, lidTilt: -0.2 },
  asking: {
    smile: 0.5,
    mouthOpen: 0.35,
    mouthW: 0.8,
    brow: 0.8,
    eyeScale: 1.08,
    lookY: -0.3,
  },
  oops: {
    smile: -0.7,
    mouthOpen: 0.15,
    brow: 0.5,
    browTilt: -1,
    lidTilt: -0.5,
    lid: 0.15,
  },
  happy: { smile: 1, mouthOpen: 0.55, lidLow: 0.55, brow: 0.6, blush: 0.9 },
};

export interface ToonOptions {
  body: AvatarShape;
  color: string;
  /** Rendered size of the body in CSS pixels. */
  size: number;
  arms?: boolean;
  legs?: boolean;
  /** Hand-drawn line boil. For big characters on a stage. */
  boil?: boolean;
  /** The idle life (bounce, blinks, glances). Default true. */
  live?: boolean;
  face?: ToonFace;
}

type Ease = (t: number) => number;
export const EASE = {
  linear: (t: number) => t,
  out: (t: number) => 1 - (1 - t) ** 3,
  in: (t: number) => t * t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  /** Overshoots and settles: the snap into a key pose. */
  back: (t: number) => {
    const c = 1.9;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
  },
  bounce: (t: number) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t - 1.5 / d) ** 2 + 0.75;
    if (t < 2.5 / d) return n * (t - 2.25 / d) ** 2 + 0.9375;
    return n * (t - 2.625 / d) ** 2 + 0.984375;
  },
} satisfies Record<string, Ease>;

interface Track {
  from: number;
  to: number;
  t0: number;
  dur: number;
  ease: Ease;
  done: () => void;
}

function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export class Toon {
  /** Positioned box the size of the body; place it with CSS, move it with flyTo(). */
  readonly root: HTMLDivElement;
  readonly rig: ToonRig;
  readonly reduced: boolean;
  private readonly size: number;
  private readonly fx: Fx;
  private readonly pose: Pose = { ...REST };
  /** Added on top of the pose every frame: the idle life and the shakes. */
  private readonly off: Partial<Record<PoseKey, number>> = {};
  private readonly tracks = new Map<PoseKey, Track>();
  private raf = 0;
  private last = 0;
  private alive = true;
  private live: boolean;
  private acting = 0;
  private beat = 0;
  private nextBlink = 0;
  private nextGlance = 0;
  private strain = 0;
  private kicking = false;
  private boilAt = 0;
  private boilSeed = 1;
  private readonly boils: boolean;
  private x = 0;
  private y = 0;
  private fly: null | {
    fromX: number;
    fromY: number;
    cx: number;
    cy: number;
    toX: number;
    toY: number;
    t0: number;
    dur: number;
    lastPuff: number;
    done: () => void;
  } = null;

  constructor(host: HTMLElement, opts: ToonOptions) {
    this.size = opts.size;
    this.reduced =
      prefersReduced() || typeof requestAnimationFrame !== "function";
    this.live = opts.live !== false && !this.reduced;
    this.boils = !!opts.boil && !this.reduced;
    this.rig = new ToonRig({
      body: opts.body,
      color: opts.color,
      arms: opts.arms !== false,
      legs: opts.legs !== false,
      boil: this.boils,
    });
    const root = document.createElement("div");
    root.className = "toon";
    root.style.cssText = `position:absolute;width:${opts.size}px;height:${opts.size}px;pointer-events:none`;
    const k = opts.size / 200;
    const svg = this.rig.svg;
    svg.style.cssText = `position:absolute;left:${VIEW.x * k}px;top:${VIEW.y * k}px;width:${VIEW.w * k}px;height:${VIEW.h * k}px;overflow:visible;pointer-events:none`;
    root.appendChild(svg);
    host.appendChild(root);
    this.root = root;
    this.fx = new Fx(this.rig.fx);
    if (opts.face) Object.assign(this.pose, FACE_POSES[opts.face]);
    this.rig.setGloves("open", "open");
    this.rig.draw(this.pose);
    if (this.live) this.wake();
  }

  // ── Frame loop ──────────────────────────────────────────────────────

  private wake(): void {
    if (this.raf || !this.alive || this.reduced) return;
    this.last = now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (): void => {
    this.raf = 0;
    if (!this.alive) return;
    const t = now();
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;

    for (const [key, tr] of this.tracks) {
      const k = Math.min(1, (t - tr.t0) / tr.dur);
      this.pose[key] = tr.from + (tr.to - tr.from) * tr.ease(k);
      if (k >= 1) {
        this.tracks.delete(key);
        tr.done();
      }
    }
    if (this.fly) this.stepFlight(t);
    this.idle(t, dt);
    this.fx.step(dt);
    if (this.boils && t > this.boilAt) {
      this.boilSeed = (this.boilSeed % 3) + 1;
      this.rig.boil(this.boilSeed);
      this.boilAt = t + 125;
    }
    this.render();
    if (
      this.live ||
      this.tracks.size > 0 ||
      this.fly ||
      this.fx.busy ||
      this.strain > 0 ||
      this.kicking
    ) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private render(): void {
    const p = { ...this.pose };
    for (const [k, v] of Object.entries(this.off) as [PoseKey, number][])
      p[k] += v;
    this.rig.draw(p);
  }

  /** The life between beats. Writes only offsets, never the pose. */
  private idle(t: number, dt: number): void {
    const o = this.off;
    if (!this.live) {
      for (const k of Object.keys(o) as PoseKey[]) o[k] = 0;
      return;
    }
    // A bounce on the beat: down on every beat, arms swinging opposite.
    const calm = this.acting > 0 ? 0.35 : 1;
    this.beat += dt * (this.strain > 0 ? 5.5 : 2.1);
    const b = Math.abs(Math.sin(this.beat * Math.PI * 0.5));
    o.y = (1 - b) * 3.2 * calm;
    o.sy = -(1 - b) * 0.035 * calm;
    o.sx = (1 - b) * 0.03 * calm;
    const swing = Math.sin(this.beat * Math.PI * 0.5) * 4 * calm;
    o.armLy = swing;
    o.armRy = -swing;
    o.rot = 0;
    // Straining: a fast shake and a wobble in the knees.
    if (this.strain > 0) {
      o.x = Math.sin(t * 0.09) * 1.6 * this.strain;
      o.rot = Math.sin(t * 0.05) * 1.8 * this.strain;
      if (Math.random() < dt * 2.2 * this.strain) this.sweatDrop();
    } else {
      o.x = 0;
    }
    // Legs kicking in the air, bicycling.
    if (this.kicking) {
      o.legLy = 6 + Math.sin(t * 0.022) * 8;
      o.legRy = 6 - Math.sin(t * 0.022) * 8;
      o.legLx = Math.cos(t * 0.022) * 5;
      o.legRx = -Math.cos(t * 0.022) * 5;
    } else {
      o.legLy = 0;
      o.legRy = 0;
      o.legLx = 0;
      o.legRx = 0;
    }
    // Blinks.
    if (t > this.nextBlink) {
      this.nextBlink = t + 1800 + Math.random() * 3200;
      this.blinkAt = t;
    }
    const since = t - this.blinkAt;
    o.lid =
      since < 70
        ? since / 70
        : since < 110
          ? 1
          : since < 230
            ? 1 - (since - 110) / 120
            : 0;
    o.lid *= 1 - this.pose.lid;
    // A glance now and then, when nothing else is going on.
    if (
      this.acting === 0 &&
      this.strain === 0 &&
      t > this.nextGlance &&
      !this.fly
    ) {
      this.nextGlance = t + 2600 + Math.random() * 4200;
      const yaw = (Math.random() - 0.5) * 0.7;
      void this.to(
        {
          yaw,
          lookX: yaw * 1.4 + (Math.random() - 0.5) * 0.4,
          lookY: (Math.random() - 0.5) * 0.5,
        },
        420,
        EASE.inOut,
      );
    }
  }

  private blinkAt = -1000;

  // ── Primitives ──────────────────────────────────────────────────────

  /** Tweens the pose toward `target`; resolves when every key arrives. */
  to(
    target: Partial<Pose>,
    ms: number,
    ease: Ease = EASE.inOut,
  ): Promise<void> {
    if (this.reduced || ms <= 0) {
      Object.assign(this.pose, target);
      this.render();
      return Promise.resolve();
    }
    const t0 = now();
    const keys = Object.keys(target) as PoseKey[];
    const all = keys.map(
      (key) =>
        new Promise<void>((done) => {
          const prev = this.tracks.get(key);
          prev?.done();
          this.tracks.set(key, {
            from: this.pose[key],
            to: target[key] as number,
            t0,
            dur: ms,
            ease,
            done,
          });
        }),
    );
    this.wake();
    return Promise.all(all).then(() => undefined);
  }

  gloves(left: GlovePose, right: GlovePose): void {
    this.rig.setGloves(left, right);
    if (!this.raf) this.render();
  }

  wait(ms: number): Promise<void> {
    return this.reduced
      ? Promise.resolve()
      : new Promise((r) => setTimeout(r, ms));
  }

  private async act<T>(run: () => Promise<T>): Promise<T> {
    this.acting++;
    try {
      return await run();
    } finally {
      this.acting--;
    }
  }

  /** Where the brow is, in rig units (for sweat and the wipe). */
  private brow(): [number, number] {
    const [bx, by, bw, bh] = this.rig.box;
    return [
      bx + bw / 2 + this.pose.x,
      by + bh * 0.2 + this.pose.y - this.pose.lift,
    ];
  }

  private sweatDrop(side = Math.random() < 0.5 ? -1 : 1): void {
    const [x, y] = this.brow();
    const [, , bw] = this.rig.box;
    this.fx.sweat(x + side * bw * 0.32, y, side);
    this.wake();
  }

  /** Legs bicycling in the air (dangling from something). */
  kick(on: boolean): void {
    this.kicking = on && !this.reduced;
    this.wake();
  }

  /** The contact shadow, hidden while it is off the ground. */
  shadow(on: boolean): void {
    this.rig.showShadow(on);
  }

  setFace(face: ToonFace, ms = 260): Promise<void> {
    const reset: Partial<Pose> = {
      smile: REST.smile,
      mouthOpen: 0,
      mouthW: 1,
      lid: 0,
      lidTilt: 0,
      lidLow: 0,
      brow: 0,
      browTilt: 0,
      eyeScale: 1,
      lookX: 0,
      lookY: 0,
      blush: REST.blush,
      grit: 0,
    };
    return this.to({ ...reset, ...FACE_POSES[face] }, ms);
  }

  /** Moves without animating, relative to where the character was placed (px). */
  placeAt(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.root.style.translate = `${x}px ${y}px`;
  }

  // ── Moves ───────────────────────────────────────────────────────────

  /** "Poof!" Smoke, stars, and it pops out; then a wave unless `wave` is false. */
  birth(opts: { wave?: boolean } = {}): Promise<void> {
    return this.act(async () => {
      const [bx, by, bw, bh] = this.rig.box;
      const cx = bx + bw / 2;
      const cy = by + bh * 0.55;
      if (this.reduced) {
        await this.setFace("calm", 0);
        return;
      }
      Object.assign(this.pose, {
        sx: 0.05,
        sy: 0.05,
        lid: 1,
        legs: 0,
        armLx: -6,
        armLy: 8,
        armRx: 6,
        armRy: 8,
      });
      this.gloves("fist", "fist");
      this.fx.poof(cx, cy, 11, 1.3);
      this.fx.stars(cx, cy - 20, 7, 1.2);
      this.render();
      await this.wait(120);
      // Out of the smoke stretched tall, then down with a squash.
      await this.to({ sx: 0.75, sy: 1.35, lift: 26 }, 170, EASE.out);
      await this.to({ sx: 1.22, sy: 0.78, lift: 0, legs: 1 }, 150, EASE.in);
      this.gloves("open", "open");
      void this.to(
        {
          armLx: REST.armLx - 14,
          armLy: 18,
          armRx: REST.armRx + 14,
          armRy: 18,
        },
        220,
        EASE.back,
      );
      await this.to({ sx: 1, sy: 1 }, 380, EASE.back);
      // The eyes pop open wide, then settle into a smile.
      await this.to(
        { lid: 0, eyeScale: 1.25, brow: 1, mouthOpen: 0.5, smile: 0.8 },
        140,
        EASE.out,
      );
      await this.to(
        {
          eyeScale: 1,
          brow: 0.4,
          mouthOpen: 0.2,
          armLx: REST.armLx,
          armLy: REST.armLy,
          armRx: REST.armRx,
          armRy: REST.armRy,
        },
        320,
        EASE.inOut,
      );
      if (opts.wave !== false) await this.wave();
      await this.setFace("calm");
    });
  }

  /** A hello: the right glove up by the head, rocking side to side. */
  wave(times = 2): Promise<void> {
    return this.act(async () => {
      if (this.reduced) return;
      this.gloves("open", "open");
      await this.to(
        {
          armRx: 34,
          armRy: -58,
          armRbend: 0.7,
          smile: 0.95,
          mouthOpen: 0.45,
          lidLow: 0.35,
          brow: 0.6,
          yaw: -0.15,
        },
        200,
        EASE.back,
      );
      for (let i = 0; i < times; i++) {
        await this.to({ armRx: 46, armRrot: -28 }, 150, EASE.inOut);
        await this.to({ armRx: 26, armRrot: 24 }, 150, EASE.inOut);
      }
      await this.to(
        {
          armRx: REST.armRx,
          armRy: REST.armRy,
          armRbend: REST.armRbend,
          armRrot: 0,
          mouthOpen: 0.1,
          lidLow: 0,
          brow: 0,
          yaw: 0,
        },
        260,
        EASE.inOut,
      );
    });
  }

  /** Points a glove toward `deg` (0 right, 90 down) and looks there; null to stop. */
  point(deg: number | null): Promise<void> {
    if (deg === null) {
      this.gloves("open", "open");
      return this.to(
        {
          armRx: REST.armRx,
          armRy: REST.armRy,
          armRbend: REST.armRbend,
          armLx: REST.armLx,
          armLy: REST.armLy,
          yaw: 0,
          lookX: 0,
          lookY: 0,
        },
        280,
      );
    }
    const r = (deg * Math.PI) / 180;
    const right = Math.cos(r) >= 0;
    const reach = 64;
    if (right) this.gloves("open", "point");
    else this.gloves("point", "open");
    const arm: Partial<Pose> = right
      ? {
          armRx: Math.cos(r) * reach,
          armRy: Math.sin(r) * reach,
          armRbend: -0.15,
        }
      : {
          armLx: Math.cos(r) * reach,
          armLy: Math.sin(r) * reach,
          armLbend: 0.15,
        };
    return this.to(
      {
        ...arm,
        yaw: Math.cos(r) * 0.55,
        lookX: Math.cos(r),
        lookY: Math.sin(r) * 0.8,
      },
      260,
      EASE.back,
    );
  }

  /** Two claps in front of the body, with stars: something went well. */
  clap(): Promise<void> {
    return this.act(async () => {
      if (this.reduced) return;
      const [bx, by, bw, bh] = this.rig.box;
      this.gloves("flat", "flat");
      await this.to(
        { smile: 1, mouthOpen: 0.6, lidLow: 0.6, brow: 0.7, blush: 1 },
        120,
      );
      for (let i = 0; i < 2; i++) {
        await this.to(
          {
            armLx: 26,
            armLy: -6,
            armRx: -26,
            armRy: -6,
            armLbend: 0.4,
            armRbend: -0.4,
          },
          110,
          EASE.in,
        );
        this.fx.stars(bx + bw / 2, by + bh * 0.5, 4, 0.7);
        await this.to(
          { armLx: -6, armLy: -14, armRx: 6, armRy: -14 },
          140,
          EASE.out,
        );
      }
      await this.hop(0.18);
      this.gloves("open", "open");
      await this.to(
        {
          armLx: REST.armLx,
          armLy: REST.armLy,
          armRx: REST.armRx,
          armRy: REST.armRy,
          armLbend: REST.armLbend,
          armRbend: REST.armRbend,
        },
        260,
      );
      await this.setFace("calm", 400);
    });
  }

  thumbsUp(): Promise<void> {
    return this.act(async () => {
      this.gloves("open", "thumb");
      await this.to(
        {
          armRx: 36,
          armRy: 2,
          armRbend: -0.6,
          smile: 1,
          lidLow: 0.5,
          yaw: -0.2,
          mouthOpen: 0.3,
        },
        220,
        EASE.back,
      );
      await this.wait(700);
      this.gloves("open", "open");
      await this.to(
        {
          armRx: REST.armRx,
          armRy: REST.armRy,
          armRbend: REST.armRbend,
          lidLow: 0,
          yaw: 0,
          mouthOpen: 0,
        },
        260,
      );
    });
  }

  /** Crouch, jump, land with a squash. `h` is the jump in body heights. */
  hop(h = 0.3): Promise<void> {
    return this.act(async () => {
      if (this.reduced) return;
      const up = this.rig.box[3] * h;
      await this.to({ sx: 1.14, sy: 0.84 }, 90, EASE.out);
      await this.to(
        { sx: 0.9, sy: 1.14, lift: up, legLy: 8, legRy: 8 },
        200,
        EASE.out,
      );
      await this.to(
        { sx: 1, sy: 1, lift: 0, legLy: 0, legRy: 0 },
        190,
        EASE.in,
      );
      await this.to({ sx: 1.16, sy: 0.84 }, 70, EASE.out);
      await this.to({ sx: 1, sy: 1 }, 260, EASE.back);
    });
  }

  /**
   * Flies to (x, y) px, relative to where it was placed: an arc `lift` px
   * above the straight line (or through `via`), with dust puffs left in
   * `trailHost` (default: the host), landing with a squash.
   */
  flyTo(
    x: number,
    y: number,
    opts: {
      duration?: number;
      lift?: number;
      via?: { x: number; y: number };
      trailHost?: HTMLElement;
    } = {},
  ): Promise<void> {
    return this.act(async () => {
      const fromX = this.x;
      const fromY = this.y;
      if (this.reduced) {
        this.placeAt(x, y);
        return;
      }
      const dir = x >= fromX ? 1 : -1;
      // Anticipation: a crouch and a look where it is going.
      await this.to(
        { sx: 1.18, sy: 0.8, yaw: dir * 0.5, lookX: dir, armLy: 10, armRy: 10 },
        150,
        EASE.out,
      );
      this.gloves("open", "open");
      void this.to(
        {
          sx: 0.84,
          sy: 1.22,
          legs: 0.35,
          armLx: -30,
          armLy: -40,
          armRx: 30,
          armRy: -40,
          mouthOpen: 0.3,
          smile: 0.9,
        },
        160,
        EASE.out,
      );
      const lift =
        opts.lift ?? Math.min(160, Math.hypot(x - fromX, y - fromY) * 0.35);
      await new Promise<void>((done) => {
        this.fly = {
          fromX,
          fromY,
          cx: opts.via?.x ?? (fromX + x) / 2,
          cy: opts.via?.y ?? Math.min(fromY, y) - lift,
          toX: x,
          toY: y,
          t0: now(),
          dur: opts.duration ?? 900,
          lastPuff: 0,
          done,
        };
        this.trail = opts.trailHost ?? this.root.parentElement;
        this.wake();
      });
      this.off.rot = 0;
      // Touchdown.
      await this.to({ legs: 1, sx: 1.2, sy: 0.8, rot: 0 }, 80, EASE.out);
      await this.to(
        {
          sx: 1,
          sy: 1,
          yaw: 0,
          lookX: 0,
          mouthOpen: 0,
          smile: REST.smile,
          armLx: REST.armLx,
          armLy: REST.armLy,
          armRx: REST.armRx,
          armRy: REST.armRy,
        },
        320,
        EASE.back,
      );
    });
  }

  private trail: HTMLElement | null = null;

  private stepFlight(t: number): void {
    const f = this.fly;
    if (!f) return;
    const k = Math.min(1, (t - f.t0) / f.dur);
    const e = EASE.inOut(k);
    const q = (a: number, c: number, b: number) =>
      (1 - e) ** 2 * a + 2 * (1 - e) * e * c + e * e * b;
    const x = q(f.fromX, f.cx, f.toX);
    const y = q(f.fromY, f.cy, f.toY);
    this.placeAt(x, y);
    // Lean into the flight and stretch along it, most in the middle.
    const mid = Math.sin(Math.PI * k);
    const dir = f.toX >= f.fromX ? 1 : -1;
    this.pose.rot = mid * 16 * dir;
    this.pose.sx = 1 - mid * 0.12;
    this.pose.sy = 1 + mid * 0.16;
    if (this.trail && t - f.lastPuff > 55 && k > 0.05 && k < 0.95) {
      f.lastPuff = t;
      const s = this.size;
      worldPuff(
        this.trail,
        x + s / 2 - dir * s * 0.3,
        y + s * 0.75,
        s * 0.12 + Math.random() * s * 0.06,
      );
    }
    if (k >= 1) {
      this.fly = null;
      f.done();
    }
  }

  /** A happy hop, then up and away in a puff. */
  depart(): Promise<void> {
    return this.act(async () => {
      if (this.reduced) {
        this.root.style.opacity = "0";
        return;
      }
      await this.hop(0.2);
      await this.to({ sx: 1.15, sy: 0.82 }, 90, EASE.out);
      const [bx, by, bw, bh] = this.rig.box;
      this.fx.poof(bx + bw / 2, by + bh, 7, 0.8);
      await this.to({ sx: 0.4, sy: 1.6, lift: 260, legs: 0 }, 260, EASE.in);
      this.root.style.opacity = "0";
    });
  }

  // ── The blind ───────────────────────────────────────────────────────

  /**
   * Grips a bar `reach` px above the top of its head with both gloves and
   * leans back on it, straining: gritted teeth, sweat, a shake.
   */
  holdDown(reach: number, strain = 1): Promise<void> {
    return this.act(async () => {
      const u = 200 / this.size;
      const [, , bw] = this.rig.box;
      const up = -(this.rig.box[3] * 0.6 + reach * u);
      this.gloves("grip", "grip");
      this.strain = strain;
      await this.to(
        {
          armLx: bw * 0.18,
          armLy: up,
          armRx: -bw * 0.18,
          armRy: up,
          armLbend: 0.15,
          armRbend: -0.15,
          rot: 0,
          sx: 0.95,
          sy: 1.05,
          legLx: -10,
          legRx: 10,
          grit: 1,
          lid: 0.4,
          lidTilt: 0.7,
          brow: -0.3,
          browTilt: 0.9,
          lookY: -0.7,
          lookX: 0,
          yaw: 0,
          blush: 1,
          smile: -0.2,
        },
        280,
        EASE.back,
      );
    });
  }

  /**
   * One glove off the bar for a thumbs-up (the bar pulls it up a little
   * while it only has one hand on), then back on with both.
   */
  thumbsWhileHolding(): Promise<void> {
    return this.act(async () => {
      if (this.reduced) return;
      const [, , bw, bh] = this.rig.box;
      const up = this.pose.armLy;
      this.gloves("grip", "thumb");
      await this.to(
        {
          armRx: bw * 0.3,
          armRy: -bh * 0.05,
          armRbend: -0.5,
          grit: 0,
          smile: 1,
          mouthOpen: 0.4,
          lidLow: 0.5,
          lidTilt: 0,
          browTilt: 0,
          brow: 0.6,
          lookY: 0,
          lookX: 0.4,
          yaw: 0.25,
        },
        200,
        EASE.back,
      );
      await this.wait(650);
      this.gloves("grip", "grip");
      await this.to(
        {
          armRx: -bw * 0.18,
          armRy: up,
          armRbend: -0.15,
          grit: 1,
          smile: -0.2,
          mouthOpen: 0,
          lidLow: 0,
          lidTilt: 0.7,
          browTilt: 0.9,
          brow: -0.3,
          lookY: -0.7,
          lookX: 0,
          yaw: 0,
        },
        180,
        EASE.out,
      );
    });
  }

  /** The bar yanks it up onto its toes; it hauls the bar back down. */
  tug(px = 14): Promise<void> {
    return this.act(async () => {
      if (this.reduced) return;
      const u = (200 / this.size) * px;
      this.fx.bang(
        this.rig.box[0] + this.rig.box[2] * 0.85,
        this.rig.box[1] - 6,
      );
      await this.to(
        {
          lift: u,
          legLy: u * 0.9,
          legRy: u * 0.6,
          eyeScale: 1.25,
          grit: 0,
          mouthOpen: 0.7,
          smile: -0.4,
          lid: 0,
        },
        130,
        EASE.out,
      );
      await this.wait(160);
      this.sweatDrop(-1);
      this.sweatDrop(1);
      await this.to(
        {
          lift: 0,
          legLy: 0,
          legRy: 0,
          eyeScale: 1,
          grit: 1,
          mouthOpen: 0,
          lid: 0.4,
          sy: 0.92,
          sx: 1.06,
        },
        220,
        EASE.bounce,
      );
      await this.to({ sy: 1.05, sx: 0.95 }, 160);
    });
  }

  /**
   * The bar is let go: arms fly up, a stumble back, a big sigh, a wipe of
   * the brow with a flick of sweat, and a relieved smile.
   */
  letGo(): Promise<void> {
    return this.act(async () => {
      this.strain = 0;
      this.gloves("open", "open");
      if (this.reduced) {
        await this.to({ ...REST }, 0);
        return;
      }
      // Whoa: arms up, eyes wide, rocked back on its heels.
      await this.to(
        {
          armLx: -34,
          armLy: -70,
          armRx: 34,
          armRy: -70,
          grit: 0,
          mouthOpen: 0.8,
          smile: -0.3,
          eyeScale: 1.3,
          lid: 0,
          lidTilt: 0,
          browTilt: 0,
          brow: 1,
          rot: -10,
          legLx: 0,
          legRx: 0,
          lookY: -1,
        },
        160,
        EASE.out,
      );
      await this.to({ rot: 4, lift: 10 }, 160, EASE.out);
      await this.to({ rot: 0, lift: 0, sx: 1.14, sy: 0.86 }, 140, EASE.in);
      // Phew: eyes shut, shoulders drop, a long exhale.
      await this.to(
        {
          sx: 1.04,
          sy: 0.94,
          lid: 1,
          eyeScale: 1,
          mouthOpen: 0.25,
          mouthW: 0.55,
          smile: 0.1,
          brow: -0.2,
          browTilt: -0.6,
          lookY: 0,
          armLx: -16,
          armLy: 54,
          armRx: 16,
          armRy: 54,
        },
        320,
        EASE.inOut,
      );
      await this.wait(260);
      // The wipe: a flat glove across the brow, right to left, and a flick.
      const [, , bw, bh] = this.rig.box;
      this.gloves("open", "flat");
      const browY = -bh * 0.52;
      await this.to(
        {
          armRx: bw * 0.06,
          armRy: browY,
          armRbend: -0.5,
          armRrot: 90,
          lid: 0.55,
        },
        200,
        EASE.out,
      );
      await this.to(
        { armRx: -bw * 0.62, armRy: browY - 4, armRrot: 100 },
        280,
        EASE.inOut,
      );
      this.sweatDrop(-1);
      this.sweatDrop(-1);
      await this.to(
        { armRx: -bw * 0.75, armRy: browY - 18, armRrot: 70 },
        90,
        EASE.out,
      );
      this.gloves("open", "open");
      await this.to(
        {
          armRx: REST.armRx,
          armRy: REST.armRy,
          armRbend: REST.armRbend,
          armRrot: 0,
          armLx: REST.armLx,
          armLy: REST.armLy,
          sx: 1,
          sy: 1,
          lid: 0,
          lidLow: 0.45,
          mouthOpen: 0,
          mouthW: 1,
          smile: 0.9,
          brow: 0.2,
          browTilt: 0,
          blush: 0.8,
        },
        360,
        EASE.back,
      );
      await this.wait(500);
      await this.setFace("calm", 500);
    });
  }

  destroy(): void {
    this.alive = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const tr of this.tracks.values()) tr.done();
    this.tracks.clear();
    if (this.fly) this.fly.done();
    this.fly = null;
    this.fx.clear();
    this.root.remove();
  }
}
