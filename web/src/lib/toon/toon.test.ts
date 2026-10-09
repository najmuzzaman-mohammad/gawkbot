import { afterEach, describe, expect, it } from "vitest";

import { AVATAR_SHAPES } from "../blobAvatar";
import { CAST } from "./cast";
import { type GlovePose, gloveMarkup } from "./glove";
import { paintFor } from "./paint";
import { REST, ToonRig } from "./rig";
import { FACE_POSES, Toon } from "./toon";

const EXTREMES = [
  { ...REST },
  {
    ...REST,
    yaw: 1,
    pitch: -1,
    lookX: -1,
    lookY: 1,
    lid: 1,
    lidLow: 1,
    lidTilt: 1,
  },
  { ...REST, mouthOpen: 1, smile: -1, mouthW: 1.6, brow: -1, browTilt: -1 },
  { ...REST, grit: 1, sx: 0.05, sy: 1.6, rot: 30, lift: 200, legs: 0 },
  { ...REST, armLx: 0, armLy: 0, armRx: -120, armRy: -160, armRrot: 90 },
];

function attrs(svg: SVGSVGElement): string[] {
  return Array.from(svg.querySelectorAll("*")).flatMap((n) =>
    Array.from(n.attributes).map((a) => a.value),
  );
}

describe("toon bodies", () => {
  it("has a hand-drawn body for every avatar shape", () => {
    // Coverage: the cast must keep up with the shape list.
    expect(Object.keys(CAST).sort()).toEqual([...AVATAR_SHAPES].sort());
    for (const shape of AVATAR_SHAPES) {
      const body = CAST[shape];
      const main = body.parts.find(
        (p) => p.tone === "base" || p.tone === "cream",
      );
      expect(main?.d.startsWith("M")).toBe(true);
      // Inside the 200-unit box, and most of it.
      expect(body.box[2]).toBeGreaterThan(120);
      expect(body.box[3]).toBeGreaterThan(120);
      expect(body.box[0] + body.box[2]).toBeLessThanOrEqual(200);
      // Shoulders sit on the body, hips at its foot.
      for (const [x, y] of body.arms) {
        expect(x).toBeGreaterThanOrEqual(body.box[0] - 2);
        expect(x).toBeLessThanOrEqual(body.box[0] + body.box[2] + 2);
        expect(y).toBeGreaterThan(body.box[1]);
      }
    }
  });

  it("paints every swatch flat and a little filmic, with brown-black ink", () => {
    const p = paintFor("#5aa9ff");
    expect(p.base).not.toBe("#5aa9ff");
    for (const c of [p.base, p.tint, p.shade, p.cream, p.leaf]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(p.ink).not.toBe("#000000");
  });

  it("draws a glove in every pose, white over ink", () => {
    for (const pose of [
      "open",
      "fist",
      "point",
      "thumb",
      "grip",
      "flat",
    ] as GlovePose[]) {
      const m = gloveMarkup(pose, "#fff", "#000");
      expect(m).toContain('fill="#000"');
      expect(m).toContain('fill="#fff"');
    }
  });
});

describe("ToonRig", () => {
  it("draws every body through extreme poses without a broken number", () => {
    for (const body of AVATAR_SHAPES) {
      const rig = new ToonRig({
        body,
        color: "#ff7a59",
        arms: true,
        legs: true,
        boil: true,
      });
      for (const pose of EXTREMES) {
        rig.setGloves("grip", "thumb");
        rig.draw(pose);
        const bad = attrs(rig.svg).filter((v) =>
          /NaN|Infinity|undefined/.test(v),
        );
        expect(bad, `${body}`).toEqual([]);
      }
      // Flat paint only: no gradients anywhere in the drawing.
      expect(
        rig.svg.querySelector("linearGradient, radialGradient"),
      ).toBeNull();
      // Pie-cut pupils, inked whites, a mouth, two gloves.
      expect(rig.svg.querySelectorAll(".toon-glove").length).toBe(2);
      expect(rig.svg.querySelectorAll(".toon-eye").length).toBe(2);
    }
  });

  it("leaves arms and legs off a list-size mark", () => {
    const rig = new ToonRig({
      body: "lemon",
      color: "#ff6b8b",
      arms: false,
      legs: false,
    });
    rig.draw(REST);
    // No glove capsules, no arm or leg hoses.
    expect(rig.svg.querySelectorAll("line")).toHaveLength(0);
    expect(
      rig.svg.querySelectorAll(
        'path[stroke-width="6.5"], path[stroke-width="8"]',
      ),
    ).toHaveLength(0);
    expect(rig.ground()).toBe(CAST.lemon.box[1] + CAST.lemon.box[3]);
  });
});

describe("Toon", () => {
  const original = window.matchMedia;
  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: original,
    });
    document.body.innerHTML = "";
  });

  function reduce(on: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (q: string) => ({
        matches: on && q.includes("reduce"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  }

  it("ends every move in its final pose at once under reduced motion", async () => {
    reduce(true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const t = new Toon(host, { body: "flower", color: "#5aa9ff", size: 80 });
    expect(t.reduced).toBe(true);
    // None of these may hang waiting on a frame that never comes.
    await t.birth();
    await t.wave();
    await t.clap();
    await t.hop();
    await t.holdDown(10);
    await t.tug();
    await t.letGo();
    await t.flyTo(40, -20);
    expect(t.root.style.translate).toBe("40px -20px");
    await t.depart();
    expect(t.root.style.opacity).toBe("0");
    t.destroy();
    expect(host.children).toHaveLength(0);
  });

  it("has a pose for every face the app uses", () => {
    for (const face of [
      "calm",
      "working",
      "sleepy",
      "asking",
      "oops",
      "happy",
    ] as const) {
      expect(Object.keys(FACE_POSES[face]).length).toBeGreaterThan(0);
    }
  });
});
