import { describe, expect, it } from "vitest";

import { type BotDot, botDot, botDotClass } from "./botDot";

describe("botDot", () => {
  it.each<[string, Parameters<typeof botDot>[0], BotDot]>([
    ["an office bot at work", { status: "active" }, "working"],
    ["an office bot that hit an error", { status: "error" }, "stuck"],
    ["an office bot with nothing on", { status: "idle" }, "idle"],
    ["no member at all", undefined, "idle"],
    [
      "a session at work",
      {
        status: "active",
        session: { tool: "codex", live: true, state: "working" },
      },
      "working",
    ],
    [
      "a session that finished its turn",
      {
        status: "idle",
        session: { tool: "codex", live: true, state: "your_turn" },
      },
      "finished",
    ],
    [
      "a quiet session",
      {
        status: "idle",
        session: { tool: "codex", live: true, state: "quiet" },
      },
      "idle",
    ],
    [
      "a closed session with a stale working state",
      {
        status: "active",
        session: { tool: "codex", live: false, state: "working" },
      },
      "idle",
    ],
    [
      "a live session with no state yet",
      { status: "active", session: { tool: "codex", live: true } },
      "working",
    ],
  ])("%s", (_, member, want) => {
    expect(botDot(member)).toBe(want);
  });

  it("gives each state its own status-dot class, idle the small grey one", () => {
    expect(
      (["working", "finished", "stuck", "idle"] as const).map(botDotClass),
    ).toEqual(["working", "finished", "stuck", "lurking"]);
  });
});
