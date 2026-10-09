import { beforeEach, describe, expect, it } from "vitest";

import {
  claimNudge,
  NUDGE_EVERY_MS,
  nudgeWaitMs,
  resetNudges,
  SAME_NUDGE_MS,
} from "./nudge";

describe("nudges", () => {
  beforeEach(resetNudges);
  const t0 = 1_000_000;

  it("lets the first question through, then holds the rest for five minutes", () => {
    expect(NUDGE_EVERY_MS).toBe(5 * 60_000);
    expect(claimNudge("ask", t0)).toBe(true);
    expect(claimNudge("ask", t0 + 30_000)).toBe(false);
    expect(claimNudge("ask", t0 + NUDGE_EVERY_MS - 1)).toBe(false);
    expect(claimNudge("ask", t0 + NUDGE_EVERY_MS)).toBe(true);
    // A refused claim does not push the next one back.
    expect(claimNudge("ask", t0 + NUDGE_EVERY_MS + 60_000)).toBe(false);
    expect(claimNudge("ask", t0 + 2 * NUDGE_EVERY_MS)).toBe(true);
  });

  it("counts the sound, the peek and the flight for one question as one nudge", () => {
    expect(claimNudge("ask", t0)).toBe(true);
    expect(claimNudge("ask", t0 + 5)).toBe(true);
    expect(claimNudge("ask", t0 + SAME_NUDGE_MS - 1)).toBe(true);
    expect(claimNudge("ask", t0 + SAME_NUDGE_MS)).toBe(false);
  });

  it("never lets play use up a real question's turn", () => {
    // An agent peeks out for fun...
    expect(claimNudge("play", t0)).toBe(true);
    // ...and a real question a minute later still comes out.
    expect(claimNudge("ask", t0 + 60_000)).toBe(true);
  });

  it("keeps play quiet for five minutes after anything", () => {
    expect(claimNudge("ask", t0)).toBe(true);
    expect(claimNudge("play", t0 + 5)).toBe(false);
    expect(claimNudge("play", t0 + NUDGE_EVERY_MS - 1)).toBe(false);
    expect(claimNudge("play", t0 + NUDGE_EVERY_MS)).toBe(true);
    expect(claimNudge("play", t0 + NUDGE_EVERY_MS + 60_000)).toBe(false);
  });

  it("says how long until play may come out", () => {
    expect(nudgeWaitMs(t0)).toBe(0);
    claimNudge("ask", t0);
    expect(nudgeWaitMs(t0 + 60_000)).toBe(NUDGE_EVERY_MS - 60_000);
    expect(nudgeWaitMs(t0 + NUDGE_EVERY_MS + 1)).toBe(0);
  });
});
