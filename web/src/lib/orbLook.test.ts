import { describe, expect, it } from "vitest";

import {
  ACCESSORIES,
  EYES,
  HAIR,
  hasLook,
  LOOK_LABELS,
  lookParts,
} from "./orbLook";

describe("a character's look", () => {
  it("draws nothing for no look, unknown values, or every part at none", () => {
    expect(lookParts(undefined, "#123456")).toEqual([]);
    expect(
      lookParts(
        { hair: "none", eyes: "default", accessory: "none" },
        "#123456",
      ),
    ).toEqual([]);
    expect(
      lookParts(
        { hair: "rainbow", eyes: "laser", accessory: "jetpack" },
        "#123456",
      ),
    ).toEqual([]);
    expect(hasLook({ hair: "none" })).toBe(false);
  });
  it("paints body wear behind the hair and head wear in front, in the body's colour", () => {
    const parts = lookParts(
      {
        hair: "bob",
        hair_color: "#ff00aa",
        eyes: "glasses",
        accessory: "scarf",
      },
      "#64d2ff",
    );
    expect(parts.map((p) => `${p.kind}:${p.id}`)).toEqual([
      "accessory:scarf",
      "hair:bob",
      "eyes:glasses",
    ]);
    expect(parts[0].color).toBe("#64d2ff");
    expect(parts[1].color).toBe("#ff00aa");
    const bow = lookParts({ hair: "tuft", accessory: "bow" }, "#64d2ff");
    expect(bow.map((p) => p.kind)).toEqual(["hair", "accessory"]);
    // A hair colour that is not a colour falls back to the default.
    expect(
      lookParts({ hair: "tuft", hair_color: "red" }, "#000000")[0].color,
    ).toBe("#2b2b33");
  });
  it("has a label for every value", () => {
    for (const v of [...HAIR, ...EYES, ...ACCESSORIES])
      expect(LOOK_LABELS[v]).toBeTruthy();
  });
});
