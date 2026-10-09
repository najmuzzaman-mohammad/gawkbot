// fx.ts — cartoon effects: sweat drops that fly off, twinkle stars, smoke
// puffs, an exclamation pop. Particles live in a toon's own drawing (rig
// units) and are stepped by the toon's frame loop; trail puffs for flights
// are dropped into the page behind the character instead (worldPuff).

import { INK } from "./paint";
import { dropPath, starPath } from "./rig";

const NS = "http://www.w3.org/2000/svg";
const SWEAT = "#9fdcff";
const STAR = "#ffe27a";
const PUFF = "#fff6e4";

interface Particle {
  el: SVGElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived, and total. */
  t: number;
  life: number;
  spin: number;
  size: number;
  kind: "sweat" | "star" | "puff" | "bang";
}

export class Fx {
  private readonly parts: Particle[] = [];

  constructor(private readonly layer: SVGGElement) {}

  get busy(): boolean {
    return this.parts.length > 0;
  }

  private add(
    kind: Particle["kind"],
    init: Omit<Particle, "el" | "kind" | "t">,
  ): void {
    const g = document.createElementNS(NS, "g");
    if (kind === "sweat") {
      g.innerHTML = `<path d="${dropPath(0, 0, 6.5)}" fill="${SWEAT}" stroke="${INK}" stroke-width="2.4"/><circle cx="-2.2" cy="-2.4" r="1.8" fill="#fff"/>`;
    } else if (kind === "star") {
      g.innerHTML = `<path d="${starPath(0, 0, 13)}" fill="${STAR}" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>`;
    } else if (kind === "puff") {
      g.innerHTML = `<circle r="13" fill="${PUFF}" stroke="${INK}" stroke-width="2.6"/>`;
    } else {
      g.innerHTML = `<path d="M-4 -26 L4 -26 L2 -6 L-2 -6 Z" fill="${STAR}" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/><circle cy="2" r="3.4" fill="${STAR}" stroke="${INK}" stroke-width="2.4"/>`;
    }
    this.layer.appendChild(g);
    this.parts.push({ ...init, el: g, kind, t: 0 });
  }

  /** A bead of sweat leaping off the brow at (x, y), away to `side`. */
  sweat(x: number, y: number, side: number): void {
    this.add("sweat", {
      x,
      y,
      vx: side * (40 + Math.random() * 40),
      vy: -90 - Math.random() * 40,
      life: 0.75,
      spin: side * 140,
      size: 1,
    });
  }

  /** A ring of twinkles bursting out from (x, y). */
  stars(x: number, y: number, n = 6, reach = 1): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const v = (90 + Math.random() * 70) * reach;
      this.add("star", {
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 30,
        life: 0.7 + Math.random() * 0.3,
        spin: (Math.random() - 0.5) * 400,
        size: 0.6 + Math.random() * 0.6,
      });
    }
  }

  /** A cartoon smoke cloud: puffs swelling out of (x, y). "Poof!" */
  poof(x: number, y: number, n = 9, reach = 1): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const v = (60 + Math.random() * 40) * reach;
      this.add("puff", {
        x: x + Math.cos(a) * 10,
        y: y + Math.sin(a) * 8,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v * 0.7,
        life: 0.55 + Math.random() * 0.2,
        spin: 0,
        size: 1.5 + Math.random() * 1.3,
      });
    }
  }

  /** A "!" that pops up over (x, y). */
  bang(x: number, y: number): void {
    this.add("bang", { x, y, vx: 0, vy: -40, life: 0.9, spin: 0, size: 1.3 });
  }

  step(dt: number): void {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) {
        p.el.remove();
        this.parts.splice(i, 1);
        continue;
      }
      let scale = p.size;
      let opacity = 1;
      if (p.kind === "sweat") {
        p.vy += 520 * dt;
        opacity = 1 - k * k;
      } else if (p.kind === "star") {
        p.vx *= 1 - 3 * dt;
        p.vy = p.vy * (1 - 3 * dt) + 60 * dt;
        scale = p.size * (k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8);
      } else if (p.kind === "puff") {
        p.vx *= 1 - 5 * dt;
        p.vy = p.vy * (1 - 5 * dt) - 30 * dt;
        scale =
          p.size * (k < 0.3 ? 0.4 + (k / 0.3) * 0.6 : 1 - (k - 0.3) * 1.2);
        opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      } else {
        p.vy *= 1 - 6 * dt;
        scale =
          p.size *
          (k < 0.15
            ? (k / 0.15) * 1.2
            : k < 0.3
              ? 1.2 - ((k - 0.15) / 0.15) * 0.2
              : 1);
        opacity = k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const rot = p.spin * p.t;
      p.el.setAttribute(
        "transform",
        `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${rot.toFixed(0)}) scale(${Math.max(0.01, scale).toFixed(3)})`,
      );
      p.el.setAttribute("opacity", opacity.toFixed(3));
    }
  }

  clear(): void {
    for (const p of this.parts) p.el.remove();
    this.parts.length = 0;
  }
}

/**
 * A dust puff left in the page at (x, y) px inside `host`: for flight
 * trails, so the puffs stay where they were made as the character flies on.
 */
export function worldPuff(
  host: HTMLElement,
  x: number,
  y: number,
  r: number,
): void {
  if (typeof HTMLElement.prototype.animate !== "function") return;
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "-12 -12 24 24");
  s.setAttribute("aria-hidden", "true");
  s.classList.add("toon-puff");
  s.style.cssText = `position:absolute;left:${x - r}px;top:${y - r}px;width:${r * 2}px;height:${r * 2}px;pointer-events:none;overflow:visible`;
  s.innerHTML = `<circle r="10" fill="${PUFF}" stroke="${INK}" stroke-width="2.2"/>`;
  host.appendChild(s);
  const a = s.animate(
    [
      { transform: "scale(0.3)", opacity: 1 },
      { transform: "scale(1)", opacity: 1, offset: 0.35 },
      { transform: "scale(0.2) translateY(-6px)", opacity: 0 },
    ],
    { duration: 520, easing: "ease-out" },
  );
  a.finished.then(
    () => s.remove(),
    () => s.remove(),
  );
}
