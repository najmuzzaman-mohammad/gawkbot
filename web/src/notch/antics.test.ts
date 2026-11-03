import { describe, expect, it } from "vitest";

import { boredom, CHAT_AFTER_S, FIDGET_AFTER_S, gang } from "./antics";
import { BUSY_OFFICE } from "./fixtures";

const T0 = Date.parse("2026-10-08T12:00:00Z");

describe("antics", () => {
  it("gangs one bot per asker, oldest ask first", () => {
    expect(
      gang(BUSY_OFFICE.attention, BUSY_OFFICE.agents).map((a) => a.slug),
    ).toEqual(["gemini", "cos"]);
  });

  it("gets restless, then chatty, the longer you wait", () => {
    const seen = new Map([
      ["req-1", T0],
      ["req-2", T0],
    ]);
    const at = (s: number) =>
      boredom(BUSY_OFFICE.attention, T0 + s * 1000, seen);
    expect(at(0)).toBe(0);
    expect(at(FIDGET_AFTER_S)).toBe(1);
    expect(at(CHAT_AFTER_S)).toBe(2);
    // A lone asker fidgets but has nobody to talk to.
    const lone = [BUSY_OFFICE.attention[0]];
    expect(boredom(lone, T0 + CHAT_AFTER_S * 1000, seen)).toBe(1);
    expect(boredom([], T0, seen)).toBe(0);
  });
});
