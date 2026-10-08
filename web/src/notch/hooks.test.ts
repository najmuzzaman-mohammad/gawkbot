import { describe, expect, it, vi } from "vitest";

import { BUSY_OFFICE } from "./fixtures";
import { type KeyHandlers, runKeyAction, trackFirstSeen } from "./hooks";

function handlers(over: Partial<KeyHandlers> = {}): KeyHandlers {
  return {
    attention: BUSY_OFFICE.attention,
    selected: BUSY_OFFICE.attention[0],
    composer: null,
    select: vi.fn(),
    choose: vi.fn(),
    reply: () => ({ kind: "answer", requestId: "req-1", to: "Gemini CLI" }),
    lead: () => ({
      kind: "message",
      slug: "cos",
      name: "Chief of Staff",
      channel: "cos__human",
    }),
    open: vi.fn(),
    voice: vi.fn(),
    close: vi.fn(),
    ...over,
  };
}

describe("runKeyAction", () => {
  it("wraps around when moving", () => {
    const h = handlers();
    runKeyAction({ type: "move", delta: -1 }, h);
    expect(h.select).toHaveBeenCalledWith("req-2");
  });

  it("answers the selected question", () => {
    const h = handlers();
    runKeyAction({ type: "choose", optionId: "approve" }, h);
    expect(h.choose).toHaveBeenCalledWith("req-1", "approve");
  });

  it("opens a reply before listening", () => {
    const h = handlers();
    runKeyAction({ type: "voice_start" }, h);
    expect(h.open).toHaveBeenCalled();
    expect(h.voice).toHaveBeenCalledWith(true);
  });

  it("routes Esc to a single close handler", () => {
    const h = handlers();
    expect(runKeyAction({ type: "close" }, h)).toBe(true);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("ignores keys that are not ours", () => {
    expect(runKeyAction({ type: "none" }, handlers())).toBe(false);
  });
});

describe("trackFirstSeen", () => {
  it("remembers new asks and forgets answered ones", () => {
    const m = new Map([["gone", 1]]);
    trackFirstSeen(m, BUSY_OFFICE.attention, 50);
    expect([...m.entries()]).toEqual([
      ["req-1", 50],
      ["req-2", 50],
    ]);
    trackFirstSeen(m, BUSY_OFFICE.attention, 99);
    expect(m.get("req-1")).toBe(50);
  });
});
