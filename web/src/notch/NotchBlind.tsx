import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { MemberAvatar } from "../api/memberTypes";
import { orbLook } from "../lib/orbAvatar";
import { BlindShow, blindDrop } from "./blind";
import { STAGE_RELIEF } from "./NotchStrip";
import { play } from "./sounds";

// The open notch as a roller blind (blind.ts directs the short). The black
// valance under the notch holds the roller; the fabric unrolls from it with
// the panel printed on it; a wooden slat weights the bottom, with a pull
// ring the lead hangs on. The layer is as wide and tall as the open window
// and stays mounted while the blind rolls up after the notch closes, so the
// lead can finish its business under the collapsed notch.

export type BlindPhase = "closed" | "open" | "closing" | "relief";

export interface NotchBlindProps {
  expanded: boolean;
  width: number;
  height: number;
  notchHeight: number;
  /** The lead's look (the Chief of Staff, as everywhere else). */
  leadSlug: string;
  leadAvatar?: MemberAvatar;
  /** Bumped when an answer lands: a thumbs-up off the ring. */
  cheer: number;
  onPhase?: (phase: BlindPhase) => void;
  children: ReactNode;
}

/** Fabric starts just under the notch's valance. */
export const VALANCE = 10;

export function NotchBlind({
  expanded,
  width,
  height,
  notchHeight,
  leadSlug,
  leadAvatar,
  cheer,
  onPhase,
  children,
}: NotchBlindProps) {
  const layer = useRef<HTMLDivElement>(null);
  const fabric = useRef<HTMLDivElement>(null);
  const show = useRef<BlindShow | null>(null);
  const look = orbLook(leadSlug, leadAvatar);
  const top = notchHeight + VALANCE - 4;
  const full = blindDrop(look.body, top, height);
  const [phase, setPhase] = useState<BlindPhase>(expanded ? "open" : "closed");
  const phaseCb = useRef(onPhase);
  phaseCb.current = onPhase;

  // One director per lead look and geometry.
  useLayoutEffect(() => {
    const l = layer.current;
    const f = fabric.current;
    if (!(l && f)) return;
    const s = new BlindShow(
      {
        layer: l,
        fabric: f,
        top,
        full,
        reliefFloor: notchHeight + STAGE_RELIEF - 6,
        sfx: (k) => play(k),
      },
      { body: look.body, color: look.color },
    );
    show.current = s;
    return () => {
      s.destroy();
      show.current = null;
    };
  }, [look.body, look.color, top, full, notchHeight]);

  const first = useRef(true);
  useEffect(() => {
    const s = show.current;
    if (!s) return;
    const move = (p: BlindPhase) => {
      setPhase(p);
      phaseCb.current?.(p);
    };
    if (expanded) {
      first.current = false;
      move("open");
      void s.open();
      return;
    }
    if (first.current) return;
    move("closing");
    void s.close(
      // The fabric is rolled away: the panel can go.
      () => move("relief"),
      // The lead is back in the notch.
      (on) => {
        if (!on) move("closed");
      },
    );
  }, [expanded]);

  const seenCheer = useRef(cheer);
  useEffect(() => {
    if (cheer === seenCheer.current) return;
    seenCheer.current = cheer;
    void show.current?.cheer();
  }, [cheer]);

  const showCloth = phase === "open" || phase === "closing";
  return (
    <div
      className="nblind-layer"
      style={{ width, height }}
      data-phase={phase}
      data-testid="notch-blind"
    >
      <div ref={fabric} className="nblind" style={{ top, height: full }}>
        <div className="nblind-cloth">{showCloth ? children : null}</div>
        <div className="nblind-bar" aria-hidden="true">
          <span className="nblind-cord" />
          <span className="nblind-ring" />
        </div>
      </div>
      <div ref={layer} className="nblind-cast" aria-hidden="true" />
    </div>
  );
}
