import { describe, expect, it } from "vitest";

import { pluralize, slugPreview } from "./naming";

describe("pluralize", () => {
  it.each([
    ["Investor", "Investors"],
    ["Company", "Companies"],
    ["Day", "Days"],
    ["Class", "Classes"],
    ["Box", "Boxes"],
    ["Match", "Matches"],
    ["Wish", "Wishes"],
    ["Buzz", "Buzzes"],
    ["Meeting", "Meetings"],
  ])("%s becomes %s", (name, plural) => {
    expect(pluralize(name)).toBe(plural);
  });

  it("trims and keeps the casing the operator typed", () => {
    expect(pluralize("  COMPANY ")).toBe("COMPANies");
    expect(pluralize("")).toBe("");
    expect(pluralize("   ")).toBe("");
  });

  it("does not treat a lone y as a consonant ending", () => {
    expect(pluralize("y")).toBe("ys");
  });
});

describe("slugPreview", () => {
  it("lowercases and collapses everything else to underscores", () => {
    expect(slugPreview("Portfolio Company")).toBe("portfolio_company");
    expect(slugPreview("  R&D -- Project! ")).toBe("r_d_project");
  });

  it("falls back when nothing usable is left", () => {
    expect(slugPreview("!!!")).toBe("object");
  });

  it("adds the next free numeric suffix for a taken slug", () => {
    expect(slugPreview("Firm", ["firm"])).toBe("firm_2");
    expect(slugPreview("Firm", ["firm", "firm_2"])).toBe("firm_3");
    expect(slugPreview("Firm", ["investor"])).toBe("firm");
  });
});
