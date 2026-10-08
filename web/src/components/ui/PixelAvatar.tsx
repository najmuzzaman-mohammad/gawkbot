import { type CSSProperties, useEffect, useId, useRef } from "react";

import { BLINK_MIN_SIZE, useAvatarBlink } from "../../lib/avatarBlink";
import { AVATAR_MODE } from "../../lib/avatarMode";
import {
  type AvatarChoice,
  drawBlobAvatarCanvas,
  hasAvatarChoice,
} from "../../lib/blobAvatar";
import { BLOB_GRID, smoothBlob } from "../../lib/blobAvatarSmooth";
import {
  drawPixelAvatar,
  EYE_OPENNESS_MIN,
  EYES_MIN_SIZE,
} from "../../lib/pixelAvatar";

/** One full narrow-and-widen cycle of the gawk. */
const GAWK_PERIOD_MS = 2600;

/**
 * Repaint cap for the sprite gawk. These are pixel eyes with a travel of a
 * few supersampled rows, so 60fps buys nothing a viewer can see and costs a
 * full ImageData rebuild every frame. 12fps reads as deliberate rather than
 * jerky.
 */
const GAWK_FPS = 12;

/**
 * How far the smooth eyes narrow, as a fraction of their open height. Derived
 * from the same floor the pixel eyes use, so both systems gawk by the same
 * amount: eyeSpec() draws an eye 2 + 2·openness rows tall, so the narrowest
 * eye is (2 + 2·EYE_OPENNESS_MIN) / 4 of the open one.
 */
const SMOOTH_GAWK_MIN_SCALE = (2 + 2 * EYE_OPENNESS_MIN) / 4;

interface PixelAvatarProps {
  slug: string;
  size: number;
  className?: string;
  /**
   * Draw the hollow gawk eyes. Defaults to `size >= EYES_MIN_SIZE`, because
   * the ring turns to mud at byline scale. Sprite mode only: the blob mark
   * always has its eyes, they are what makes it a face.
   */
  eyes?: boolean;
  /**
   * True only for the bot that is PROCESSING RIGHT NOW, not merely online.
   * This is the only thing that animates: an idle avatar paints once and then
   * does nothing, so a sidebar of a dozen teammates is a dozen static marks
   * rather than a dozen permanent repaints.
   */
  working?: boolean;
  /**
   * The bot's chosen look (OfficeMember.avatar). Unset fields fall back to
   * the slug-derived shape and colour. In sprite mode a chosen look is drawn
   * as the pixel blob, since the character portrait has no shape to pick.
   */
  avatar?: AvatarChoice | null;
}

/**
 * A bot's portrait. Which system draws it is AVATAR_MODE's call:
 *
 *  - "blob": the per-bot mark as a clean vector (SmoothAvatar below).
 *  - "sprite": the pixel-character portrait on a <canvas> (SpriteAvatar).
 *
 * Pass a className like `pixel-avatar-sidebar` or `pixel-avatar-panel` to
 * apply theme-level sizing/treatment around it; both renderers carry the
 * `pixel-avatar` class so every existing call site styles either one.
 */
export function PixelAvatar(props: PixelAvatarProps) {
  return AVATAR_MODE === "blob" ? (
    <SmoothAvatar {...props} />
  ) : (
    <SpriteAvatar {...props} />
  );
}

function composeClassName(...names: (string | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/**
 * The blob mark as an SVG: the same silhouette and colour as the pixel blob,
 * traced as a curve (lib/blobAvatarSmooth.ts).
 *
 * The eyes are holes. They are cut by a mask rather than baked into the path
 * so the gawk can narrow them continuously: the `working` animation is a CSS
 * scaleY on the two mask shapes (global.css, `.pixel-avatar--smooth`), which
 * runs on the compositor with no JavaScript loop at all, and is switched off
 * under prefers-reduced-motion. An idle avatar is a static SVG.
 *
 * Squash, wobble and blink come from styles/avatar-motion.css: the svg is
 * the wobble target, the inner group the squash target, and the eye shapes
 * the blink target. Large idle avatars join the page's single blink pool
 * (lib/avatarBlink.ts); a working one is already moving its eyes.
 */
function SmoothAvatar({
  slug,
  size,
  className,
  working = false,
  avatar,
}: PixelAvatarProps) {
  const maskId = `pixel-avatar-eyes-${useId().replace(/[^\w-]/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const blob = smoothBlob(slug, 1, avatar);
  const { body } = blob;
  useAvatarBlink(svgRef, !!body && !working && size >= BLINK_MIN_SIZE);

  const style = {
    // Inline, like the canvas renderer's backing-size style, so a wrapper
    // rule such as `.message-avatar .pixel-avatar { width: 100% }` sizes
    // the box around the mark and not the mark itself — exactly as it did
    // for the canvas. The width/height attributes alone lose to any CSS.
    width: size,
    height: size,
    "--pixel-avatar-gawk-min": String(SMOOTH_GAWK_MIN_SCALE),
    "--pixel-avatar-gawk-period": `${GAWK_PERIOD_MS}ms`,
  } as CSSProperties;

  return (
    <svg
      ref={svgRef}
      className={composeClassName(
        "pixel-avatar",
        "pixel-avatar--smooth",
        "avatar-motion",
        className,
      )}
      width={size}
      height={size}
      viewBox={`0 0 ${BLOB_GRID} ${BLOB_GRID}`}
      aria-hidden="true"
      focusable="false"
      data-slug={slug}
      data-working={working && body ? "true" : undefined}
      style={style}
    >
      {body ? (
        <>
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={BLOB_GRID}
            height={BLOB_GRID}
          >
            {/* Mask luminance, not colour: white keeps the body, black cuts. */}
            <rect width={BLOB_GRID} height={BLOB_GRID} fill="white" />
            {blob.eyes.map((eye) => (
              <rect
                key={eye.x}
                className="pixel-avatar-eye avatar-motion-eye"
                x={eye.x}
                y={eye.y}
                width={eye.w}
                height={eye.h}
                rx={Math.min(eye.w, eye.h) / 2}
                fill="black"
              />
            ))}
          </mask>
          <g className="avatar-motion-body">
            <path d={body} fill={blob.color} mask={`url(#${maskId})`} />
          </g>
        </>
      ) : (
        // Path layout not what splitBlobBody expects: draw the static mark
        // (eyes as evenodd holes) rather than a wrong shape. No gawk.
        <g className="avatar-motion-body">
          <path d={blob.d} fill={blob.color} fillRule="evenodd" />
        </g>
      )}
    </svg>
  );
}

/**
 * The pixel-character portrait on a <canvas>. Kept whole so reverting the
 * avatar system is one constant in lib/avatarMode.ts.
 *
 * A bot with a chosen look is drawn as the pixel BLOB in that shape and
 * colour instead: someone picked a blob, and a portrait would ignore them.
 */
function SpriteAvatar({
  slug,
  size,
  className,
  eyes,
  working = false,
  avatar,
}: PixelAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shape = avatar?.shape;
  const color = avatar?.color;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const chosen = { shape, color };
    const asBlob = hasAvatarChoice(chosen);
    // The blob mark always has its eyes; they are what makes it a face.
    const wantsEyes = asBlob || (eyes ?? size >= EYES_MIN_SIZE);
    const reduceMotion =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;

    const paint = (openness: number) => {
      if (asBlob) {
        drawBlobAvatarCanvas(canvas, slug, size, { avatar: chosen, openness });
      } else {
        drawPixelAvatar(canvas, slug, size, { eyes: wantsEyes, openness });
      }
    };

    // Static path. Idle bots, small avatars, and reduced-motion all land
    // here: one paint, no loop, nothing scheduled. Reduced-motion still shows
    // the eyes wide open — it drops the motion, not the identity. The sprite
    // only draws eyes above a size floor, so without eyes there is nothing
    // to animate.
    if (!(working && wantsEyes) || reduceMotion) {
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
  }, [slug, size, eyes, working, shape, color]);

  return (
    <canvas
      ref={canvasRef}
      className={composeClassName("pixel-avatar", className)}
    />
  );
}
