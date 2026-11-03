import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  announcements,
  announceOn,
  askLine,
  doneLine,
  hush,
  known,
  speak,
} from "./announce";
import type { NativeMessage } from "./bridge";
import { BUSY_OFFICE, QUIET_OFFICE } from "./fixtures";
import type { NotchState } from "./types";

type NotchHost = { webkit?: unknown };
let posted: NativeMessage[] = [];

beforeEach(() => {
  posted = [];
  (window as unknown as NotchHost).webkit = {
    messageHandlers: {
      gawkNotch: { postMessage: (m: NativeMessage) => posted.push(m) },
    },
  };
});
afterEach(() => {
  (window as unknown as NotchHost).webkit = undefined;
});

const WITH_DONE: NotchState = {
  ...BUSY_OFFICE,
  finished: [
    {
      id: "finished:ops@1",
      kind: "finished",
      from: "ops",
      from_name: "Ops",
      question: "",
      recap: {
        reply:
          "Moved 14 screenshots into Shots. Two were duplicates, so I left them where they were and named them in the log.",
      },
    },
  ],
};

describe("what bots say out loud", () => {
  it("says nothing on the first look, then one line per new card", () => {
    const first = announcements(null, QUIET_OFFICE);
    expect(first.lines).toEqual([]);
    const next = announcements(first.known, BUSY_OFFICE);
    expect(next.lines.length).toBe(BUSY_OFFICE.attention.length);
    expect(next.lines[0]).toMatch(/needs you/);
    // The same cards again: silence.
    expect(announcements(next.known, BUSY_OFFICE).lines).toEqual([]);
  });

  it("reads a finished turn as its first sentence, and an ask as its title", () => {
    const k = known(BUSY_OFFICE);
    const { lines } = announcements(k, WITH_DONE);
    expect(lines).toEqual(["Ops is done: Moved 14 screenshots into Shots."]);
    const card = BUSY_OFFICE.attention[0];
    expect(askLine(card, BUSY_OFFICE)).toContain("needs you");
    expect(
      doneLine(
        { ...WITH_DONE.finished?.[0], recap: undefined } as never,
        WITH_DONE,
      ),
    ).toBe("Ops is done.");
  });

  it("never speaks for a terminal session finishing", () => {
    const k = known(BUSY_OFFICE);
    const session: NotchState = {
      ...WITH_DONE,
      agents: [
        ...WITH_DONE.agents,
        { slug: "ops", name: "Ops", mood: "idle", kind: "session" },
      ],
    };
    expect(announcements(k, session).lines).toEqual([]);
  });

  it("keeps a long line short", () => {
    const long = "a".repeat(400);
    const line = askLine(
      {
        id: "x",
        kind: "ask",
        from: "cos",
        from_name: "Chief of Staff",
        question: long,
      },
      QUIET_OFFICE,
    );
    expect(line.length).toBeLessThan(170);
    expect(line.endsWith("…")).toBe(true);
  });

  it("is on unless turned off", () => {
    expect(announceOn(null)).toBe(true);
    expect(announceOn({ ...QUIET_OFFICE, announce: true })).toBe(true);
    expect(announceOn({ ...QUIET_OFFICE, announce: false })).toBe(false);
  });

  it("speaks through the Mac app, and hushes through it too", () => {
    speak("Ops needs you.");
    hush();
    expect(posted).toEqual([
      { type: "say", text: "Ops needs you." },
      { type: "hush" },
    ]);
    speak("");
    expect(posted.length).toBe(2);
  });
});
