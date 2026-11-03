import type { RealtimePhase } from "./realtime/client";

export interface NotchVoiceLineProps {
  phase: RealtimePhase;
  heard: string | null;
  said: string | null;
  error: string | null;
}

const WORDS: Record<RealtimePhase, string> = {
  idle: "",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

/**
 * One line under the headline while you talk to the office: the state
 * word with a small wave, then what was heard and what was said. Nothing
 * when there is nothing to show.
 */
export function NotchVoiceLine({
  phase,
  heard,
  said,
  error,
}: NotchVoiceLineProps) {
  if (phase === "idle" && !heard && !said && !error) return null;
  const word = WORDS[phase];
  return (
    <div
      className={`nvoice is-${phase}`}
      role="status"
      data-testid="notch-voice"
    >
      {word ? (
        <span className="nvoice-state">
          <i className="nvoice-wave" aria-hidden="true">
            <b />
            <b />
            <b />
          </i>
          {word}
        </span>
      ) : null}
      {error ? <span className="nvoice-error">{error}</span> : null}
      {heard ? <span className="nvoice-heard">“{heard}”</span> : null}
      {said ? <span className="nvoice-said">{said}</span> : null}
    </div>
  );
}
