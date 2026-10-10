import { describe, expect, it } from "vitest";

import {
  canBeMessaged,
  emptyConversationLine,
  SESSION_FOLDER_GONE,
  SESSION_NOT_MESSAGEABLE,
  SESSION_OPEN_IN_TERMINAL,
  sessionNotMessageableLine,
} from "./sessionMember";

describe("emptyConversationLine", () => {
  it("invites a hello to a bot that can be messaged", () => {
    expect(emptyConversationLine({ slug: "cos", name: "Chief of Staff" })).toBe(
      "Say hi to Chief of Staff.",
    );
  });

  it("does not invite a hello to a terminal session", () => {
    const line = emptyConversationLine({
      slug: "cc-ed4a5215",
      name: "Fix the flaky checkout test",
      origin: "session",
    });
    expect(line).toBe("Fix the flaky checkout test runs in your terminal.");
    expect(line).not.toMatch(/say hi/i);
  });

  it("does not offer messaging to a session that cannot take a message", () => {
    const line = emptyConversationLine({
      slug: "cc-ed4a5215",
      name: "Fix the flaky checkout test",
      origin: "session",
      session: { tool: "claude-code", live: true, can_message: false },
    });
    expect(line).toBe("Fix the flaky checkout test runs in your terminal.");
  });

  it("says a session can be messaged from here when it can", () => {
    expect(
      emptyConversationLine({
        slug: "cc-ed4a5215",
        name: "Fix the flaky checkout test",
        origin: "session",
        session: { tool: "claude-code", live: false, can_message: true },
      }),
    ).toBe(
      "Fix the flaky checkout test runs in your terminal. You can message it from here.",
    );
  });

  it("falls back to the slug when there is no name", () => {
    expect(emptyConversationLine({ slug: "cx-59ee2ffa", name: "" })).toBe(
      "Say hi to cx-59ee2ffa.",
    );
  });
});

describe("canBeMessaged", () => {
  it("is true for any bot the office runs", () => {
    expect(canBeMessaged({})).toBe(true);
    expect(canBeMessaged({ origin: "adopted" })).toBe(true);
  });

  it("is true for a session only when the broker says so", () => {
    const session = { tool: "claude-code", live: false };
    expect(canBeMessaged({ origin: "session" })).toBe(false);
    expect(canBeMessaged({ origin: "session", session })).toBe(false);
    expect(
      canBeMessaged({
        origin: "session",
        session: { ...session, can_message: false },
      }),
    ).toBe(false);
    expect(
      canBeMessaged({
        origin: "session",
        session: { ...session, can_message: true },
      }),
    ).toBe(true);
  });
});

describe("sessionNotMessageableLine", () => {
  const session = { tool: "claude-code", live: true, can_message: false };

  it("says to message an open session in its terminal", () => {
    expect(
      sessionNotMessageableLine({
        session: { ...session, message_block: "open" },
      }),
    ).toBe(SESSION_OPEN_IN_TERMINAL);
  });

  it("says the folder is gone", () => {
    expect(
      sessionNotMessageableLine({
        session: { ...session, message_block: "folder_gone" },
      }),
    ).toBe(SESSION_FOLDER_GONE);
  });

  it("keeps the general sentence when the reason is unknown or absent", () => {
    expect(
      sessionNotMessageableLine({
        session: { ...session, message_block: "unknown" },
      }),
    ).toBe(SESSION_NOT_MESSAGEABLE);
    expect(sessionNotMessageableLine({ session })).toBe(
      SESSION_NOT_MESSAGEABLE,
    );
    expect(sessionNotMessageableLine({})).toBe(SESSION_NOT_MESSAGEABLE);
  });

  it("writes every sentence without a dash or a contraction", () => {
    for (const line of [
      SESSION_OPEN_IN_TERMINAL,
      SESSION_FOLDER_GONE,
      SESSION_NOT_MESSAGEABLE,
    ]) {
      expect(line).not.toMatch(/[—–]|n't|'re|'ll|it's/i);
    }
  });
});
