import type { Mood } from "./types";

// A gawkbot: the brand mark's two hollow pixel eyes (brand/gawkbot-mark.svg)
// given a body language. The eyes are NEVER filled — the brand README is
// explicit that the emptiness is the joke — so every mood is acted out with
// motion (blink, dart, squash, jump, shake) and a prop drawn beside the eyes:
//
//   working   eyes dart side to side over a blinking cursor, body bobs
//   idle      eyes droop shut, slow breathing, a "z" drifts up
//   needs_you eyes go wide, the bot hops and an "!" flashes overhead
//   error     eyes jitter out of sync, a smoke puff rises
//   done      squash-and-stretch hop with confetti
//
// Animations live in notch.css and stop under prefers-reduced-motion.

const MOOD_LABEL: Record<Mood, string> = {
  working: "working",
  idle: "idle",
  needs_you: "needs you",
  error: "hit a snag",
  done: "done",
};

interface GawkBotProps {
  mood: Mood;
  /** Rendered height in px; width follows the 17:22 viewBox. */
  size?: number;
  /** Accessible name; defaults to the mood. Pass "" to hide from AT. */
  label?: string;
  /** Offsets the animation so a row of bots does not move in lockstep. */
  phase?: number;
}

// One eye of the 11x15 mark, as merged rects (top cap, two sides, bottom
// cap) offset to x. Same geometry as brand/gawkbot-mark.svg.
function Eye({ x, className }: { x: number; className: string }) {
  return (
    <g className={className}>
      <rect x={x + 1} y={1} width={2} height={1} />
      <rect x={x} y={2} width={1} height={11} />
      <rect x={x + 3} y={2} width={1} height={11} />
      <rect x={x + 1} y={13} width={2} height={1} />
    </g>
  );
}

function Prop({ mood }: { mood: Mood }) {
  switch (mood) {
    case "working":
      return (
        <rect className="gb-cursor" x={4.5} y={15.5} width={2} height={1} />
      );
    case "idle":
      return (
        <text className="gb-z" x={11.5} y={-1} fontSize={4}>
          z
        </text>
      );
    case "needs_you":
      return (
        <g className="gb-bang">
          <rect x={5} y={-5.5} width={1} height={3} />
          <rect x={5} y={-1.5} width={1} height={1} />
        </g>
      );
    case "error":
      return (
        <g className="gb-smoke">
          <rect x={11} y={-1} width={2} height={2} />
          <rect x={12.5} y={-3.5} width={1.5} height={1.5} />
          <rect x={13.5} y={-5.5} width={1} height={1} />
        </g>
      );
    case "done":
      return (
        <g className="gb-confetti">
          <rect className="gb-c1" x={-2} y={-3} width={1} height={1} />
          <rect className="gb-c2" x={12} y={-4} width={1} height={1} />
          <rect className="gb-c3" x={5} y={-5} width={1} height={1} />
          <rect className="gb-c4" x={1} y={-5} width={1} height={1} />
          <rect className="gb-c5" x={9} y={-2} width={1} height={1} />
        </g>
      );
  }
}

export function GawkBot({ mood, size = 22, label, phase = 0 }: GawkBotProps) {
  const name = label ?? MOOD_LABEL[mood];
  return (
    <svg
      className={`gawkbot gb-${mood}`}
      viewBox="-3 -6 17 22"
      width={(size * 17) / 22}
      height={size}
      role={name ? "img" : undefined}
      aria-label={name || undefined}
      aria-hidden={name ? undefined : true}
      data-mood={mood}
      style={{ animationDelay: `${-phase * 0.37}s` }}
      fill="currentColor"
    >
      <g className="gb-body" style={{ animationDelay: `${-phase * 0.37}s` }}>
        <Eye x={0} className="gb-eye gb-eye-l" />
        <Eye x={7} className="gb-eye gb-eye-r" />
      </g>
      <Prop mood={mood} />
    </svg>
  );
}
