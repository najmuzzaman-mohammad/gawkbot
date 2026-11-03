import { type MutableRefObject, useEffect, useRef } from "react";

import type { AvatarChoice } from "../../lib/blobAvatar";
import { orbLook } from "../../lib/orbAvatar";
import type { OrbCharacter } from "../../lib/orbCharacter";
import { useOrbCharacter } from "../../lib/useOrbCharacter";
import { play } from "../../notch/sounds";

// A bot as a character (lib/orbCharacter.ts) for the office: the glossy,
// tall-eyed orb with hands and a glow, for the moments a bot addresses the
// human directly (it has a question, it is greeting you). Lists and
// bylines keep the calm OrbAvatar.
//
// `greetKey` makes an entrance: the first time a key is seen on this page
// the bot pops into being with sparkles and waves; seen again (the same
// question after switching channels) it is simply there.

const greeted = new Set<string>();

export interface BotCharacterProps {
  slug: string;
  size: number;
  avatar?: AvatarChoice | null;
  /** Pops in and waves the first time this key is seen. */
  greetKey?: string;
  /** Receives the live character, to make it clap, hop or point. */
  charRef?: MutableRefObject<OrbCharacter | null>;
  className?: string;
}

export function BotCharacter({
  slug,
  size,
  avatar,
  greetKey,
  charRef,
  className,
}: BotCharacterProps) {
  const host = useRef<HTMLSpanElement>(null);
  const look = orbLook(slug, avatar);
  const char = useOrbCharacter(
    host,
    { body: look.body, color: look.color, size },
    charRef,
  );

  useEffect(() => {
    const c = char.current;
    if (!(c && greetKey) || greeted.has(greetKey)) return;
    greeted.add(greetKey);
    play("sparkle");
    void c.birth();
  }, [char, greetKey]);

  return (
    <span
      ref={host}
      className={["bot-character", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
