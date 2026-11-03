import { useEffect, useRef } from "react";

import { announcements, announceOn, type Known, speak } from "./announce";
import type { NotchState } from "./types";

/**
 * Speaks each new card once as the state changes. `held` is the talk key:
 * while it is down nothing is said, and what arrived meanwhile is not said
 * later either (it is on screen; the moment has passed).
 */
export function useAnnounce(state: NotchState | null, held: boolean): void {
  const knownRef = useRef<Known | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => {
    if (!state) return;
    const { known, lines } = announcements(knownRef.current, state);
    knownRef.current = known;
    if (lines.length === 0 || heldRef.current || !announceOn(state)) return;
    speak(lines.join(" "));
  }, [state]);
}
