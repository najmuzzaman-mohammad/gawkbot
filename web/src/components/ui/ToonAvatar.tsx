import { type CSSProperties, useEffect, useLayoutEffect, useRef } from "react";

import type { AvatarChoice } from "../../lib/blobAvatar";
import { orbLook } from "../../lib/orbAvatar";
import { Toon, type ToonFace } from "../../lib/toon/toon";

// A bot as a toon (lib/toon), as a React component: its own body and
// colour drawn as a 1930s cartoon character, pie-cut eyes and all. Small
// marks are head only; pass `arms` / `legs` for a character with gloves
// and shoes. A live toon has the idle life (a bounce on the beat, blinks,
// glances); a still one is drawn once.
//
// The toon owns everything inside the span; React only owns the span.

export interface ToonAvatarProps {
  slug: string;
  size: number;
  avatar?: AvatarChoice | null;
  face?: ToonFace;
  live?: boolean;
  arms?: boolean;
  legs?: boolean;
  className?: string;
  /** Accessible name. Omit for a decorative mark. */
  label?: string;
  style?: CSSProperties;
}

export function ToonAvatar({
  slug,
  size,
  avatar,
  face = "calm",
  live = false,
  arms = false,
  legs = false,
  className,
  label,
  style,
}: ToonAvatarProps) {
  const host = useRef<HTMLSpanElement>(null);
  const toon = useRef<Toon | null>(null);
  const { body, color } = orbLook(slug, avatar);
  // The first face is built in; later ones are tweened to (below).
  const firstFace = useRef(face);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Toon(el, {
      body,
      color,
      size,
      live,
      arms,
      legs,
      face: firstFace.current,
    });
    t.root.style.left = "0";
    t.root.style.top = "0";
    toon.current = t;
    return () => {
      t.destroy();
      toon.current = null;
    };
  }, [body, color, size, live, arms, legs]);

  useEffect(() => {
    void toon.current?.setFace(face);
  }, [face]);

  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <span
      ref={host}
      className={["toon-avatar", className].filter(Boolean).join(" ")}
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        flexShrink: 0,
        ...style,
      }}
      data-face={face}
      {...a11y}
    />
  );
}
