import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLINK_GAP_MAX_MS,
  BLINK_GAP_MIN_MS,
  BLINK_HOLD_MS,
  registerBlink,
  resetAvatarBlinkForTests,
} from "./avatarBlink";

function onScreenEl(): HTMLElement {
  const el = document.createElement("span");
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({
      top: 10,
      left: 10,
      bottom: 50,
      right: 50,
      width: 40,
      height: 40,
    }) as DOMRect;
  return el;
}

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

const blinking = () => document.querySelectorAll("[data-blinking]").length;

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
});

afterEach(() => {
  resetAvatarBlinkForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("avatar blink scheduler", () => {
  it("blinks one registered avatar, briefly, then schedules the next", () => {
    // Pin the random gap to its floor so the timeline is exact.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const off = registerBlink(onScreenEl());
    vi.advanceTimersByTime(BLINK_GAP_MIN_MS - 1);
    expect(blinking()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(blinking()).toBe(1);
    vi.advanceTimersByTime(BLINK_HOLD_MS);
    expect(blinking()).toBe(0);
    // ...and it keeps going.
    vi.advanceTimersByTime(BLINK_GAP_MIN_MS);
    expect(blinking()).toBe(1);
    off();
  });

  it("never has more than one avatar blinking at a time", () => {
    const offs = Array.from({ length: 12 }, () => registerBlink(onScreenEl()));
    let sawBlink = 0;
    for (let t = 0; t < 40_000; t += 50) {
      vi.advanceTimersByTime(50);
      expect(blinking()).toBeLessThanOrEqual(1);
      sawBlink += blinking();
    }
    // Not vacuous: blinks did happen in that window.
    expect(sawBlink).toBeGreaterThan(0);
    for (const off of offs) off();
  });

  it("skips avatars that are not on screen", () => {
    const el = document.createElement("span");
    document.body.appendChild(el); // jsdom: a 0×0 rect, i.e. not visible
    const off = registerBlink(el);
    vi.advanceTimersByTime(BLINK_GAP_MAX_MS * 3);
    expect(blinking()).toBe(0);
    off();
  });

  it("does nothing under reduced motion", () => {
    setReducedMotion(true);
    const off = registerBlink(onScreenEl());
    vi.advanceTimersByTime(BLINK_GAP_MAX_MS * 3);
    expect(blinking()).toBe(0);
    off();
  });

  it("stops scheduling once the last avatar unmounts, and unflags it", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const el = onScreenEl();
    const off = registerBlink(el);
    vi.advanceTimersByTime(BLINK_GAP_MIN_MS);
    expect(el).toHaveAttribute("data-blinking");
    off();
    expect(el).not.toHaveAttribute("data-blinking");
    vi.advanceTimersByTime(BLINK_HOLD_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
