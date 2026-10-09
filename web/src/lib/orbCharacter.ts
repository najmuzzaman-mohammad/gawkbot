// orbCharacter.ts — a bot as a character, not an icon.
//
// The orb (vendor/orb-mascot) draws a body and a face. A character adds the
// things that make it feel alive on a stage: a glossy 3D shade and tall
// eyes, two floating mitten hands in the body's colour, a soft glow behind
// it, a contact shadow under it, and a small repertoire of moves:
//
//   birth()     pops into being: a flash of glow, a burst of sparkles, the
//               body overshoots and settles, the hands pop out and it waves
//   wave()      a hello with the right hand
//   point(deg)  a hand reaches toward a direction and the eyes follow it
//   clap()      both hands meet twice, with sparkles: something went well
//   hop()       a squash, a jump, a squash on landing
//   flyTo(x,y)  flies along an arc to a point, leaning into the turn, hands
//               trailing, sparkles streaming behind it; lands with a squash
//   depart()    hops and shrinks away upward, as into the notch
//
// No framework: plain DOM and the Web Animations API, so the notch, the
// office and the website (bundled by scripts/website-orb-build.sh) run the
// same character. Every move resolves immediately and changes nothing but
// the final pose when the person has asked for reduced motion.

import "../styles/orb-character.css";

import type { AvatarShape } from "../api/memberTypes";
import {
  type Mascot,
  ORB_VIEWBOX,
  OrbFull,
  prefersReducedMotion,
} from "./orbAvatar";

export interface CharacterOptions {
  body: AvatarShape;
  /** Body colour, #rrggbb. */
  color: string;
  /** Rendered size of the body in CSS pixels. */
  size: number;
  /** Floating hands. Default true. */
  hands?: boolean;
  /** A glow behind the body. Default true. */
  glow?: boolean;
  /** Eyes follow the pointer, idle wander, breathing. Default true. */
  live?: boolean;
}

/** Converts #rrggbb to "r g b" for rgb(... / a) mixes. */
function rgbTriple(hex: string): string {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  if (Number.isNaN(n)) return "255 255 255";
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";

function done(a: Animation | undefined): Promise<void> {
  if (!a) return Promise.resolve();
  return a.finished.then(
    () => undefined,
    () => undefined,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OrbCharacter {
  /** The positioned wrapper; place it with CSS, move it with flyTo(). */
  readonly root: HTMLDivElement;
  readonly mascot: Mascot;
  private readonly bodyBox: HTMLDivElement;
  private readonly glowEl: HTMLDivElement | null;
  private readonly shadowEl: HTMLDivElement;
  private readonly handL: HTMLSpanElement | null;
  private readonly handR: HTMLSpanElement | null;
  private readonly floatAnims: Animation[] = [];
  private readonly size: number;
  private readonly reduced: boolean;
  private x = 0;
  private y = 0;
  private destroyed = false;

  constructor(host: HTMLElement, opts: CharacterOptions) {
    this.size = opts.size;
    // No Web Animations (an old engine, a test DOM): every move is a pose.
    this.reduced =
      prefersReducedMotion() ||
      typeof HTMLElement.prototype.animate !== "function";
    const s = opts.size;
    const root = document.createElement("div");
    root.className = "orb-char";
    root.style.setProperty("--oc-size", `${s}px`);
    root.style.setProperty("--oc-rgb", rgbTriple(opts.color));
    root.style.setProperty("--oc-color", opts.color);

    this.glowEl = opts.glow === false ? null : document.createElement("div");
    if (this.glowEl) {
      this.glowEl.className = "orb-char-glow";
      root.appendChild(this.glowEl);
    }
    this.shadowEl = document.createElement("div");
    this.shadowEl.className = "orb-char-shadow";
    root.appendChild(this.shadowEl);

    this.bodyBox = document.createElement("div");
    this.bodyBox.className = "orb-char-body";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("viewBox", ORB_VIEWBOX);
    this.bodyBox.appendChild(svg);
    root.appendChild(this.bodyBox);

    if (opts.hands === false) {
      this.handL = null;
      this.handR = null;
    } else {
      this.handL = document.createElement("span");
      this.handL.className = "orb-char-hand is-left";
      this.handR = document.createElement("span");
      this.handR.className = "orb-char-hand is-right";
      root.appendChild(this.handL);
      root.appendChild(this.handR);
    }
    host.appendChild(root);
    this.root = root;

    const live = opts.live !== false && !this.reduced;
    this.mascot = new OrbFull(svg, {
      preset: live ? "hero" : "avatar",
      body: opts.body,
      color: opts.color,
      shade: "glossy",
      eye: "pill",
      tap: live,
      autoBlink: true,
    });
    this.mascot.setNow({ eyeScale: 1.12 });
    if (live) this.mascot.start();
    else this.mascot.render();
    this.float();
  }

  /** Gentle bob of the hands, each on its own phase, forever. */
  private float(): void {
    if (this.reduced) return;
    const amp = Math.max(1.5, this.size * 0.025);
    for (const [hand, delay] of [
      [this.handL, 0],
      [this.handR, 600],
    ] as const) {
      if (!hand) continue;
      this.floatAnims.push(
        hand.animate(
          [
            { translate: "0 0" },
            { translate: `0 ${-amp}px` },
            { translate: "0 0" },
          ],
          {
            duration: 2200,
            delay,
            iterations: Number.POSITIVE_INFINITY,
            easing: "ease-in-out",
          },
        ),
      );
    }
  }

  /** Sparkles flying out from the body's centre. */
  burst(count = 14, spread = 1.2): void {
    if (this.reduced || this.destroyed) return;
    const s = this.size;
    for (let i = 0; i < count; i++) {
      const p = document.createElement("i");
      p.className = "orb-char-spark";
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const d = s * (0.55 + Math.random() * 0.45) * spread;
      const k = 0.5 + Math.random() * 0.9;
      p.style.setProperty("--k", String(k));
      this.root.appendChild(p);
      const anim = p.animate(
        [
          { transform: "translate(-50%, -50%) scale(0.2)", opacity: 1 },
          {
            transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(${k})`,
            opacity: 0,
          },
        ],
        { duration: 700 + Math.random() * 400, easing: EASE_OUT },
      );
      void done(anim).then(() => p.remove());
    }
  }

  /**
   * Pops into being: glow flash, sparkle burst, overshoot, hands, and a
   * wave unless `wave` is false.
   */
  async birth(opts: { wave?: boolean } = {}): Promise<void> {
    if (this.reduced) return;
    this.glowEl?.animate(
      [
        { opacity: 0, transform: "translate(-50%, -50%) scale(0.2)" },
        {
          opacity: 1,
          transform: "translate(-50%, -50%) scale(1.25)",
          offset: 0.35,
        },
        { opacity: 0.85, transform: "translate(-50%, -50%) scale(1)" },
      ],
      { duration: 1100, easing: EASE_OUT },
    );
    const body = this.bodyBox.animate(
      [
        { transform: "scale(0, 0)", opacity: 0 },
        { transform: "scale(1.16, 0.9)", opacity: 1, offset: 0.45 },
        { transform: "scale(0.94, 1.06)", offset: 0.7 },
        { transform: "scale(1, 1)" },
      ],
      { duration: 760, easing: "ease-out" },
    );
    this.shadowEl.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 600,
      easing: EASE_OUT,
    });
    setTimeout(() => this.burst(18, 1.4), 180);
    for (const hand of [this.handL, this.handR]) {
      hand?.animate(
        [
          { scale: "0", opacity: 0 },
          { scale: "0", opacity: 0, offset: 0.4 },
          { scale: "1.2", opacity: 1, offset: 0.75 },
          { scale: "1", opacity: 1 },
        ],
        { duration: 900, easing: "ease-out" },
      );
    }
    this.mascot.run("surprise");
    await done(body);
    if (opts.wave === false) return;
    await wait(150);
    await this.wave();
  }

  /** A hello with the right hand. */
  async wave(times = 2): Promise<void> {
    if (this.reduced || !this.handR) return;
    const s = this.size;
    const lift = `${-s * 0.3}px`;
    const frames: Keyframe[] = [{ translate: "0 0", rotate: "0deg" }];
    for (let i = 0; i < times; i++) {
      frames.push({ translate: `${s * 0.04}px ${lift}`, rotate: "-22deg" });
      frames.push({ translate: `${s * 0.1}px ${lift}`, rotate: "22deg" });
    }
    frames.push({ translate: "0 0", rotate: "0deg" });
    await done(
      this.handR.animate(frames, {
        duration: 420 * times + 300,
        easing: "ease-in-out",
      }),
    );
  }

  /**
   * Reaches a hand toward `deg` (0 right, 90 down) and looks that way.
   * Pass null to bring the hand back and look ahead again.
   */
  point(deg: number | null): void {
    if (deg === null) {
      this.mascot.look(0, 0);
      for (const h of [this.handL, this.handR]) {
        h?.animate([{ translate: "0 0" }], {
          duration: 260,
          fill: "forwards",
          easing: EASE_OUT,
        });
      }
      return;
    }
    const r = (deg * Math.PI) / 180;
    this.mascot.look(Math.cos(r) * 18, Math.sin(r) * 12);
    if (this.reduced) return;
    const hand = Math.cos(r) >= 0 ? this.handR : this.handL;
    const reach = this.size * 0.22;
    hand?.animate(
      [{ translate: `${Math.cos(r) * reach}px ${Math.sin(r) * reach}px` }],
      { duration: 320, fill: "forwards", easing: SPRING },
    );
  }

  /** Both hands meet twice in front, with sparkles. */
  async clap(): Promise<void> {
    if (this.reduced || !this.handL || !this.handR) return;
    const s = this.size;
    const inward = s * 0.32;
    const opts = { duration: 520, easing: "ease-in-out" };
    const l = this.handL.animate(
      [
        { translate: "0 0" },
        { translate: `${inward}px ${-s * 0.06}px` },
        { translate: `${inward * 0.6}px 0` },
        { translate: `${inward}px ${-s * 0.06}px` },
        { translate: "0 0" },
      ],
      opts,
    );
    this.handR.animate(
      [
        { translate: "0 0" },
        { translate: `${-inward}px ${-s * 0.06}px` },
        { translate: `${-inward * 0.6}px 0` },
        { translate: `${-inward}px ${-s * 0.06}px` },
        { translate: "0 0" },
      ],
      opts,
    );
    setTimeout(() => this.burst(10, 0.9), 140);
    // Star eyes and a grin for the clap, then back to whatever it was doing.
    const before = this.mascot.status;
    this.mascot.setStatus("success");
    await done(l);
    await wait(700);
    if (!this.destroyed) this.mascot.setStatus(before);
  }

  /** Squash, jump, squash on landing. */
  async hop(height = 0.35): Promise<void> {
    if (this.reduced) return;
    const h = this.size * height;
    const a = this.root.animate(
      [
        { translate: `${this.x}px ${this.y}px`, scale: "1 1" },
        {
          translate: `${this.x}px ${this.y}px`,
          scale: "1.12 0.86",
          offset: 0.18,
        },
        {
          translate: `${this.x}px ${this.y - h}px`,
          scale: "0.94 1.08",
          offset: 0.5,
        },
        {
          translate: `${this.x}px ${this.y}px`,
          scale: "1.1 0.9",
          offset: 0.82,
        },
        { translate: `${this.x}px ${this.y}px`, scale: "1 1" },
      ],
      { duration: 620, easing: "ease-in-out" },
    );
    this.shadowEl.animate(
      [
        { transform: "translateX(-50%) scale(1)", opacity: 1 },
        { transform: "translateX(-50%) scale(0.6)", opacity: 0.5, offset: 0.5 },
        { transform: "translateX(-50%) scale(1)", opacity: 1 },
      ],
      { duration: 620, easing: "ease-in-out" },
    );
    await done(a);
  }

  /** Moves without animating (relative to where the character was placed). */
  placeAt(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.root.style.translate = `${x}px ${y}px`;
  }

  /**
   * Flies to (x, y), relative to where the character was placed, along an
   * arc `lift` px above the straight line, leaning into the flight, hands
   * trailing and sparkles streaming behind. Lands with a squash.
   */
  async flyTo(
    x: number,
    y: number,
    opts: {
      duration?: number;
      lift?: number;
      trail?: boolean;
      /** The arc's control point, instead of one `lift` above the middle. */
      via?: { x: number; y: number };
    } = {},
  ): Promise<void> {
    const fromX = this.x;
    const fromY = this.y;
    this.x = x;
    this.y = y;
    if (this.reduced) {
      this.root.style.translate = `${x}px ${y}px`;
      return;
    }
    const duration = opts.duration ?? 900;
    const lift =
      opts.lift ?? Math.min(160, Math.hypot(x - fromX, y - fromY) * 0.35);
    const dir = x >= fromX ? 1 : -1;
    // A quadratic bezier through a control point above the midpoint.
    const cx = opts.via?.x ?? (fromX + x) / 2;
    const cy = opts.via?.y ?? Math.min(fromY, y) - lift;
    const steps = 24;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = (1 - t) ** 2 * fromX + 2 * (1 - t) * t * cx + t * t * x;
      const py = (1 - t) ** 2 * fromY + 2 * (1 - t) * t * cy + t * t * y;
      // Lean into the flight, most in the middle; stretch along it.
      const lean = Math.sin(Math.PI * t) * 14 * dir;
      const stretch = 1 + Math.sin(Math.PI * t) * 0.08;
      frames.push({
        translate: `${px}px ${py}px`,
        rotate: `${lean}deg`,
        scale: `${2 - stretch} ${stretch}`,
      });
    }
    frames.push({
      translate: `${x}px ${y}px`,
      rotate: "0deg",
      scale: "1.12 0.88",
    });
    frames.push({ translate: `${x}px ${y}px`, rotate: "0deg", scale: "1 1" });
    this.mascot.look(dir * 18, -4);
    const trail =
      opts.trail === false
        ? 0
        : window.setInterval(() => this.spawnTrail(), 45);
    const anim = this.root.animate(frames, {
      duration: duration + 220,
      easing: "linear",
      fill: "forwards",
    });
    // The hands lag behind the body, the way loose mittens would.
    for (const h of [this.handL, this.handR]) {
      h?.animate(
        [
          { translate: "0 0" },
          {
            translate: `${-dir * this.size * 0.14}px ${this.size * 0.05}px`,
            offset: 0.5,
          },
          { translate: "0 0" },
        ],
        { duration, easing: "ease-in-out" },
      );
    }
    await done(anim);
    if (trail) window.clearInterval(trail);
    this.root.style.translate = `${x}px ${y}px`;
    anim.cancel();
    this.mascot.look(0, 0);
  }

  /** One sparkle left where the character is right now. */
  private spawnTrail(): void {
    if (this.destroyed || !this.root.parentElement) return;
    const host = this.root.parentElement;
    const r = this.root.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const p = document.createElement("i");
    p.className = "orb-char-spark is-trail";
    p.style.left = `${r.left - hr.left + r.width / 2 + (Math.random() - 0.5) * this.size * 0.4}px`;
    p.style.top = `${r.top - hr.top + r.height * 0.55 + (Math.random() - 0.5) * this.size * 0.3}px`;
    p.style.setProperty(
      "--oc-rgb",
      this.root.style.getPropertyValue("--oc-rgb"),
    );
    host.appendChild(p);
    void done(
      p.animate(
        [
          { transform: "translate(-50%, -50%) scale(1)", opacity: 0.95 },
          { transform: "translate(-50%, -50%) scale(0.1)", opacity: 0 },
        ],
        { duration: 650, easing: EASE_OUT },
      ),
    ).then(() => p.remove());
  }

  /** A happy hop, then it shrinks away upward, as into the notch. */
  async depart(): Promise<void> {
    if (this.reduced) {
      this.root.style.opacity = "0";
      return;
    }
    await this.hop(0.25);
    this.burst(8, 0.7);
    await done(
      this.root.animate(
        [
          { translate: `${this.x}px ${this.y}px`, scale: "1", opacity: 1 },
          {
            translate: `${this.x}px ${this.y - this.size * 1.4}px`,
            scale: "0.15",
            opacity: 0,
          },
        ],
        {
          duration: 520,
          easing: "cubic-bezier(0.55, 0, 0.75, 0)",
          fill: "forwards",
        },
      ),
    );
  }

  destroy(): void {
    this.destroyed = true;
    for (const a of this.floatAnims) a.cancel();
    this.mascot.stop();
    this.root.remove();
  }
}

/**
 * A field of twinkling stars on a canvas that fills `host`: two drifting
 * curtains either side of the centre, the backdrop of a character's stage.
 * Returns a stop function. Draws one still frame under reduced motion.
 */
export function mountStarfield(
  host: HTMLElement,
  opts: { density?: number } = {},
): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "orb-stars";
  host.appendChild(canvas);
  const g = canvas.getContext("2d");
  if (!g) return () => canvas.remove();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const count = Math.round(
    (opts.density ?? 1) *
      Math.max(60, (host.clientWidth * host.clientHeight) / 900),
  );
  const stars = Array.from({ length: count }, () => {
    const left = Math.random() < 0.5;
    // Bunched into a band either side of the centre, like the reference
    // curtains of dust, thinning toward the middle.
    const band = left ? 0.08 + Math.random() * 0.3 : 0.62 + Math.random() * 0.3;
    return {
      x: band,
      y: Math.random(),
      r: 0.3 + Math.random() * 1.2,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 1.4,
      drift: (Math.random() - 0.5) * 0.004,
    };
  });
  let raf = 0;
  let last = performance.now();
  const resize = () => {
    canvas.width = Math.max(1, host.clientWidth * dpr);
    canvas.height = Math.max(1, host.clientHeight * dpr);
  };
  resize();
  const draw = (now: number) => {
    const dt = Math.min(64, now - last);
    last = now;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#ffffff";
    for (const s of stars) {
      s.y -= s.drift * dt * 0.06;
      if (s.y < 0) s.y += 1;
      if (s.y > 1) s.y -= 1;
      g.globalAlpha =
        0.2 + 0.8 * Math.abs(Math.sin(s.phase + now * 0.0015 * s.speed));
      g.beginPath();
      g.arc(s.x * canvas.width, s.y * canvas.height, s.r * dpr, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  };
  if (prefersReducedMotion()) draw(last);
  else raf = requestAnimationFrame(draw);
  window.addEventListener("resize", resize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    canvas.remove();
  };
}
