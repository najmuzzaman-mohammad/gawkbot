import { describe, expect, it } from "vitest";

import { AVATAR_COLORS, AVATAR_SHAPES, blobColor } from "./blobAvatar";
import {
  bodyPath,
  type Expression,
  GAWK_VIEW,
  gawkAvatarSvg,
  gawkMark,
  gawkMarkSvg,
  INK,
  tones,
} from "./gawkAvatar";

const EXPRESSIONS: Expression[] = [
  "calm",
  "focus",
  "sleepy",
  "ask",
  "oops",
  "happy",
];

describe("bodies", () => {
  it("every species is one closed curve inside the box", () => {
    for (let i = 0; i < AVATAR_SHAPES.length; i++) {
      const d = bodyPath(i);
      expect(d.startsWith("M")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
      expect(d.match(/Z/g)).toHaveLength(1);
      expect(d).not.toMatch(/NaN|Infinity/);
      for (const n of d.match(/-?\d+(\.\d+)?/g) ?? []) {
        expect(Number(n)).toBeGreaterThanOrEqual(-2);
        expect(Number(n)).toBeLessThanOrEqual(GAWK_VIEW + 2);
      }
    }
  });

  it("the eight species are eight different bodies", () => {
    const bodies = new Set(AVATAR_SHAPES.map((_, i) => bodyPath(i)));
    expect(bodies.size).toBe(AVATAR_SHAPES.length);
  });

  it("wraps an out-of-range index to the first species", () => {
    expect(bodyPath(99)).toBe(bodyPath(0));
  });
});

describe("tones", () => {
  it("derives a lighter and a darker tone from the base", () => {
    const lum = (hex: string) =>
      Number.parseInt(hex.slice(1, 3), 16) +
      Number.parseInt(hex.slice(3, 5), 16) +
      Number.parseInt(hex.slice(5, 7), 16);
    for (const c of AVATAR_COLORS) {
      const t = tones(c);
      expect(t.base).toBe(c);
      expect(lum(t.light)).toBeGreaterThan(lum(c));
      expect(lum(t.dark)).toBeLessThan(lum(c));
      expect(lum(t.deep)).toBeLessThan(lum(t.dark));
      for (const hex of [t.light, t.dark, t.deep]) {
        expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe("gawkMark", () => {
  it("is deterministic and keeps the bot's identity", () => {
    const a = gawkMark("gemini");
    const b = gawkMark("gemini");
    expect(a).toEqual(b);
    expect(a.color).toBe(blobColor("gemini"));
    expect(a.shape).toBe(AVATAR_SHAPES[a.shapeIndex]);
  });

  it("draws a chosen look, and the same look for any slug", () => {
    const look = { shape: "loaf", color: "#0a0b0c" } as const;
    const a = gawkMark("cos", { avatar: look });
    expect(a.shape).toBe("loaf");
    expect(a.color).toBe("#0a0b0c");
    expect(gawkMark("someone-else", { avatar: look })).toEqual(a);
    // A colour override beats the chosen colour (theme previews).
    expect(gawkMark("cos", { avatar: look, color: "#ffffff" }).color).toBe(
      "#ffffff",
    );
  });

  it("every expression has two eyes and a mouth", () => {
    for (const expression of EXPRESSIONS) {
      const m = gawkMark("cos", { expression });
      expect(m.eyes, expression).toHaveLength(2);
      for (const eye of m.eyes) {
        expect(eye.className).toContain("avatar-motion-eye");
      }
      // Something is drawn in ink below the eyes: the mouth.
      const inked = m.front.filter((p) => p.fill === INK || p.stroke === INK);
      expect(inked.length, expression).toBeGreaterThanOrEqual(1);
    }
  });

  it("the expressions look different from each other", () => {
    const faces = new Set(
      EXPRESSIONS.map((expression) =>
        JSON.stringify(gawkMark("cos", { expression }).front),
      ),
    );
    expect(faces.size).toBe(EXPRESSIONS.length);
  });

  it("openness narrows the eyes without ever shutting them", () => {
    const ry = (o: number) => {
      const [eye] = gawkMark("cos", { openness: o }).eyes;
      return eye.kind === "ellipse" ? eye.ry : Number.NaN;
    };
    expect(ry(0.5)).toBeLessThan(ry(1));
    expect(ry(0)).toBeLessThan(ry(0.5));
    expect(ry(0)).toBeGreaterThan(0);
    // Clamped, not extrapolated.
    expect(ry(7)).toBe(ry(1));
    expect(ry(-3)).toBe(ry(0));
  });

  it("a happy face closes its eyes into arcs", () => {
    const m = gawkMark("cos", { expression: "happy" });
    for (const eye of m.eyes) expect(eye.kind).toBe("path");
  });

  it("every species carries its accessory", () => {
    // Each species draws something beyond the shadow, the body and the face.
    for (let i = 0; i < AVATAR_SHAPES.length; i++) {
      const m = gawkMark("x", { avatar: { shape: AVATAR_SHAPES[i] } });
      const extras = m.behind.length - 1 + (m.front.length - 3);
      expect(extras, AVATAR_SHAPES[i]).toBeGreaterThan(0);
    }
  });
});

describe("string renderer", () => {
  it("renders a standalone svg with prefixed, unique ids", () => {
    const svg = gawkAvatarSvg("cos", 40, { prefix: "one" });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('width="40"');
    expect(svg).toContain(`viewBox="0 0 ${GAWK_VIEW} ${GAWK_VIEW}"`);
    expect(svg).toContain('id="one-body"');
    expect(svg).toContain('fill="url(#one-body)"');
    expect(svg).not.toContain("url(#G-");
    expect(svg).not.toMatch(/NaN|undefined/);
    // Two marks on one page with different prefixes never share an id.
    const other = gawkAvatarSvg("cos", 40, { prefix: "two" });
    const ids = (s: string) => new Set(s.match(/id="[^"]+"/g));
    for (const id of ids(svg)) expect(ids(other).has(id)).toBe(false);
  });

  it("clips highlights inside a group, so a rotated highlight stays in the body", () => {
    const inner = gawkMarkSvg(gawkMark("cos"), "p");
    expect(inner).toMatch(
      /<g clip-path="url\(#p-clip\)"><ellipse [^>]*transform="rotate\(/,
    );
    expect(inner).not.toMatch(/<ellipse [^>]*clip-path=/);
  });
});
