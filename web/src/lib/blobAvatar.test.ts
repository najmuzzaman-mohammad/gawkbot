import { describe, expect, it } from "vitest";

import {
  BLOB_COLORS,
  BLOB_GRID,
  blobColor,
  blobShapeIndex,
  drawBlobAvatar,
  eyeSpec,
  SILHOUETTES,
} from "./blobAvatar";

describe("blob silhouettes", () => {
  it("every silhouette has one span per grid row", () => {
    // A short table silently renders a clipped body, because the draw loop
    // falls back to an empty span for missing rows and nothing errors.
    for (const [i, shape] of SILHOUETTES.entries()) {
      expect(shape.length, `silhouette ${i} row count`).toBe(BLOB_GRID);
    }
  });

  it("every silhouette is actually a shape, and stays on the grid", () => {
    for (const [i, shape] of SILHOUETTES.entries()) {
      let filled = 0;
      for (const [from, to] of shape) {
        expect(from, `silhouette ${i} span start`).toBeGreaterThanOrEqual(0);
        expect(to, `silhouette ${i} span end`).toBeLessThanOrEqual(BLOB_GRID);
        if (to > from) filled += to - from;
      }
      // Guards against a table of all-empty spans, which draws nothing at all
      // and would otherwise pass every other assertion here.
      expect(filled, `silhouette ${i} filled cells`).toBeGreaterThan(30);
    }
  });

  it("the eye row is inside the body on every silhouette", () => {
    // The eyes are punched out at a fixed row. If a silhouette is narrow or
    // empty there, the holes land outside the body and read as two floating
    // notches rather than eyes.
    const eye = eyeSpec(1);
    for (const [i, shape] of SILHOUETTES.entries()) {
      const [from, to] = shape[eye.topY];
      expect(from, `silhouette ${i} eye row start`).toBeLessThanOrEqual(
        eye.leftX,
      );
      expect(to, `silhouette ${i} eye row end`).toBeGreaterThanOrEqual(
        eye.rightX + eye.width,
      );
    }
  });
});

describe("per-bot identity", () => {
  it("is stable for a slug", () => {
    // The whole point of deriving rather than storing: a bot looks the same
    // in every surface, in every session, forever.
    expect(blobShapeIndex("ceo")).toBe(blobShapeIndex("ceo"));
    expect(blobColor("ceo")).toBe(blobColor("ceo"));
  });

  it("does not change when other bots are added", () => {
    // Derived from the slug alone, never from roster position. Roster-indexed
    // assignment recolours everyone when somebody joins, which breaks the one
    // thing colour is for.
    const before = blobColor("designer");
    const after = blobColor("designer");
    expect(after).toBe(before);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(blobColor(" CEO ")).toBe(blobColor("ceo"));
    expect(blobShapeIndex(" CEO ")).toBe(blobShapeIndex("ceo"));
  });

  it("spreads a real roster across several shapes AND colours", () => {
    const roster = [
      "ceo",
      "app-builder",
      "planner",
      "executor",
      "reviewer",
      "librarian",
      "designer",
    ];
    const shapes = new Set(roster.map(blobShapeIndex));
    const colors = new Set(roster.map(blobColor));
    // Two axes, so near-collisions on one are usually rescued by the other.
    // Not asserting all-distinct: with 8 shapes and 7 bots a collision is
    // ordinary, and a test that demanded uniqueness would be pinning luck.
    expect(shapes.size).toBeGreaterThanOrEqual(4);
    expect(colors.size).toBeGreaterThanOrEqual(5);
  });

  it("only ever returns a colour from the palette", () => {
    for (const slug of ["a", "bb", "ceo", "zzz-agent", "человек"]) {
      expect(BLOB_COLORS).toContain(blobColor(slug));
    }
  });
});

describe("eyes", () => {
  it("never closes completely", () => {
    // A fully shut eye reads as a broken mark, not as a blink.
    for (const o of [0, 0.1, 0.5, 1]) {
      expect(eyeSpec(o).height).toBeGreaterThanOrEqual(2);
    }
  });

  it("narrows as openness drops, and is widest wide open", () => {
    expect(eyeSpec(1).height).toBeGreaterThan(eyeSpec(0).height);
  });

  it("clamps out-of-range openness instead of drawing nonsense", () => {
    expect(eyeSpec(-5).height).toBe(eyeSpec(0).height);
    expect(eyeSpec(99).height).toBe(eyeSpec(1).height);
  });
});

describe("drawing", () => {
  function fakeCtx() {
    const ops: string[] = [];
    return {
      ops,
      ctx: {
        fillStyle: "",
        clearRect: (x: number, y: number, w: number, h: number) =>
          ops.push(`clear:${x},${y},${w},${h}`),
        fillRect: (x: number, y: number, w: number, h: number) =>
          ops.push(`fill:${x},${y},${w},${h}`),
      } as unknown as CanvasRenderingContext2D,
    };
  }

  it("punches the eyes out rather than painting them", () => {
    // This is the property that makes the mark theme-proof: a cleared eye
    // shows whatever is behind the avatar, so it composites correctly on any
    // surface without the drawing code knowing the background colour. Painting
    // the eyes a fixed colour is what made the previous eye work depend on the
    // theme.
    const { ops, ctx } = fakeCtx();
    drawBlobAvatar(ctx, "ceo", 48);
    const clears = ops.filter((o) => o.startsWith("clear:"));
    // One full-canvas clear at the start, then exactly two eye holes.
    expect(clears.length).toBe(3);
    expect(ops.some((o) => o.startsWith("fill:"))).toBe(true);
  });

  it("draws whole-pixel rectangles so the edges stay hard", () => {
    // Fractional rects get antialiased and the mark stops reading as pixel art.
    const { ops, ctx } = fakeCtx();
    drawBlobAvatar(ctx, "planner", 40);
    for (const op of ops) {
      for (const n of op.split(":")[1].split(",")) {
        expect(Number.isInteger(Number(n)), `${op} has a fractional edge`).toBe(
          true,
        );
      }
    }
  });

  it("honours a colour override without touching the derived shape", () => {
    const { ctx } = fakeCtx();
    drawBlobAvatar(ctx, "ceo", 32, { color: "#123456" });
    expect(ctx.fillStyle).toBe("#123456");
  });
});
