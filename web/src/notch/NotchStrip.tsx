import type { Boredom } from "./antics";
import { NotchBot } from "./NotchBot";
import { byNeed, type DotMood, dotMood, finishedSlugs } from "./order";
import type { Mood, NotchAgent, NotchGeometry, NotchState } from "./types";

// The collapsed notch: a black strip as tall as the camera housing and one
// "ear" wider on each side. Nothing hangs below it: what a bot has to say
// goes to its card at the top right (NotchDock.tsx), where it fits.

export interface StripProps {
  state: NotchState | null;
  geometry: NotchGeometry;
  /** Agents piled on the notch because they need the human. */
  gang: NotchAgent[];
  boredom: Boredom;
  expanded: boolean;
}

const MAX_GANG = 4;
/** The most agents the strip shows at once, askers and workers together. */
export const STRIP_CAP = 5;
/** The same, in compact ears that hug a notch. */
export const COMPACT_STRIP_CAP = 3;
/** Ears narrower than this are compact. */
const COMPACT_EAR = 60;
/** The band of dots under the notch, at rest. */
export const DOT_BAND = 10;

/** What the strip looks like now, and so how big a window it needs. */
export interface StripShape {
  /** Ears beside the notch, for faces. */
  earWidth: number;
  /** A band under the notch, for dots. */
  band: number;
}

/**
 * On a Mac without a notch, always the pill. With one, every state is a
 * dot in a band under the notch, and when nothing is going on there is
 * nothing beyond the notch at all.
 */
export function stripShapeFor(
  g: NotchGeometry,
  finished: ReadonlySet<string>,
  agents: readonly NotchAgent[],
): StripShape {
  if (g.notchWidth <= 0) return { earWidth: g.earWidth, band: 0 };
  const any = agents.some((a) => dotMood(a, finished) !== null);
  return { earWidth: 0, band: any ? DOT_BAND : 0 };
}

/** How many dots fit in a band as wide as the notch. */
export function dotsThatFit(notchWidth: number): number {
  // 6px a dot plus a 4px gap, with a little room at the ends.
  return Math.max(1, Math.floor((notchWidth - 12) / 10));
}

const DOT_WORDS: Record<DotMood, string> = {
  needs_you: "needs your answer",
  working: "working",
  error: "stuck",
  done: "finished, your turn",
};

/** One state at a glance: red asking or stuck, green your turn, orange working. */
function StateDot({ agent, mood }: { agent: NotchAgent; mood: DotMood }) {
  return (
    <span
      className={`ndot ndot-${mood}`}
      role="img"
      aria-label={`${agent.name}: ${DOT_WORDS[mood]}`}
      data-mood={mood}
    />
  );
}
/** Asking first, then a snag, then a finish, then work. */
const CREW_RANK: Record<Mood, number> = {
  needs_you: 0,
  error: 1,
  done: 2,
  working: 3,
  idle: 4,
};

export function NotchStrip({
  state,
  geometry,
  gang,
  boredom,
  expanded,
}: StripProps) {
  const lead = state?.agents.find((a) => a.is_lead);
  const count = state?.attention.length ?? 0;
  // Nothing needs the human and nobody is doing anything: the lead turns in,
  // and wakes when the human opens the notch (hovering in opens it).
  const quiet =
    !!state &&
    count === 0 &&
    state.mood === "idle" &&
    state.agents.every((a) => a.mood === "idle");
  const asleep = quiet && !expanded;
  const awake = quiet && expanded;
  // Compact ears hug a notch: smaller faces, fewer of them, no "+N" text.
  const compact = geometry.notchWidth > 0 && geometry.earWidth < COMPACT_EAR;
  const cap = compact ? COMPACT_STRIP_CAP : STRIP_CAP;
  const bot = compact
    ? Math.max(12, Math.min(20, geometry.notchHeight - 12))
    : Math.max(14, Math.min(22, geometry.notchHeight - 10));
  // Everyone who is doing something shows on the strip, each moving the
  // way its own state moves: askers hop, workers bob, a finished one
  // celebrates, a stuck one shakes. Askers first (they are the gang), then
  // the rest by how much they want a look. STRIP_CAP is all the strip
  // holds; anyone past it is the "+N".
  const askers = gang.slice(0, Math.min(MAX_GANG, cap));
  const asking = new Set(gang.map((a) => a.slug));
  const active = (state?.agents ?? [])
    .filter(
      (a) =>
        !(a.is_lead || asking.has(a.slug)) &&
        (a.mood === "working" || a.mood === "error" || a.mood === "done"),
    )
    .sort((a, c) => CREW_RANK[a.mood] - CREW_RANK[c.mood]);
  const crew = active.slice(0, cap - askers.length);
  const hidden = gang.length + active.length - askers.length - crew.length;

  // On a Mac with a notch: the notch, and under it one centred row of
  // dots, red then green then orange, the latest first in each (order.ts).
  // As many as fit in the notch's own width.
  if (geometry.band > 0) {
    const finished = finishedSlugs(state);
    const dots = byNeed(state?.agents ?? [], finished)
      .flatMap((a) => {
        const mood = dotMood(a, finished);
        return mood ? [{ agent: a, mood }] : [];
      })
      .slice(0, dotsThatFit(geometry.notchWidth));
    return (
      <div
        className="notch-strip is-dots"
        style={{ height: geometry.notchHeight + geometry.band }}
        title={state?.headline}
      >
        <div style={{ height: geometry.notchHeight, flexShrink: 0 }} />
        <span
          className="ndots"
          data-testid="notch-dots"
          style={{ height: geometry.band }}
        >
          {dots.map(({ agent, mood }) => (
            <StateDot key={agent.slug} agent={agent} mood={mood} />
          ))}
        </span>
      </div>
    );
  }

  // No ears: the strip is the notch itself, a place to hover, nothing more.
  if (geometry.earWidth === 0) {
    return (
      <div
        className="notch-strip"
        style={{ height: geometry.notchHeight }}
        title={state?.headline}
      />
    );
  }

  return (
    <div
      className={`notch-strip${compact ? " is-compact" : ""}`}
      style={{ height: geometry.notchHeight }}
      title={state?.headline}
    >
      <div className="notch-ear">
        <NotchBot
          badge={false}
          slug={lead?.slug ?? state?.lead ?? "cos"}
          avatar={lead?.avatar}
          mood={state?.mood ?? "idle"}
          size={bot}
          bare={true}
          tucked={asleep}
          awake={awake}
          label={`${state?.lead_name ?? "Chief of Staff"}: ${asleep ? "asleep, nothing needs you" : (state?.headline ?? "connecting")}`}
        />
        {!expanded && state && count === 0 ? (
          <span className="notch-ear-text">{state.headline}</span>
        ) : null}
      </div>
      <div style={{ width: geometry.notchWidth, flexShrink: 0 }} />
      <div className="notch-ear notch-ear-right">
        {askers.length > 0 ? (
          <span
            className={`notch-gang gang-bored-${boredom}`}
            data-testid="notch-gang"
            style={{ ["--gang-n" as string]: askers.length }}
          >
            {askers.map((a, i) => (
              <span
                className="notch-gang-member"
                key={a.slug}
                style={{ ["--gang-i" as string]: i }}
              >
                <NotchBot
                  badge={false}
                  slug={a.slug}
                  avatar={a.avatar}
                  mood="needs_you"
                  size={bot}
                  phase={i + 1}
                  bare={true}
                  act={boredom >= 1 ? "fidget" : undefined}
                  label={`${a.name} needs you`}
                />
              </span>
            ))}
          </span>
        ) : null}
        {crew.length > 0 ? (
          <span className="notch-gang notch-crew" data-testid="notch-crew">
            {crew.map((a, i) => (
              <span
                className="notch-gang-member"
                key={a.slug}
                style={{ ["--gang-i" as string]: i }}
              >
                <NotchBot
                  badge={false}
                  slug={a.slug}
                  avatar={a.avatar}
                  mood={a.mood}
                  size={bot - 2}
                  phase={i + 1}
                  bare={true}
                  label={`${a.name}: ${a.mood.replace("_", " ")}`}
                />
              </span>
            ))}
          </span>
        ) : null}
        {hidden > 0 && !compact ? (
          <span
            className="notch-more"
            role="img"
            aria-label={`${hidden} more active`}
          >
            +{hidden}
          </span>
        ) : null}
        {count > 0 ? (
          <span
            className="notch-badge"
            role="img"
            aria-label={`${count} need you`}
          >
            {count}
          </span>
        ) : null}
      </div>
    </div>
  );
}
