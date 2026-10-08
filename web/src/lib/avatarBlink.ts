// avatarBlink.ts — the one blink at a time.
//
// Large blob avatars blink: their eyes narrow briefly at random intervals
// (styles/avatar-motion.css draws it). Doing that per avatar would be a timer
// per mark and a sidebar of synchronised winks, so instead there is ONE
// scheduler for the whole page. Avatars register while mounted; at a random
// gap it picks one that is actually on screen, flags it for a single CSS
// animation, unflags it, and only then schedules the next. At most one avatar
// is ever animating a blink, and nothing runs at all while none are mounted,
// the tab is hidden, or the person has asked for reduced motion.

import { type RefObject, useEffect } from "react";

/** Only avatars at least this big blink. Below it the eye is a few px. */
export const BLINK_MIN_SIZE = 32;

/** Random gap between blinks across the whole page. */
export const BLINK_GAP_MIN_MS = 2400;
export const BLINK_GAP_MAX_MS = 6800;

/**
 * How long an avatar stays flagged. Longer than --avatar-blink-duration so
 * the CSS animation always finishes before the flag (and the animation) is
 * removed, and a timer rather than animationend so a page that never loaded
 * the stylesheet cannot leave an avatar flagged forever.
 */
export const BLINK_HOLD_MS = 360;

const ATTR = "data-blinking";

const registry = new Set<Element>();
let gapTimer: ReturnType<typeof setTimeout> | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let current: Element | null = null;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

function onScreen(el: Element): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
}

/** A random on-screen registered avatar, or null. Tries a few, not all. */
function pick(): Element | null {
  const all = [...registry];
  for (let tries = 0; tries < 4 && all.length > 0; tries++) {
    const i = Math.floor(Math.random() * all.length);
    const el = all[i];
    if (onScreen(el)) return el;
    all.splice(i, 1);
  }
  return null;
}

function schedule(): void {
  if (gapTimer !== null || holdTimer !== null || registry.size === 0) return;
  const gap =
    BLINK_GAP_MIN_MS + Math.random() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS);
  gapTimer = setTimeout(tick, gap);
}

function tick(): void {
  gapTimer = null;
  if (registry.size === 0) return;
  const hidden = typeof document !== "undefined" && document.hidden;
  const el = hidden || prefersReducedMotion() ? null : pick();
  if (el) {
    current = el;
    el.setAttribute(ATTR, "true");
    holdTimer = setTimeout(() => {
      holdTimer = null;
      el.removeAttribute(ATTR);
      current = null;
      schedule();
    }, BLINK_HOLD_MS);
    return;
  }
  schedule();
}

/** Adds `el` to the blink pool. Returns the unregister function. */
export function registerBlink(el: Element): () => void {
  registry.add(el);
  schedule();
  return () => {
    registry.delete(el);
    if (current === el) {
      el.removeAttribute(ATTR);
      // The hold timer still fires and reschedules; it just unflags a
      // detached element, which is harmless.
    }
    if (registry.size === 0 && gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
  };
}

/** Registers the element behind `ref` while `enabled`. */
export function useAvatarBlink(
  ref: RefObject<Element | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!(enabled && el)) return;
    return registerBlink(el);
  }, [ref, enabled]);
}

/** Test seam: drop every registration and timer. */
export function resetAvatarBlinkForTests(): void {
  if (gapTimer !== null) clearTimeout(gapTimer);
  if (holdTimer !== null) clearTimeout(holdTimer);
  gapTimer = null;
  holdTimer = null;
  current?.removeAttribute(ATTR);
  current = null;
  registry.clear();
}
