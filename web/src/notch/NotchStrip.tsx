import type { BanterLine, Boredom } from "./antics";
import { NotchArrival } from "./NotchArrival";
import { NotchBot } from "./NotchBot";
import type { Mood, NotchAgent, NotchGeometry, NotchState } from "./types";

// The collapsed notch: a black strip as tall as the camera housing and one
// "ear" wider on each side, plus a transparent STAGE hanging below it where
// the fun happens (an agent peeking out, the waiting gang's speech bubbles).
// The stage is only as tall as the current act needs; NotchApp tells the Mac
// app how much room to reserve (bridge "stage" message).

export const STAGE_PEEK = 46;
export const STAGE_CHAT = 92;
export const STAGE_ARRIVE = 64;

export interface StripProps {
  state: NotchState | null;
  geometry: NotchGeometry;
  /** Agents piled on the notch because they need the human. */
  gang: NotchAgent[];
  boredom: Boredom;
  /** The line being spoken right now by the bored gang, if any. */
  line: BanterLine | null;
  /** An agent peeking out just for fun. */
  peeker: NotchAgent | null;
  /** An agent flying in with a question (useArrival). */
  arrival?: NotchAgent | null;
  expanded: boolean;
}

export function stageHeight(
  p: Pick<StripProps, "line" | "peeker" | "expanded" | "arrival">,
): number {
  if (p.expanded) return 0;
  if (p.line) return STAGE_CHAT;
  if (p.arrival) return STAGE_ARRIVE;
  if (p.peeker) return STAGE_PEEK;
  return 0;
}

const MAX_GANG = 4;
/** The most agents the strip shows at once, askers and workers together. */
export const STRIP_CAP = 5;
/** The same, in compact ears that hug a notch. */
export const COMPACT_STRIP_CAP = 3;
/** Ears narrower than this are compact. */
const COMPACT_EAR = 60;
/** Ears this narrow hold dots, not faces. */
export const DOT_EAR = 14;
/** The most dots a slim ear shows, stacked. */
const MAX_DOTS = 3;

/** A mood that shows as a dot at rest: someone is doing something. */
function busy(a: NotchAgent): boolean {
  return a.mood === "working" || a.mood === "error" || a.mood === "done";
}

/**
 * How wide the ears are: on a Mac without a notch, always the pill's; with
 * one, faces when something needs the human, dots while anyone is at work,
 * and none at all when the office is still.
 */
export function earWidthFor(
  g: NotchGeometry,
  attention: number,
  agents: readonly NotchAgent[],
): number {
  if (g.notchWidth <= 0) return g.earWidth;
  if (attention > 0) return g.earWidth;
  return agents.some(busy) ? DOT_EAR : 0;
}

/** One state at a glance: a spinner for work, a dot for anything else. */
function StateDot({ agent }: { agent: NotchAgent }) {
  return (
    <span
      className={`ndot ndot-${agent.mood}`}
      role="img"
      aria-label={`${agent.name}: ${agent.mood.replace("_", " ")}`}
      data-mood={agent.mood}
    />
  );
}
/** Among the ones not asking: a snag first, then a finish, then work. */
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
  gang: everyone,
  boredom,
  arrival,
  expanded,
}: StripProps) {
  // An agent still flying in (NotchArrival) joins the gang when it lands.
  const gang = arrival
    ? everyone.filter((a) => a.slug !== arrival.slug)
    : everyone;
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

  // Slim ears: the lead's state on the left, up to three others stacked on
  // the right, each a coloured dot or a spinner. Small enough to stay out
  // of the way, enough to say what is going on.
  if (geometry.earWidth > 0 && geometry.earWidth <= DOT_EAR) {
    const others = (state?.agents ?? [])
      .filter((a) => !a.is_lead && busy(a))
      .sort((a, c) => CREW_RANK[a.mood] - CREW_RANK[c.mood])
      .slice(0, MAX_DOTS);
    return (
      <div
        className="notch-strip is-dots"
        style={{ height: geometry.notchHeight }}
        title={state?.headline}
      >
        <span className="ndots">
          {lead && busy(lead) ? <StateDot agent={lead} /> : null}
        </span>
        <div style={{ width: geometry.notchWidth, flexShrink: 0 }} />
        <span className="ndots" data-testid="notch-dots">
          {others.map((a) => (
            <StateDot key={a.slug} agent={a} />
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

/**
 * The stage hangs below the strip, BEHIND the black shell, so an agent can
 * slide out from under the camera housing and the bored gang's speech bubbles
 * can sit just under the notch.
 */
export function NotchStage({
  geometry,
  gang,
  line,
  peeker,
  arrival,
  expanded,
}: StripProps) {
  if (expanded) return null;
  const speaker = line ? gang.find((g) => g.slug === line.speaker) : undefined;
  return (
    <>
      {arrival ? (
        <NotchArrival
          key={arrival.slug}
          agent={arrival}
          geometry={geometry}
          width={geometry.notchWidth + 2 * geometry.earWidth}
        />
      ) : null}

      {peeker ? (
        <div
          className="notch-stage notch-peek"
          data-testid="notch-peek"
          style={{ top: geometry.notchHeight - 16 }}
          aria-live="polite"
        >
          <NotchBot
            badge={false}
            slug={peeker.slug}
            avatar={peeker.avatar}
            mood={peeker.mood === "error" ? "error" : "idle"}
            act="peeking"
            size={30}
            label={`${peeker.name} peeks out`}
            bare={true}
          />
        </div>
      ) : null}

      {line ? (
        <div
          className="notch-stage notch-chat"
          data-testid="notch-chat"
          style={{ top: geometry.notchHeight + 8 }}
          aria-live="polite"
        >
          <div className="notch-chat-row">
            {speaker ? (
              <NotchBot
                badge={false}
                slug={speaker.slug}
                avatar={speaker.avatar}
                mood="needs_you"
                act="talking"
                size={26}
                bare={true}
                label=""
              />
            ) : null}
            <div className="notch-bubble">
              <b>{speaker?.name ?? line.speaker}</b> {line.text}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
