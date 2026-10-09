import {
  type MutableRefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import type { AvatarChoice } from "../../lib/blobAvatar";
import { orbLook } from "../../lib/orbAvatar";
import { Toon } from "../../lib/toon/toon";
import { play } from "../../notch/sounds";

// A bot as a full toon (lib/toon) for the office: gloves, shoes and all,
// for the moments a bot addresses the human directly (it has a question,
// it is greeting you). Lists and bylines keep the head-only mark.
//
// `greetKey` makes an entrance: the first time a key is seen on this page
// the bot appears in a puff of smoke and waves; seen again (the same
// question after switching channels) it is simply there.

const greeted = new Set<string>();

export interface BotCharacterProps {
  slug: string;
  size: number;
  avatar?: AvatarChoice | null;
  /** Pops in and waves the first time this key is seen. */
  greetKey?: string;
  /** Receives the live character, to make it clap, hop or point. */
  charRef?: MutableRefObject<Toon | null>;
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
  const char = useRef<Toon | null>(null);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Toon(el, { body: look.body, color: look.color, size });
    t.root.style.left = "0";
    t.root.style.top = "0";
    char.current = t;
    if (charRef) charRef.current = t;
    return () => {
      t.destroy();
      char.current = null;
      if (charRef?.current === t) charRef.current = null;
    };
  }, [look.body, look.color, size, charRef]);

  useEffect(() => {
    const c = char.current;
    if (!(c && greetKey) || greeted.has(greetKey)) return;
    greeted.add(greetKey);
    play("poof");
    void c.birth();
  }, [greetKey]);

  return (
    <span
      ref={host}
      className={["bot-character", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
