import { useEffect, useRef } from "react";

import { AVATAR_MODE } from "../../lib/avatarMode";
import { drawBlobAvatarCanvas } from "../../lib/blobAvatar";
import {
  drawPixelAvatar,
  EYE_OPENNESS_MIN,
  EYES_MIN_SIZE,
} from "../../lib/pixelAvatar";

/** One full narrow-and-widen cycle of the gawk. */
const GAWK_PERIOD_MS = 2600;

/**
 * Repaint cap for the gawk. These are pixel eyes with a travel of a few
 * supersampled rows, so 60fps buys nothing a viewer can see and costs a full
 * ImageData rebuild every frame. 12fps reads as deliberate rather than jerky.
 */
const GAWK_FPS = 12;

interface PixelAvatarProps {
  slug: string;
  size: number;
  className?: string;
  /**
   * Draw the hollow gawk eyes. Defaults to `size >= EYES_MIN_SIZE`, because
   * the ring turns to mud at byline scale.
   */
  eyes?: boolean;
  /**
   * True only for the bot that is PROCESSING RIGHT NOW, not merely online.
   * This is the only thing that animates: an idle avatar paints once and then
   * does nothing, so a sidebar of a dozen teammates is a dozen static canvases
   * rather than a dozen permanent repaints.
   */
  working?: boolean;
}

/**
 * Renders a pixel-art bot portrait on a <canvas>.
 * Pass a className like `pixel-avatar-sidebar` or `pixel-avatar-panel`
 * to apply theme-level sizing/treatment around the canvas.
 */
export function PixelAvatar({
  slug,
  size,
  className,
  eyes,
  working = false,
}: PixelAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const wantsEyes = eyes ?? size >= EYES_MIN_SIZE;
    const reduceMotion =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;

    // One paint function for both avatar systems, so the animation loop below
    // does not have to know which one is active.
    const paint = (openness: number) => {
      if (AVATAR_MODE === "blob") {
        drawBlobAvatarCanvas(canvas, slug, size, { openness });
        return;
      }
      drawPixelAvatar(canvas, slug, size, { eyes: wantsEyes, openness });
    };

    // Static path. Idle bots, small avatars, and reduced-motion all land
    // here: one paint, no loop, nothing scheduled. Reduced-motion still shows
    // the eyes wide open — it drops the motion, not the identity.
    //
    // The blob always has eyes; the sprite only draws them above a size floor,
    // which is why `wantsEyes` gates the sprite path and not this one.
    const canAnimate = AVATAR_MODE === "blob" || wantsEyes;
    if (!(working && canAnimate) || reduceMotion) {
      paint(1);
      return;
    }

    let frame = 0;
    let lastPaint = 0;
    const start = performance.now();
    const minFrameMs = 1000 / GAWK_FPS;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - lastPaint < minFrameMs) return;
      lastPaint = now;

      // Cosine so the eyes dwell at each extreme instead of snapping between
      // them, which is what makes it read as looking rather than blinking.
      const phase = ((now - start) % GAWK_PERIOD_MS) / GAWK_PERIOD_MS;
      const wave = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
      const openness = EYE_OPENNESS_MIN + (1 - EYE_OPENNESS_MIN) * wave;
      paint(openness);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [slug, size, eyes, working]);

  const composedClassName = ["pixel-avatar", className]
    .filter(Boolean)
    .join(" ");

  return <canvas ref={canvasRef} className={composedClassName} />;
}
