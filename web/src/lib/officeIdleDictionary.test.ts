import { describe, expect, it } from "vitest";

import { pickIdleCopy } from "./officeIdleDictionary";

describe("pickIdleCopy", () => {
  it("slug override wins over role", () => {
    // tess has a slug override; passing engineer role should still hit the
    // slug copy ("drafting a thought" at idleMs=0), not the engineer table
    // ("running the tests" at idleMs=0).
    const slugCopy = pickIdleCopy({
      slug: "tess",
      role: "engineer",
      idleMs: 0,
    });
    const engineerCopy = pickIdleCopy({
      slug: "unknown",
      role: "engineer",
      idleMs: 0,
    });
    expect(slugCopy).not.toBe(engineerCopy);
    expect(slugCopy).toBe("drafting a thought");
    expect(engineerCopy).toBe("running the tests");
  });

  it("each role table is reachable", () => {
    expect(pickIdleCopy({ slug: "x", role: "engineer", idleMs: 0 })).toBe(
      "running the tests",
    );
    expect(pickIdleCopy({ slug: "x", role: "developer", idleMs: 0 })).toBe(
      "running the tests",
    );
    expect(pickIdleCopy({ slug: "x", role: "dev", idleMs: 0 })).toBe(
      "running the tests",
    );
    expect(pickIdleCopy({ slug: "x", role: "designer", idleMs: 0 })).toBe(
      "doodling in Figma",
    );
    expect(pickIdleCopy({ slug: "x", role: "pm", idleMs: 0 })).toBe(
      "combing Linear",
    );
    expect(pickIdleCopy({ slug: "x", role: "product", idleMs: 0 })).toBe(
      "combing Linear",
    );
    expect(pickIdleCopy({ slug: "x", role: "devops", idleMs: 0 })).toBe(
      "rotating the logs",
    );
    expect(pickIdleCopy({ slug: "x", role: "sre", idleMs: 0 })).toBe(
      "rotating the logs",
    );
    expect(pickIdleCopy({ slug: "x", role: "platform", idleMs: 0 })).toBe(
      "rotating the logs",
    );
    expect(pickIdleCopy({ slug: "x", role: "marketing", idleMs: 0 })).toBe(
      "scrolling X",
    );
    expect(pickIdleCopy({ slug: "x", role: "growth", idleMs: 0 })).toBe(
      "scrolling X",
    );
  });

  it("normalizes role with trim + lowercase", () => {
    expect(pickIdleCopy({ slug: "x", role: "  ENGINEER  ", idleMs: 0 })).toBe(
      "running the tests",
    );
  });

  it("unknown role falls back to generalist (does not crash, does not return empty)", () => {
    const result = pickIdleCopy({ slug: "x", role: "alchemist", idleMs: 0 });
    expect(result).toBe("clearing something small");
    expect(result.length).toBeGreaterThan(0);
  });

  it("missing role falls back to generalist", () => {
    const result = pickIdleCopy({ slug: "x", idleMs: 0 });
    expect(result).toBe("clearing something small");
  });

  it("empty role string falls back to generalist", () => {
    const result = pickIdleCopy({ slug: "x", role: "   ", idleMs: 0 });
    expect(result).toBe("clearing something small");
  });

  it("same slug + same idleMs returns same copy (deterministic)", () => {
    const a = pickIdleCopy({ slug: "tess", idleMs: 25_000 });
    const b = pickIdleCopy({ slug: "tess", idleMs: 25_000 });
    expect(a).toBe(b);
  });

  it("idleMs rotation cycles through array (~12s per step)", () => {
    // engineer table has 5 entries; rotation interval = 12_000ms.
    const t0 = pickIdleCopy({ slug: "x", role: "engineer", idleMs: 0 });
    const t1 = pickIdleCopy({ slug: "x", role: "engineer", idleMs: 12_000 });
    const t2 = pickIdleCopy({ slug: "x", role: "engineer", idleMs: 24_000 });
    const t3 = pickIdleCopy({ slug: "x", role: "engineer", idleMs: 36_000 });
    const t4 = pickIdleCopy({ slug: "x", role: "engineer", idleMs: 48_000 });
    const t5 = pickIdleCopy({ slug: "x", role: "engineer", idleMs: 60_000 });

    expect(t0).toBe("running the tests");
    expect(t1).toBe("reviewing the diff");
    expect(t2).toBe("skimming PRs");
    expect(t3).toBe("checking CI");
    expect(t4).toBe("reading the changelog");
    // wraps back to start
    expect(t5).toBe(t0);
  });

  it("handles negative or non-finite idleMs without crashing", () => {
    expect(pickIdleCopy({ slug: "x", role: "engineer", idleMs: -1 })).toBe(
      "running the tests",
    );
    expect(
      pickIdleCopy({ slug: "x", role: "engineer", idleMs: Number.NaN }),
    ).toBe("running the tests");
  });
});

describe("a populated roster does not show one line for everybody", () => {
  // The bug this pins: roles fell through to GENERALIST_COPY, and rotateIndex
  // is derived from idleMs alone, so the WHOLE ROSTER showed the same line at
  // the same moment. A sidebar where every bot is "clearing something small"
  // reads as broken, not as charming.
  //
  // This used to iterate six built-ins. It cannot any more: the founder
  // retired the librarian, app-builder, planner, executor and reviewer as
  // defaults, so Chief of Staff is the only built-in left and "they all show
  // the same line" is unfalsifiable against a roster of one.
  //
  // The regression is still real for the rosters users actually build, so the
  // fixture is now user-created bots with distinct roles. That is the case
  // that can still regress.
  const ROSTER: readonly { slug: string; role: string }[] = [
    { slug: "ceo", role: "Chief of Staff" },
    { slug: "ada", role: "Engineer" },
    { slug: "kit", role: "Designer" },
    { slug: "rey", role: "PM" },
    { slug: "sol", role: "DevOps" },
  ];

  it("gives every known role a line that is not the generalist fallback", () => {
    for (const m of ROSTER) {
      const copy = pickIdleCopy({ slug: m.slug, role: m.role, idleMs: 0 });
      expect(copy, `${m.role} fell through to the generalist table`).not.toBe(
        "clearing something small",
      );
    }
  });

  it("does not show the same line for every bot at the same moment", () => {
    // The actual user-visible symptom, asserted directly rather than via the
    // lookup that causes it.
    const seen = ROSTER.map((m) =>
      pickIdleCopy({ slug: m.slug, role: m.role, idleMs: 0 }),
    );
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it("a retired built-in degrades to the generalist line, not a crash", () => {
    // Legacy workspaces still hold these bots on disk. Their role tables are
    // gone, so they must fall through cleanly rather than throw or return "".
    for (const role of ["Librarian", "App Builder", "Planner", "Reviewer"]) {
      const copy = pickIdleCopy({ slug: "legacy", role, idleMs: 0 });
      expect(copy.length).toBeGreaterThan(0);
    }
  });
});
