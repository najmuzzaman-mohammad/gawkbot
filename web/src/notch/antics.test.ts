import { describe, expect, it } from "vitest";

import {
  banterScript,
  boredom,
  CHAT_AFTER_S,
  FIDGET_AFTER_S,
  gang,
  nextPeekDelayMs,
  PEEK_MAX_S,
  PEEK_MIN_S,
  pickPeeker,
} from "./antics";
import { BUSY_OFFICE, QUIET_OFFICE } from "./fixtures";

const T0 = Date.parse("2026-10-08T12:00:00Z");

describe("antics", () => {
  it("peeks rarely", () => {
    expect(nextPeekDelayMs(() => 0)).toBe(PEEK_MIN_S * 1000);
    expect(nextPeekDelayMs(() => 0.9999)).toBeLessThanOrEqual(
      PEEK_MAX_S * 1000,
    );
  });

  it("only free agents peek", () => {
    const busy = new Set(["cos"]);
    const who = pickPeeker(QUIET_OFFICE.agents, busy, () => 0);
    expect(who?.slug).toBe("designer");
    expect(
      pickPeeker(QUIET_OFFICE.agents, new Set(["cos", "designer"]), () => 0),
    ).toBeNull();
  });

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

  it("writes a stable two-agent conversation about what they asked", () => {
    const a = banterScript(BUSY_OFFICE.attention, BUSY_OFFICE.agents, 3);
    const b = banterScript(BUSY_OFFICE.attention, BUSY_OFFICE.agents, 3);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(2);
    const speakers = new Set(a.map((l) => l.speaker));
    expect([...speakers].every((s) => s === "gemini" || s === "cos")).toBe(
      true,
    );
    for (let seed = 0; seed < 12; seed++) {
      for (const l of banterScript(
        BUSY_OFFICE.attention,
        BUSY_OFFICE.agents,
        seed,
      )) {
        expect(l.text).not.toMatch(/\{[a-z]+\}/);
      }
    }
  });
});
