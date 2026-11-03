import { describe, expect, it, vi } from "vitest";

import { BUSY_OFFICE } from "../fixtures";
import { runOfficeTool } from "./tools";

const calls: Array<[string, unknown]> = [];
vi.mock("../api", () => ({
  getNotchState: () => Promise.resolve(BUSY_OFFICE),
  sendMessage: (channel: string, text: string) => {
    calls.push(["send", { channel, text }]);
    return Promise.resolve({});
  },
  answerRequest: (id: string, choice: string) => {
    calls.push(["answer", { id, choice }]);
    return Promise.resolve({});
  },
  answerWithText: (id: string, text: string) => {
    calls.push(["answer_text", { id, text }]);
    return Promise.resolve({});
  },
  stopBot: (slug: string) => {
    calls.push(["stop", slug]);
    return Promise.resolve();
  },
}));
vi.mock("../../api/client", () => ({
  post: (path: string, body: unknown) => {
    calls.push(["post", { path, body }]);
    return Promise.resolve({});
  },
}));

describe("what the voice can do", () => {
  it("describes the office small enough to read aloud", async () => {
    const out = (await runOfficeTool("get_office_state", {})) as {
      cards: unknown[];
      bots: unknown[];
    };
    expect(out.cards.length).toBe(BUSY_OFFICE.attention.length);
    expect(
      out.bots.every((b) => typeof (b as { slug: string }).slug === "string"),
    ).toBe(true);
  });

  it("tells the lead by default, a named bot by slug, and nobody it does not know", async () => {
    calls.length = 0;
    await runOfficeTool("ask_agent", { text: "check the deploy" });
    expect(calls).toEqual([
      ["send", { channel: "cos__human", text: "check the deploy" }],
    ]);
    calls.length = 0;
    await runOfficeTool("ask_agent", { slug: "gemini", text: "hi" });
    expect(calls[0]).toEqual([
      "send",
      { channel: "gemini__human", text: "hi" },
    ]);
    expect(
      await runOfficeTool("ask_agent", { slug: "nobody", text: "hi" }),
    ).toEqual({ error: "no bot called nobody" });
  });

  it("answers a card by option or in words, stops one bot or everyone", async () => {
    calls.length = 0;
    await runOfficeTool("answer_card", {
      request_id: "req-1",
      choice_id: "yes",
    });
    await runOfficeTool("answer_card", {
      request_id: "req-1",
      text: "ship it",
    });
    await runOfficeTool("stop", { slug: "ops" });
    await runOfficeTool("stop", {});
    expect(calls).toEqual([
      ["answer", { id: "req-1", choice: "yes" }],
      ["answer_text", { id: "req-1", text: "ship it" }],
      ["stop", "ops"],
      ["post", { path: "/governor", body: { action: "stop" } }],
    ]);
    expect(await runOfficeTool("nope", {})).toEqual({
      error: "no tool called nope",
    });
  });
});
