import type { BanterLine, Boredom } from "./antics";
import { NotchBot } from "./NotchBot";
import type { NotchAgent, NotchGeometry, NotchState } from "./types";

// The collapsed notch: a black strip as tall as the camera housing and one
// "ear" wider on each side, plus a transparent STAGE hanging below it where
// the fun happens (an agent peeking out, the waiting gang's speech bubbles).
// The stage is only as tall as the current act needs; NotchApp tells the Mac
// app how much room to reserve (bridge "stage" message).

export const STAGE_PEEK = 46;
export const STAGE_CHAT = 92;

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
  expanded: boolean;
}

export function stageHeight(
  p: Pick<StripProps, "line" | "peeker" | "expanded">,
): number {
  if (p.expanded) return 0;
  if (p.line) return STAGE_CHAT;
  if (p.peeker) return STAGE_PEEK;
  return 0;
}

const MAX_GANG = 4;

export function NotchStrip({
  state,
  geometry,
  gang,
  boredom,
  expanded,
}: StripProps) {
  const lead = state?.agents.find((a) => a.is_lead);
  const count = state?.attention.length ?? 0;
  const bot = Math.max(14, Math.min(22, geometry.notchHeight - 10));
  // Quiet agents that are busy still show, one at a time, when nobody needs
  // the human: a working bot on the strip says "things are happening".
  const busy =
    gang.length === 0
      ? (state?.agents ?? [])
          .filter(
            (a) =>
              !a.is_lead &&
              (a.mood === "working" || a.mood === "error" || a.mood === "done"),
          )
          .slice(0, 2)
      : [];

  return (
    <div
      className="notch-strip"
      style={{ height: geometry.notchHeight }}
      title={state?.headline}
    >
      <div className="notch-ear">
        <NotchBot
          slug={lead?.slug ?? state?.lead ?? "cos"}
          mood={state?.mood ?? "idle"}
          size={bot}
          bare={true}
          label={`${state?.lead_name ?? "Chief of Staff"}: ${state?.headline ?? "connecting"}`}
        />
        {!expanded && state && count === 0 ? (
          <span className="notch-ear-text">{state.headline}</span>
        ) : null}
      </div>
      <div style={{ width: geometry.notchWidth, flexShrink: 0 }} />
      <div className="notch-ear notch-ear-right">
        {gang.length > 0 ? (
          <span
            className={`notch-gang gang-bored-${boredom}`}
            data-testid="notch-gang"
            style={{ ["--gang-n" as string]: Math.min(gang.length, MAX_GANG) }}
          >
            {gang.slice(0, MAX_GANG).map((a, i) => (
              <span
                className="notch-gang-member"
                key={a.slug}
                style={{ ["--gang-i" as string]: i }}
              >
                <NotchBot
                  slug={a.slug}
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
        ) : (
          busy.map((a, i) => (
            <NotchBot
              key={a.slug}
              slug={a.slug}
              mood={a.mood}
              size={bot - 2}
              phase={i + 1}
              bare={true}
              label={`${a.name}: ${a.mood.replace("_", " ")}`}
            />
          ))
        )}
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
  expanded,
}: StripProps) {
  if (expanded) return null;
  const speaker = line ? gang.find((g) => g.slug === line.speaker) : undefined;
  return (
    <>
      {peeker ? (
        <div
          className="notch-stage notch-peek"
          data-testid="notch-peek"
          style={{ top: geometry.notchHeight - 16 }}
          aria-live="polite"
        >
          <NotchBot
            slug={peeker.slug}
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
                slug={speaker.slug}
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
