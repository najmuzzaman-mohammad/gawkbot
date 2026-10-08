import { describe, expect, it } from "vitest";

import {
  AVATAR_SHAPES,
  blobColor,
  blobShapeIndex,
  SILHOUETTES,
} from "./blobAvatar";
import { silhouetteOutline, smoothBlob } from "./blobAvatarSmooth";

describe("smoothBlob", () => {
  it("keeps each bot's colour from the pixel system", () => {
    for (const slug of ["cos", "gemini", "codex", "designer"]) {
      expect(smoothBlob(slug).color).toBe(blobColor(slug));
    }
  });

  it("is deterministic", () => {
    expect(smoothBlob("gemini").d).toBe(smoothBlob("gemini").d);
  });

  it("traces every silhouette as one closed body plus two eye holes", () => {
    for (let i = 0; i < SILHOUETTES.length; i++) {
      const outline = silhouetteOutline(i);
      expect(outline.length).toBeGreaterThan(4);
      for (const [x, y] of outline) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(16);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(16);
      }
    }
    const d = smoothBlob("cos").d;
    // body + 2 eyes = 3 subpaths, each closed
    expect(d.match(/Z/g)?.length).toBe(3);
    expect(d).not.toMatch(/NaN|Infinity/);
    // The body outline is the first closed subpath of d, eyes excluded.
    const { body } = smoothBlob("cos");
    expect(d.startsWith(body)).toBe(true);
    expect(body.match(/Z/g)?.length).toBe(1);
  });

  it("narrows the eyes as openness drops, without closing them", () => {
    const open = smoothBlob("cos", 1).eyes[0].h;
    const narrow = smoothBlob("cos", 0).eyes[0].h;
    expect(narrow).toBeLessThan(open);
    expect(narrow).toBeGreaterThan(0);
  });

  it("draws a chosen shape and colour, and falls back per field", () => {
    const slug = "cos";
    const other =
      AVATAR_SHAPES[(blobShapeIndex(slug) + 1) % AVATAR_SHAPES.length];
    const chosen = smoothBlob(slug, 1, { shape: other, color: "#0a0b0c" });
    expect(chosen.color).toBe("#0a0b0c");
    expect(chosen.body).not.toBe(smoothBlob(slug).body);
    // Same look, any slug: the mark is a function of the look alone.
    expect(
      smoothBlob("someone-else", 1, { shape: other, color: "#0a0b0c" }).d,
    ).toBe(chosen.d);
    // Colour only: the slug keeps its own shape.
    const tinted = smoothBlob(slug, 1, { color: "#0a0b0c" });
    expect(tinted.body).toBe(smoothBlob(slug).body);
    expect(tinted.color).toBe("#0a0b0c");
    // Garbage degrades to the derived look rather than to nothing.
    expect(smoothBlob(slug, 1, { shape: "nope", color: "blue" }).d).toBe(
      smoothBlob(slug).d,
    );
  });
});
