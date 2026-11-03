import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXPANDED_HEIGHT,
  EXPANDED_WIDTH,
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
      band: 0,
      nativeGlass: false,
      expandedWidth: EXPANDED_WIDTH,
      expandedHeight: EXPANDED_HEIGHT,
      hotkey: undefined,
    });
    // The Mac app draws the sheet's glass itself and says so.
    expect(readGeometry("?nw=186&nh=32&ew=72&glass=1").nativeGlass).toBe(true);
    expect(readGeometry("?nw=abc")).toEqual({
      notchWidth: 0,
      notchHeight: 32,
      earWidth: 64,
      band: 0,
      nativeGlass: false,
      expandedWidth: EXPANDED_WIDTH,
      expandedHeight: EXPANDED_HEIGHT,
      hotkey: undefined,
    });
  });

  it("takes the open size and the shortcut the Mac app got", () => {
    const g = readGeometry("?nw=186&xw=600&xh=700&hk=alt");
    expect([g.expandedWidth, g.expandedHeight, g.hotkey]).toEqual([
      600,
      700,
      "alt",
    ]);
    expect(readGeometry("?hk=ctrl-alt").hotkey).toBe("ctrl-alt");
    expect(readGeometry("?hk=").hotkey).toBe("");
    expect(readGeometry("?hk=cmd-q").hotkey).toBeUndefined();
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
