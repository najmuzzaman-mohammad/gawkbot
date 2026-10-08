import { describe, expect, it } from "vitest";

import {
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  AVATAR_SHAPES,
  blobColor,
  blobShapeIndex,
  hasAvatarChoice,
  resolveAvatar,
} from "./blobAvatar";

describe("per-bot identity", () => {
  it("is stable for a slug", () => {
    // The whole point of deriving rather than storing: a bot looks the same
    // in every surface, in every session, forever.
    expect(blobShapeIndex("cos")).toBe(blobShapeIndex("cos"));
    expect(blobColor("cos")).toBe(blobColor("cos"));
  });

  it("does not change when other bots are added", () => {
    // Nothing here depends on a roster, so a new teammate cannot shuffle
    // everyone else's look.
    const before = [blobShapeIndex("gemini"), blobColor("gemini")];
    blobShapeIndex("someone-new");
    blobColor("someone-new");
    expect([blobShapeIndex("gemini"), blobColor("gemini")]).toEqual(before);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(blobShapeIndex("  Codex ")).toBe(blobShapeIndex("codex"));
    expect(blobColor("  Codex ")).toBe(blobColor("codex"));
  });

  it("spreads a real roster across several shapes AND colours", () => {
    const roster = [
      "cos",
      "gemini",
      "codex",
      "designer",
      "pm",
      "gtm-lead",
      "founding-engineer",
      "prospect-scout",
      "hermes",
      "ceo",
      "auth-refactor",
      "flaky-tests",
    ];
    const shapes = new Set(roster.map(blobShapeIndex));
    const colors = new Set(roster.map(blobColor));
    expect(shapes.size).toBeGreaterThanOrEqual(4);
    expect(colors.size).toBeGreaterThanOrEqual(5);
  });

  it("only ever returns a colour from the palette", () => {
    for (const slug of ["cos", "a", "", "zzz-zzz", "ünïcode"]) {
      expect(AVATAR_COLORS).toContain(blobColor(slug));
      expect(blobShapeIndex(slug)).toBeGreaterThanOrEqual(0);
      expect(blobShapeIndex(slug)).toBeLessThan(AVATAR_SHAPES.length);
    }
  });
});

describe("chosen avatars", () => {
  it("names every species, in the broker's wire order", () => {
    // WIRE CONTRACT with AvatarShapes in internal/team/broker_member_avatar.go.
    // The index IS the species, so a reorder here silently swaps bodies.
    expect(AVATAR_SHAPES).toEqual([
      "block",
      "dome",
      "drop",
      "bean",
      "pill",
      "loaf",
      "shield",
      "blob",
    ]);
    expect(AVATAR_COLOR_NAMES).toHaveLength(AVATAR_COLORS.length);
    for (const c of AVATAR_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("falls back to the derived look when nothing is chosen", () => {
    const derived = {
      shapeIndex: blobShapeIndex("cos"),
      color: blobColor("cos"),
    };
    expect(resolveAvatar("cos")).toEqual(derived);
    expect(resolveAvatar("cos", null)).toEqual(derived);
    expect(resolveAvatar("cos", {})).toEqual(derived);
  });

  it("lets each field win on its own", () => {
    expect(resolveAvatar("cos", { shape: "pill" })).toEqual({
      shapeIndex: AVATAR_SHAPES.indexOf("pill"),
      color: blobColor("cos"),
    });
    expect(resolveAvatar("cos", { color: "#112233" })).toEqual({
      shapeIndex: blobShapeIndex("cos"),
      color: "#112233",
    });
  });

  it("normalises case and degrades bad wire data to the derived field", () => {
    expect(resolveAvatar("cos", { shape: " LOAF ", color: "#AABBCC" })).toEqual(
      { shapeIndex: AVATAR_SHAPES.indexOf("loaf"), color: "#aabbcc" },
    );
    // Unknown shape, short hex, a CSS injection attempt: all ignored.
    for (const bad of [
      { shape: "star" },
      { color: "#abc" },
      { color: "red" },
      { color: "#000000;background:url(x)" },
    ]) {
      expect(resolveAvatar("cos", bad)).toEqual(resolveAvatar("cos"));
      expect(hasAvatarChoice(bad)).toBe(false);
    }
    expect(hasAvatarChoice({ shape: "dome" })).toBe(true);
    expect(hasAvatarChoice({ color: "#010203" })).toBe(true);
    expect(hasAvatarChoice(undefined)).toBe(false);
  });
});
