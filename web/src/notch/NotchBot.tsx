import type { MemberAvatar } from "../api/memberTypes";
import { OrbAvatar } from "../components/ui/OrbAvatar";
import type { Face } from "../lib/orbAvatar";
import type { Mood } from "./types";

// An agent in the notch: its own orb (the same one it has everywhere in
// the office), live, plus body language for its mood. The orb does the
// face (eyes spinning while working, talking while it needs you, a frown
// and a head shake on an error, star eyes then a smile when done); the
// body motion is CSS in notch.css and only plays under
// prefers-reduced-motion: no-preference.
//
//   working    gentle bob, spinning eyes
//   idle       slow breathing, half-closed eyes, a "z" drifting up
//   needs_you  bouncy hop, a talking face, an "!" badge
//   error      a shake, a frown, a sweat drop
//   done       a happy hop, a big smile, sparkles
//   peeking    slides out from under the notch, looks around, ducks back
//   fidget     restless sway while waiting too long

export type BotAct = "peeking" | "fidget" | "talking";

const MOOD_FACE: Record<Mood, Face> = {
  working: "working",
  idle: "sleepy",
  needs_you: "asking",
  error: "oops",
  done: "happy",
};

const MOOD_WORDS: Record<Mood, string> = {
  working: "working",
  idle: "idle",
  needs_you: "needs you",
  error: "hit a snag",
  done: "done",
};

interface NotchBotProps {
  slug: string;
  mood: Mood;
  size?: number;
  act?: BotAct;
  /** Accessible name; pass "" for decorative. Defaults to slug + mood. */
  label?: string;
  /** Desynchronises a row of bots so they do not move in lockstep. */
  phase?: number;
  /** Hide the mood prop (badge, z, sparkles) at very small sizes. */
  bare?: boolean;
  /** The bot's chosen look (NotchAgent.avatar). */
  avatar?: MemberAvatar;
}

function Prop({ mood }: { mood: Mood }) {
  switch (mood) {
    case "needs_you":
      return <span className="nb-prop nb-bang">!</span>;
    case "idle":
      return <span className="nb-prop nb-z">z</span>;
    case "done":
      return (
        <span className="nb-prop nb-sparkles" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      );
    case "error":
      return <span className="nb-prop nb-sweat" />;
    default:
      return null;
  }
}

export function NotchBot({
  slug,
  mood,
  size = 22,
  act,
  label,
  phase = 0,
  bare = false,
  avatar,
}: NotchBotProps) {
  const name = label ?? `${slug}: ${MOOD_WORDS[mood]}`;
  // A named bot is an image with a name; an unnamed one is decoration.
  const a11y = name
    ? ({ role: "img", "aria-label": name } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <span
      className={`notch-bot nb-${mood}${act ? ` nb-act-${act}` : ""}`}
      style={{
        width: size,
        height: size,
        animationDelay: `${-phase * 0.37}s`,
        ["--nb-size" as string]: `${size}px`,
      }}
      {...a11y}
      data-mood={mood}
      data-slug={slug}
    >
      <span className="nb-body" style={{ animationDelay: `${-phase * 0.37}s` }}>
        <OrbAvatar
          slug={slug}
          size={size}
          face={act === "talking" ? "asking" : MOOD_FACE[mood]}
          live={true}
          avatar={avatar}
        />
      </span>
      {bare ? null : <Prop mood={mood} />}
    </span>
  );
}
