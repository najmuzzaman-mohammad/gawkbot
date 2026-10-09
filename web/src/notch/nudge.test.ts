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

  it("lets the first one through, then holds the rest for five minutes", () => {
    const t0 = 1_000_000;
    expect(NUDGE_EVERY_MS).toBe(5 * 60_000);
    expect(claimNudge(t0)).toBe(true);
    expect(claimNudge(t0 + 30_000)).toBe(false);
    expect(claimNudge(t0 + NUDGE_EVERY_MS - 1)).toBe(false);
    expect(claimNudge(t0 + NUDGE_EVERY_MS)).toBe(true);
    // A refused claim does not push the next one back.
    expect(claimNudge(t0 + NUDGE_EVERY_MS + 60_000)).toBe(false);
    expect(claimNudge(t0 + 2 * NUDGE_EVERY_MS)).toBe(true);
  });

  it("counts the sound, the peek and the flight for one question as one nudge", () => {
    const t0 = 1_000_000;
    expect(claimNudge(t0)).toBe(true);
    expect(claimNudge(t0 + 5)).toBe(true);
    expect(claimNudge(t0 + SAME_NUDGE_MS - 1)).toBe(true);
    expect(claimNudge(t0 + SAME_NUDGE_MS)).toBe(false);
  });

  it("says how long until the next one", () => {
    const t0 = 1_000_000;
    expect(nudgeWaitMs(t0)).toBe(0);
    claimNudge(t0);
    expect(nudgeWaitMs(t0 + 60_000)).toBe(NUDGE_EVERY_MS - 60_000);
    expect(nudgeWaitMs(t0 + NUDGE_EVERY_MS + 1)).toBe(0);
  });
});
