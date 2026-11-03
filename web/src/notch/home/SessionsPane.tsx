import { RuntimeLogo } from "../../components/onboarding/RuntimeLogos";
import type { NotchScreen } from "../screens";
import { sourceLabel } from "../shared";
import type { NotchAgent, NotchState } from "../types";
import { chatScreen, rowTime, sessionsOf } from "./model";

export interface SessionsPaneProps {
  state: NotchState;
  now: number;
  onPick: (screen: NotchScreen) => void;
  /** Opens a session where it runs: its terminal, or Codex. */
  onShowSource: (slug: string) => void;
}

const STATE_WORDS: Record<string, string> = {
  working: "Working",
  your_turn: "Your turn",
  quiet: "Quiet",
};

function SessionCard({
  session,
  state,
  now,
  onPick,
  onShowSource,
}: { session: NotchAgent } & SessionsPaneProps) {
  const chat = chatScreen(session, state);
  const source = sourceLabel(session);
  return (
    <li className="nsess" data-testid={`notch-session-${session.slug}`}>
      <div className="nsess-head">
        <span className="nsess-logo" aria-hidden="true">
          <RuntimeLogo
            label={session.tool === "codex" ? "Codex" : "Claude Code"}
          />
        </span>
        <b className="nsess-name">{session.name}</b>
        <span className="nsess-time">{rowTime(session, now)}</span>
      </div>
      <div className="nsess-meta">
        {[session.project, STATE_WORDS[session.state ?? ""] ?? ""]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {session.last_said ? (
        <p className="nsess-said">{session.last_said}</p>
      ) : null}
      <div className="nsess-actions">
        {chat ? (
          <button
            type="button"
            className="nbtn is-quiet"
            onClick={() => onPick(chat)}
          >
            Message
          </button>
        ) : null}
        {source ? (
          <button
            type="button"
            className="nbtn is-quiet"
            onClick={() => onShowSource(session.slug)}
          >
            {source}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The terminal sessions found on this Mac, in one place: what each is
 * about, where it stands, what it last said, and a way back to it. They
 * finish all day, so they never make a card or a sound of their own.
 */
export function SessionsPane(props: SessionsPaneProps) {
  const sessions = sessionsOf(props.state);
  return (
    <section className="npane nsessions" aria-label="Sessions">
      <header className="npane-head">
        <h2>Sessions</h2>
        <p>
          Claude Code and Codex sessions running on this Mac. They show here and
          nowhere else.
        </p>
      </header>
      {sessions.length === 0 ? (
        <p className="nchat-empty">No sessions running on this Mac.</p>
      ) : (
        <ul className="nsess-list">
          {sessions.map((s) => (
            <SessionCard key={s.slug} session={s} {...props} />
          ))}
        </ul>
      )}
    </section>
  );
}
