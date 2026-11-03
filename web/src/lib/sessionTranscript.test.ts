import { describe, expect, it } from "vitest";

import type { Message } from "../api/client";
import { isTerminalMessage, mergeTranscript } from "./sessionTranscript";

const dm = (
  id: string,
  from: string,
  content: string,
  timestamp: string,
): Message => ({
  id,
  from,
  channel: "cc-1__human",
  content,
  timestamp,
});

describe("mergeTranscript", () => {
  it("reads as one conversation in time order, each message once", () => {
    const merged = mergeTranscript(
      [
        dm("m1", "you", "Run it on staging", "2026-10-11T10:05:00Z"),
        dm("m2", "cc-1", "Ran it.  All green.", "2026-10-11T10:06:00Z"),
        dm(
          "m3",
          "system",
          "Typed into this session's terminal window.",
          "2026-10-11T10:05:01Z",
        ),
      ],
      [
        { from: "human", text: "Tidy the scripts", at: "2026-10-11T10:00:00Z" },
        {
          from: "agent",
          text: "Tidy. Run on staging?",
          at: "2026-10-11T10:01:00Z",
        },
        // The same two messages, as the terminal saw them.
        {
          from: "human",
          text: "Run it on staging",
          at: "2026-10-11T10:05:02Z",
        },
        {
          from: "agent",
          text: "Ran it. All green.",
          at: "2026-10-11T10:06:00Z",
        },
      ],
      "cc-1",
      "cc-1__human",
    );
    expect(merged.map((m) => [m.from, m.content])).toEqual([
      ["you", "Tidy the scripts"],
      ["cc-1", "Tidy. Run on staging?"],
      ["you", "Run it on staging"],
      ["system", "Typed into this session's terminal window."],
      ["cc-1", "Ran it.  All green."],
    ]);
    expect(merged.filter(isTerminalMessage)).toHaveLength(2);
  });
});
