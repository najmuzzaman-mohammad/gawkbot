import { type ReactNode, useEffect, useRef } from "react";

import type { MemberAvatar } from "../api/memberTypes";
import { ModelBadge } from "../components/ui/ModelBadge";
import { useBotRuntime } from "../lib/botRuntime";
import { orbLook, poseLive } from "../lib/orbAvatar";
import { mountStarfield } from "../lib/orbCharacter";
import { useOrbCharacter } from "../lib/useOrbCharacter";
import { MOOD_FACE } from "./NotchBot";
import { play } from "./sounds";
import type { Mood } from "./types";

// The open notch's header: the lead (Chief of Staff) as a character on a
// small night-sky stage, not an icon. Opening the notch is a moment: the
// lead pops into being with a flash of glow and a burst of sparkles, waves
// hello, then stays live, looking toward the question you are on and
// clapping when an answer lands. Opening it again within a minute is a
// small hop instead, so a quick look does not replay the whole show.

/** Opening again within this long gets a hop, not a birth. */
export const REBIRTH_MS = 60_000;
const HERO_SIZE = 56;

let lastBirth = 0;

/** Forget the last birth (tests). */
export function resetHeroBirth(): void {
  lastBirth = 0;
}

export interface NotchHeroProps {
  slug: string;
  avatar?: MemberAvatar;
  mood: Mood;
  /** The question in focus; the lead glances toward it as it changes. */
  focusId: string | null;
  /** Bumped by NotchApp when an answer lands: the lead claps. */
  cheer: number;
  children: ReactNode;
}

export function NotchHero({
  slug,
  avatar,
  mood,
  focusId,
  cheer,
  children,
}: NotchHeroProps) {
  const runtime = useBotRuntime(slug);
  const sky = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const look = orbLook(slug, avatar);
  const char = useOrbCharacter(stage, {
    body: look.body,
    color: look.color,
    size: HERO_SIZE,
  });

  useEffect(() => {
    const el = sky.current;
    return el ? mountStarfield(el, { density: 0.45 }) : undefined;
  }, []);

  // The entrance, once per open.
  useEffect(() => {
    const c = char.current;
    if (!c) return;
    const now = Date.now();
    if (now - lastBirth > REBIRTH_MS) {
      lastBirth = now;
      play("sparkle");
      void c.birth();
    } else {
      void c.hop(0.2);
    }
  }, [char]);

  useEffect(() => {
    const c = char.current;
    if (c) poseLive(c.mascot, MOOD_FACE[mood]);
  }, [char, mood]);

  // A glance down toward the question list each time the focus moves.
  const seenFocus = useRef(focusId);
  useEffect(() => {
    const c = char.current;
    if (!c || focusId === seenFocus.current) return;
    seenFocus.current = focusId;
    if (!focusId) return;
    c.point(70);
    const t = window.setTimeout(() => c.point(null), 1100);
    return () => window.clearTimeout(t);
  }, [char, focusId]);

  const seenCheer = useRef(cheer);
  useEffect(() => {
    const c = char.current;
    if (!c || cheer === seenCheer.current) return;
    seenCheer.current = cheer;
    play("clap");
    void c.clap();
  }, [char, cheer]);

  return (
    <div className="nhead nhero">
      <div className="nhero-sky" ref={sky} aria-hidden="true" />
      <div className="nhero-stage" ref={stage} aria-hidden="true" />
      {/* The character owns the stage's children, so the badge sits in a
          box of its own laid exactly over it. */}
      {runtime ? (
        <div className="nhero-badge">
          <ModelBadge runtime={runtime} avatarSize={HERO_SIZE} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
