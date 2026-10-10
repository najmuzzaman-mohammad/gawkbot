import { describe, expect, it } from "vitest";

import { emptyConversationLine } from "./sessionMember";

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

  it("falls back to the slug when there is no name", () => {
    expect(emptyConversationLine({ slug: "cx-59ee2ffa", name: "" })).toBe(
      "Say hi to cx-59ee2ffa.",
    );
  });
});
