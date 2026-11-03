import { describe, expect, it, vi } from "vitest";

import { relayOverlay } from "./overlay";

describe("relaying drawings to the app", () => {
  it("draws each sequence once and clears on a null scene", () => {
    const draw = vi.fn();
    let seq = relayOverlay(0, undefined, draw);
    expect(seq).toBe(0);
    expect(draw).not.toHaveBeenCalled();
    const scene = {
      items: [{ kind: "pointer" as const, x: 1, y: 2, label: "here" }],
    };
    seq = relayOverlay(seq, { seq: 1, scene }, draw);
    expect(seq).toBe(1);
    expect(draw).toHaveBeenCalledWith(scene);
    seq = relayOverlay(seq, { seq: 1, scene }, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    seq = relayOverlay(seq, { seq: 2, scene: null }, draw);
    expect(draw).toHaveBeenLastCalledWith(null);
    expect(seq).toBe(2);
  });
});
