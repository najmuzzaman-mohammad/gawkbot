import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installNativeReceiver,
  isInMacApp,
  postNative,
  readGeometry,
} from "./bridge";
import { BUSY_OFFICE } from "./fixtures";
import { moodTransitions, newAttentionIds } from "./NotchApp";

type Host = {
  webkit?: unknown;
  gawkNotch?: { setExpanded: (v: boolean) => void };
};

afterEach(() => {
  delete (window as unknown as Host).webkit;
});

describe("notch bridge", () => {
  it("is a no-op outside the Mac app", () => {
    expect(isInMacApp()).toBe(false);
    expect(() => postNative({ type: "ready" })).not.toThrow();
  });

  it("posts to the native handler inside the Mac app", () => {
    const postMessage = vi.fn();
    (window as unknown as Host).webkit = {
      messageHandlers: { gawkNotch: { postMessage } },
    };
    expect(isInMacApp()).toBe(true);
    postNative({ type: "open", path: "/inbox" });
    expect(postMessage).toHaveBeenCalledWith({ type: "open", path: "/inbox" });
  });

  it("lets native expand and collapse the page", () => {
    const set = vi.fn();
    const uninstall = installNativeReceiver(set);
    (window as unknown as Host).gawkNotch?.setExpanded(true);
    expect(set).toHaveBeenCalledWith(true);
    uninstall();
    expect((window as unknown as Host).gawkNotch).toBeUndefined();
  });

  it("reads geometry with safe defaults", () => {
    expect(readGeometry("?nw=186&nh=32&ew=72")).toEqual({
      notchWidth: 186,
      notchHeight: 32,
      earWidth: 72,
    });
    expect(readGeometry("?nw=abc")).toEqual({
      notchWidth: 0,
      notchHeight: 32,
      earWidth: 64,
    });
  });

  it("only buzzes for attention that is new since the last poll", () => {
    expect(newAttentionIds(null, BUSY_OFFICE)).toEqual([]);
    expect(newAttentionIds(new Set(["req-1"]), BUSY_OFFICE)).toEqual(["req-2"]);
    expect(newAttentionIds(new Set(["req-1", "req-2"]), BUSY_OFFICE)).toEqual(
      [],
    );
  });

  it("sounds once when an agent errors or finishes, not on every poll", () => {
    const prev = new Map(BUSY_OFFICE.agents.map((a) => [a.slug, a.mood]));
    expect(moodTransitions(null, BUSY_OFFICE.agents)).toEqual([]);
    expect(moodTransitions(prev, BUSY_OFFICE.agents)).toEqual([]);
    const next = BUSY_OFFICE.agents.map((a) =>
      a.slug === "designer" ? { ...a, mood: "done" as const } : a,
    );
    expect(moodTransitions(prev, next)).toEqual(["done"]);
  });
});
