import { type CSSProperties, useLayoutEffect, useRef } from "react";

import { BLINK_MIN_SIZE, useAvatarBlink } from "../../lib/avatarBlink";
import type { AvatarChoice } from "../../lib/blobAvatar";
import { type Face, orbLook } from "../../lib/orbAvatar";
import { Toon } from "../../lib/toon/toon";

// A bot's mark, as a React component: its own body and colour drawn as a
// 1930s cartoon toon (lib/toon), head only. One component for every
// surface: the sidebar, bylines, the picker, the phone's web views.
//
// The toon owns the <svg>'s children: it is drawn into the element in a
// layout effect and redrawn in place when the face changes, so React
// renders an empty <svg> and never reconciles inside it.
//
// Two modes. A STILL mark (the default) is posed once and does nothing: a
// sidebar of a dozen teammates is a dozen static drawings, and the page's
// blink pool (lib/avatarBlink.ts) winks one of them now and then. A LIVE
// mark runs the orb's own loop: the face's looping state (spinning eyes
// while working, talking while asking), smoothing and blinking. Live marks
// are for the notch and for the bot processing right now. Under
// prefers-reduced-motion a live mark is drawn still.

export interface OrbAvatarProps {
  slug: string;
  size: number;
  /** The bot's chosen look; unset fields fall back to the slug's own. */
  avatar?: AvatarChoice | null;
  face?: Face;
  /** Run the orb's animation loop. Off, the mark is a still pose. */
  live?: boolean;
  /** Join the page's blink pool when still and large. On by default. */
  blink?: boolean;
  /** Where a still mark looks, in degrees. */
  yaw?: number;
  pitch?: number;
  className?: string;
  /** Accessible name. Omit for a decorative mark. */
  label?: string;
  style?: CSSProperties;
}

export function OrbAvatar({
  slug,
  size,
  avatar,
  face = "calm",
  live = false,
  blink = true,
  yaw = 0,
  pitch = 0,
  className,
  label,
  style,
}: OrbAvatarProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const toon = useRef<Toon | null>(null);
  const { body, color } = orbLook(slug, avatar);
  const firstFace = useRef(face);

  // The body, colour and mode are the drawing's structure: a new toon.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const t = new Toon(document.body, {
      body,
      color,
      size,
      svg,
      arms: false,
      legs: false,
      live,
      face: firstFace.current,
    });
    // The squash-on-press target for styles/avatar-motion.css.
    svg.querySelector(".toon-ink")?.classList.add("avatar-motion-body");
    toon.current = t;
    return () => {
      t.destroy();
      toon.current = null;
    };
  }, [body, color, size, live]);

  // Face and gaze change the toon in place: at once for a still mark,
  // tweened for a live one.
  useLayoutEffect(() => {
    const t = toon.current;
    if (!t) return;
    void t.setFace(face, live ? 260 : 0);
    if (!live) void t.to({ yaw: yaw / 20, pitch: pitch / 15 }, 0);
  }, [face, live, yaw, pitch]);

  // Closed eyes have nothing to blink; a live mark blinks on its own.
  useAvatarBlink(
    svgRef,
    blink && !live && face !== "happy" && size >= BLINK_MIN_SIZE,
    () => toon.current?.blink(),
  );

  const cls = className ? `avatar-motion ${className}` : "avatar-motion";
  const inline = {
    // Inline, so a wrapper rule such as `.message-avatar svg { width: 100% }`
    // sizes the box around the mark and not the mark itself.
    width: size,
    height: size,
    ...style,
  } as CSSProperties;

  return (
    <svg
      ref={svgRef}
      className={cls}
      width={size}
      height={size}
      overflow="visible"
      data-slug={slug}
      data-body={body}
      data-face={face}
      data-live={live ? "true" : undefined}
      style={inline}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    />
  );
}
