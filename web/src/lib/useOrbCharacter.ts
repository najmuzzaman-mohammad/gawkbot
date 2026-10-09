import {
  type MutableRefObject,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";

import type { AvatarShape } from "../api/memberTypes";
import { OrbCharacter } from "./orbCharacter";

// A lib/orbCharacter.ts character mounted into a host element React owns.
// The character owns everything inside its own root; React only owns the
// host, so it never reconciles inside the character. A new body, colour or
// size is a new character.

export function useOrbCharacter(
  host: RefObject<HTMLElement | null>,
  opts: { body: AvatarShape; color: string; size: number; hands?: boolean },
  /** Also kept pointing at the live character, for a parent that drives it. */
  out?: MutableRefObject<OrbCharacter | null>,
): RefObject<OrbCharacter | null> {
  const char = useRef<OrbCharacter | null>(null);
  const { body, color, size, hands } = opts;
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = new OrbCharacter(el, { body, color, size, hands });
    char.current = c;
    if (out) out.current = c;
    return () => {
      c.destroy();
      char.current = null;
      if (out?.current === c) out.current = null;
    };
  }, [host, body, color, size, hands, out]);
  return char;
}
