import { describe, expect, it } from "vitest";

import { HOME, isAgentScreen, screenForTarget } from "./screens";

describe("which screen a reply belongs on", () => {
  it("is the bot's thread for a message, and stays Home for a card's answer", () => {
    expect(
      screenForTarget({
        kind: "message",
        slug: "ops",
        name: "Ops",
        channel: "human__ops",
      }),
    ).toEqual({
      kind: "agent",
      slug: "ops",
      name: "Ops",
      channel: "human__ops",
    });
    expect(
      screenForTarget({ kind: "answer", requestId: "r1", to: "Ops" }),
    ).toBeNull();
    expect(isAgentScreen(HOME)).toBe(false);
  });
});
