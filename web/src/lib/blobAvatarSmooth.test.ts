import { describe, expect, it } from "vitest";

import { blobColor, SILHOUETTES } from "./blobAvatar";
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
  });

  it("narrows the eyes as openness drops, without closing them", () => {
    const open = smoothBlob("cos", 1).eyes[0].h;
    const narrow = smoothBlob("cos", 0).eyes[0].h;
    expect(narrow).toBeLessThan(open);
    expect(narrow).toBeGreaterThan(0);
  });
});
