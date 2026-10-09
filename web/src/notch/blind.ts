// blind.ts — the open notch is a roller blind, and the lead is holding it.
//
// A cartoon short in four beats, played every time the notch opens and
// closes:
//
//   1. Poof: the lead appears under the notch, hanging from the blind's
//      pull ring. Its weight unrolls the blind: it rides the ring down,
//      legs bicycling, until its shoes hit the bottom of the screen.
//   2. It holds the blind down, leaning back on the ring, teeth gritted.
//      Every so often the blind tugs back up and it hauls it down again.
//      When an answer lands it takes one glove off for a thumbs-up, and
//      the blind jerks up until it grabs on again.
//   3. On close the blind snaps back up and yanks the lead up with it. It
//      lets go under the notch and drops onto the stage below it.
//   4. Relief: a stumble, a long sigh, a wipe of the brow with a flick of
//      sweat, a smile, and a hop back into the notch.
//
// This file is the director: it owns the timing, the blind's drop and
// where the toon is. The fabric and its content are React's (NotchBlind);
// the toon is lib/toon. Under reduced motion the blind is simply down
// while the notch is open, with the lead standing under it.

import type { AvatarShape } from "../api/memberTypes";
import { CAST } from "../lib/toon/cast";
import { LEG } from "../lib/toon/rig";
import { EASE, Toon } from "../lib/toon/toon";
import type { SoundKind } from "./sounds";

/** The lead's size, how far its gloves reach above its head to the ring. */
export const LEAD_SIZE = 68;
const REACH = 6;
/** The pull ring hangs this far below the bottom of the fabric. */
export const RING = 15;

/** Pixels from the lead's gloves (on the ring) down to its soles. */
export function handsToFeet(body: AvatarShape, size = LEAD_SIZE): number {
  const [, by, , bh] = (CAST[body] ?? CAST.bear).box;
  const k = size / 200;
  return (by + bh + LEG - by) * k + REACH;
}

/** How far the blind unrolls in a window `height` tall, from `top`. */
export function blindDrop(
  body: AvatarShape,
  top: number,
  height: number,
): number {
  return Math.round(height - 6 - handsToFeet(body) - RING - top);
}

export interface BlindCast {
  body: AvatarShape;
  color: string;
}

export interface BlindStage {
  /** Absolute layer the size of the open window, centred; the toon lives here. */
  layer: HTMLElement;
  /** The fabric; its visible height is the CSS variable --drop. */
  fabric: HTMLElement;
  /** Where the fabric starts, px from the top of the window. */
  top: number;
  /** Fully unrolled height. */
  full: number;
  /** Where the lead's soles land after the blind snaps up (px from the top). */
  reliefFloor: number;
  sfx: (kind: SoundKind) => void;
}

type Tween = {
  from: number;
  to: number;
  t0: number;
  dur: number;
  ease: (t: number) => number;
  done: () => void;
};

export class BlindShow {
  private toon: Toon | null = null;
  private drop = 0;
  private tween: Tween | null = null;
  private raf = 0;
  private tugTimer = 0;
  private holding = false;
  private gen = 0;
  /** Extra offset on the lead's y while it falls free of the ring. */
  private falling: Tween | null = null;
  private fallY = 0;
  private lastOpen = 0;

  constructor(
    private readonly stage: BlindStage,
    private readonly cast: BlindCast,
  ) {}

  private get reduced(): boolean {
    return (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      typeof requestAnimationFrame !== "function"
    );
  }

  /** The pull ring's y for the current drop. */
  private ringY(): number {
    return this.stage.top + this.drop + RING;
  }

  private setDrop(px: number): void {
    this.drop = px;
    this.stage.fabric.style.setProperty("--drop", `${Math.round(px)}px`);
    this.placeLead();
  }

  /** Puts the lead's gloves on the ring (or where it fell to). */
  private placeLead(): void {
    const t = this.toon;
    if (!t) return;
    const k = LEAD_SIZE / 200;
    const by = (CAST[this.cast.body] ?? CAST.bear).box[1];
    const top =
      this.falling || this.fallY ? this.fallY : this.ringY() + REACH - by * k;
    t.placeAt(this.stage.layer.clientWidth / 2 - LEAD_SIZE / 2, top);
  }

  private loop = (): void => {
    this.raf = 0;
    const now = performance.now();
    for (const which of ["tween", "falling"] as const) {
      const tw = this[which];
      if (!tw) continue;
      const k = Math.min(1, (now - tw.t0) / tw.dur);
      const v = tw.from + (tw.to - tw.from) * tw.ease(k);
      if (which === "tween") this.drop = v;
      else this.fallY = v;
      if (k >= 1) {
        this[which] = null;
        tw.done();
      }
    }
    this.setDrop(this.drop);
    if (this.tween || this.falling) this.raf = requestAnimationFrame(this.loop);
  };

  private animate(
    which: "tween" | "falling",
    from: number,
    to: number,
    dur: number,
    ease: (t: number) => number,
  ): Promise<void> {
    return new Promise((done) => {
      this[which]?.done();
      this[which] = { from, to, t0: performance.now(), dur, ease, done };
      if (!this.raf) this.raf = requestAnimationFrame(this.loop);
    });
  }

  private rollTo(px: number, dur: number, ease = EASE.inOut): Promise<void> {
    return this.animate("tween", this.drop, px, dur, ease);
  }

  private makeLead(): Toon {
    this.toon?.destroy();
    const t = new Toon(this.stage.layer, {
      body: this.cast.body,
      color: this.cast.color,
      size: LEAD_SIZE,
    });
    t.root.style.left = "0";
    t.root.style.top = "0";
    this.toon = t;
    this.fallY = 0;
    this.falling = null;
    return t;
  }

  /** Beat 1 and 2: the blind comes down with the lead hanging off it. */
  async open(): Promise<void> {
    const gen = ++this.gen;
    this.stopTugs();
    const quick = performance.now() - this.lastOpen < 20_000;
    this.lastOpen = performance.now();
    const t = this.makeLead();
    if (this.reduced) {
      this.setDrop(this.stage.full);
      await t.holdDown(REACH, 0);
      this.holding = true;
      return;
    }
    this.setDrop(0);
    t.shadow(false);
    void t.holdDown(REACH, 0.3);
    t.kick(true);
    if (!quick) {
      // Poof: it appears on the ring in a puff of smoke.
      void t.to({ sx: 0.05, sy: 0.05 }, 0);
      this.stage.sfx("poof");
      await t.to({ sx: 1.15, sy: 0.9 }, 160, EASE.out);
      void t.to({ sx: 1, sy: 1 }, 260, EASE.back);
    }
    if (gen !== this.gen) return;
    this.stage.sfx("ratchet");
    // Its weight unrolls the blind; it accelerates, then the soles hit.
    await this.rollTo(this.stage.full, quick ? 420 : 700, EASE.in);
    if (gen !== this.gen) return;
    t.kick(false);
    t.shadow(true);
    this.stage.sfx("thud");
    await t.to({ sx: 1.18, sy: 0.82 }, 70, EASE.out);
    void t.to({ sx: 0.95, sy: 1.05 }, 240, EASE.back);
    // The blind bounces once on its spring.
    await this.rollTo(this.stage.full - 10, 110, EASE.out);
    await this.rollTo(this.stage.full, 200, EASE.bounce);
    if (gen !== this.gen) return;
    await t.holdDown(REACH, 0.35);
    this.holding = true;
    this.scheduleTug();
  }

  private scheduleTug(): void {
    this.stopTugs();
    if (this.reduced) return;
    this.tugTimer = window.setTimeout(
      () => void this.tug(),
      9_000 + Math.random() * 7_000,
    );
  }

  private stopTugs(): void {
    window.clearTimeout(this.tugTimer);
    this.tugTimer = 0;
  }

  /** The blind tries to roll back up; the lead hauls it down. */
  async tug(): Promise<void> {
    const t = this.toon;
    if (!(t && this.holding) || this.reduced) return;
    const gen = this.gen;
    this.stage.sfx("strain");
    const yank = 14;
    void t.tug(yank);
    await this.rollTo(this.stage.full - yank, 130, EASE.out);
    await new Promise((r) => setTimeout(r, 160));
    if (gen !== this.gen) return;
    await this.rollTo(this.stage.full, 220, EASE.bounce);
    if (gen === this.gen) this.scheduleTug();
  }

  /** An answer landed: one glove off for a thumbs-up; the blind jerks up. */
  async cheer(): Promise<void> {
    const t = this.toon;
    if (!(t && this.holding) || this.reduced) return;
    const gen = this.gen;
    this.stopTugs();
    this.stage.sfx("honk");
    const jerk = 12;
    void this.rollTo(this.stage.full - jerk, 160, EASE.out);
    void t.to({ lift: (200 / LEAD_SIZE) * jerk }, 160, EASE.out);
    await t.thumbsWhileHolding();
    if (gen !== this.gen) return;
    void t.to({ lift: 0 }, 200, EASE.bounce);
    await this.rollTo(this.stage.full, 200, EASE.bounce);
    if (gen === this.gen) this.scheduleTug();
  }

  /**
   * Beats 3 and 4: the blind snaps up, the lead rides it, lets go, drops
   * under the notch and is relieved. `onRollUp` fires once the fabric is
   * gone (the panel can unmount), `onRelief(false)` once the lead is back
   * in the notch.
   */
  async close(
    onRollUp: () => void,
    onRelief: (on: boolean) => void,
  ): Promise<void> {
    const gen = ++this.gen;
    this.stopTugs();
    this.holding = false;
    const t = this.toon;
    if (!t || this.reduced) {
      this.setDrop(0);
      onRollUp();
      this.toon?.destroy();
      this.toon = null;
      onRelief(false);
      return;
    }
    onRelief(true);
    this.stage.sfx("rollup");
    t.shadow(false);
    t.kick(true);
    void t.to(
      {
        grit: 0,
        mouthOpen: 0.85,
        smile: -0.3,
        eyeScale: 1.3,
        lid: 0,
        lidTilt: 0,
        brow: 1,
        browTilt: 0,
      },
      120,
      EASE.out,
    );
    await this.rollTo(0, 380, EASE.in);
    if (gen !== this.gen) return;
    onRollUp();
    // Let go just under the notch and drop onto the stage below it.
    t.kick(false);
    const k = LEAD_SIZE / 200;
    const [, by, , bh] = (CAST[this.cast.body] ?? CAST.bear).box;
    const fromY = this.ringY() + REACH - by * k;
    const toY = this.stage.reliefFloor - (by + bh + LEG) * k;
    this.fallY = fromY;
    const relief = t.letGo();
    await this.animate("falling", fromY, Math.max(fromY, toY), 260, EASE.in);
    t.shadow(true);
    this.stage.sfx("phew");
    await relief;
    if (gen !== this.gen) return;
    this.stage.sfx("zip");
    await t.depart();
    if (gen !== this.gen) return;
    t.destroy();
    if (this.toon === t) this.toon = null;
    this.fallY = 0;
    onRelief(false);
  }

  destroy(): void {
    this.gen++;
    this.stopTugs();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.toon?.destroy();
    this.toon = null;
  }
}
