import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NativeMessage } from "./bridge";
import { QUIET_OFFICE } from "./fixtures";
import { ideasLine, nudgeForIdeas } from "./ideasNudge";
import type { NotchState } from "./types";

type NotchHost = { webkit?: unknown };
let posted: NativeMessage[] = [];

const WITH_IDEAS: NotchState = {
  ...QUIET_OFFICE,
  announce: true,
  ideas: {
    enabled: true,
    checked_at: "2026-10-16T09:00:00Z",
    items: [
      {
        id: "idea:a",
        fingerprint: "a",
        name: "A",
        role: "",
        integration: "github",
        integration_name: "GitHub",
        promise: "p",
        rationale: "",
        first_task: "t",
        created_at: "2026-10-16T09:00:00Z",
      },
      {
        id: "idea:b",
        fingerprint: "b",
        name: "B",
        role: "",
        integration: "gmail",
        integration_name: "Gmail",
        promise: "p",
        rationale: "",
        first_task: "t",
        created_at: "2026-10-16T09:00:00Z",
      },
    ],
  },
};

beforeEach(() => {
  posted = [];
  window.localStorage.clear();
  (window as unknown as NotchHost).webkit = {
    messageHandlers: {
      gawkNotch: { postMessage: (m: NativeMessage) => posted.push(m) },
    },
  };
});
afterEach(() => {
  (window as unknown as NotchHost).webkit = undefined;
});

describe("the morning nudge for ideas", () => {
  it("speaks once per look, never opens the notch, closed only, and not when bots stay inside", () => {
    expect(nudgeForIdeas(WITH_IDEAS, true)).toBeNull();
    expect(nudgeForIdeas(WITH_IDEAS, false)).toBe(
      "2 ideas for new bots, when you're ready",
    );
    expect(posted).toEqual([
      { type: "say", text: "2 ideas for new bots, when you're ready" },
    ]);
    expect(nudgeForIdeas(WITH_IDEAS, false)).toBeNull();
    const later = {
      ...WITH_IDEAS,
      ideas: { ...WITH_IDEAS.ideas!, checked_at: "2026-10-17T09:00:00Z" },
    };
    expect(nudgeForIdeas({ ...later, jump_out: false }, false)).toBeNull();
    expect(nudgeForIdeas({ ...later, announce: false }, false)).toBe(
      "2 ideas for new bots, when you're ready",
    );
    expect(posted.filter((m) => m.type === "say").length).toBe(1);
    expect(ideasLine(1)).toBe("1 idea for a new bot, when you're ready");
  });
  it("has nothing to say without ideas", () => {
    expect(nudgeForIdeas(QUIET_OFFICE, false)).toBeNull();
    expect(nudgeForIdeas(null, false)).toBeNull();
  });
});
