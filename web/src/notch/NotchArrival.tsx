import { useEffect, useRef } from "react";

import { orbLook } from "../lib/orbAvatar";
import { Toon } from "../lib/toon/toon";
import { play } from "./sounds";
import type { NotchAgent, NotchGeometry } from "./types";

// An agent arriving with a question while the notch is closed: it pops into
// being on the stage under the notch (a flash, sparkles, a squash), then
// flies up along an arc into the right ear, leaning into the turn with a
// trail of sparkles, and disappears behind the black shell to join the
// gang waiting there. The stage sits behind the shell (notch.css), so the
// last stretch of the flight really does go into the notch.

const SIZE = 30;
const POP_MS = 700;

export function NotchArrival({
  agent,
  geometry,
  width,
}: {
  agent: NotchAgent;
  geometry: NotchGeometry;
  /** The collapsed shell's width; the stage is as wide. */
  width: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const look = orbLook(agent.slug, agent.avatar);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = new Toon(el, { body: look.body, color: look.color, size: SIZE });
    c.root.style.left = "0";
    c.root.style.top = "0";
    const startX = width / 2 - SIZE / 2;
    const startY = 22;
    c.placeAt(startX, startY);
    void c.birth({ wave: false });
    const t = window.setTimeout(() => {
      play("whoosh");
      // Out sideways under the notch first, then a swoop up into the ear.
      const earX = width - geometry.earWidth / 2 - SIZE / 2;
      void c.flyTo(earX, -geometry.notchHeight - SIZE, {
        duration: 900,
        via: { x: earX + 18, y: startY + 18 },
      });
    }, POP_MS);
    return () => {
      window.clearTimeout(t);
      c.destroy();
    };
  }, [look.body, look.color, width, geometry.earWidth, geometry.notchHeight]);

  return (
    <div
      ref={host}
      className="notch-stage notch-arrive"
      data-testid="notch-arrive"
      style={{ top: geometry.notchHeight - 4, width }}
      role="img"
      aria-label={`${agent.name} flies in with a question`}
    />
  );
}
