import { useEffect, useRef } from "react";

import type { Message } from "../api/client";
import { speak } from "./announce";
import { isYours } from "./NotchThread";

/**
 * In an open thread the bot talks back: each new line it writes is read
 * out loud, in the Mac's own voice, as it lands. The lines already there
 * when the thread opens are not news and stay quiet, and so does
 * everything while the talk key is down or the switch is off.
 */
export function useThreadVoice(
  lines: readonly Message[],
  enabled: boolean,
  held: boolean,
): void {
  const seen = useRef<Set<string> | null>(null);
  const latest = useRef({ lines, held });
  latest.current = { lines, held };
  // A new line is what matters, not a re-render with the same ones.
  const ids = lines.map((m) => m.id).join(" ");
  useEffect(() => {
    const now = latest.current.lines;
    if (ids === "" && seen.current === null) return;
    const known = seen.current;
    seen.current = new Set(now.map((m) => m.id));
    if (known === null || !enabled || latest.current.held) return;
    const fresh = now.filter((m) => !(known.has(m.id) || isYours(m)));
    if (fresh.length === 0) return;
    speak(fresh.map((m) => m.content).join(" "));
  }, [ids, enabled]);
}
