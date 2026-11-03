import type { ReactNode } from "react";

import { NotchBot } from "../NotchBot";
import type { NotchAgent, NotchIdeas, NotchState } from "../types";
import {
  clockLabel,
  questionsFrom,
  rowLine,
  rowTime,
  sessionsOf,
  sessionsWaiting,
} from "./model";

// The rows the sidebar and the hover list share: one per bot, one for the
// suggestions group, one for the sessions group. Face, name, a time, one
// line, and a dot when something is new.

interface RowShellProps {
  face: ReactNode;
  name: string;
  count?: number;
  time: string;
  line: string;
  dot?: "need" | "unread" | null;
  selected?: boolean;
  testId: string;
  onClick: () => void;
}

function RowShell(props: RowShellProps) {
  return (
    <li>
      <button
        type="button"
        className={`nrow${props.selected ? " is-selected" : ""}`}
        aria-current={props.selected ? "true" : undefined}
        data-testid={props.testId}
        onClick={props.onClick}
      >
        <span className="nrow-face">
          {props.face}
          {props.dot ? (
            <i className={`nrow-dot is-${props.dot}`} aria-hidden="true" />
          ) : null}
        </span>
        <span className="nrow-text">
          <span className="nrow-top">
            <b className="nrow-name">{props.name}</b>
            {props.count ? (
              <span className="nrow-count">{props.count}</span>
            ) : null}
            <span className="nrow-time">{props.time}</span>
          </span>
          <span className="nrow-line">{props.line}</span>
        </span>
      </button>
    </li>
  );
}

export function AgentRow({
  agent,
  state,
  now,
  selected,
  onClick,
}: {
  agent: NotchAgent;
  state: NotchState;
  now: number;
  selected?: boolean;
  onClick: () => void;
}) {
  const asked = questionsFrom(state, agent.slug).length > 0;
  const dot =
    asked || agent.mood === "error" ? "need" : agent.unread ? "unread" : null;
  return (
    <RowShell
      testId={`notch-row-${agent.slug}`}
      face={
        <NotchBot
          slug={agent.slug}
          avatar={agent.avatar}
          mood={agent.mood}
          size={30}
          bare={true}
          label=""
        />
      }
      name={agent.name}
      time={rowTime(agent, now)}
      line={rowLine(agent, state) || "Say hello"}
      dot={dot}
      selected={selected}
      onClick={onClick}
    />
  );
}

/** The sparkle every suggestion sits behind. */
export function SuggestionsFace() {
  return (
    <span className="nrow-sparkle">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.5l1.9 5.2 5.2 1.9-5.2 1.9L12 17.7l-1.9-5.2-5.2-1.9 5.2-1.9z" />
        <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
      </svg>
    </span>
  );
}

export function SuggestionsRow({
  ideas,
  now,
  selected,
  onClick,
}: {
  ideas: NotchIdeas;
  now: number;
  selected?: boolean;
  onClick: () => void;
}) {
  const [first] = ideas.items;
  const line = first
    ? first.promise
    : ideas.scanning
      ? "Looking across your apps…"
      : "Ideas for new bots land here each morning";
  return (
    <RowShell
      testId="notch-row-suggestions"
      face={<SuggestionsFace />}
      name="Suggestions"
      count={ideas.items.length || undefined}
      time={clockLabel(ideas.checked_at, now)}
      line={line}
      dot={ideas.items.length > 0 ? "unread" : null}
      selected={selected}
      onClick={onClick}
    />
  );
}

export function SessionsRow({
  state,
  now,
  selected,
  onClick,
}: {
  state: NotchState;
  now: number;
  selected?: boolean;
  onClick: () => void;
}) {
  const sessions = sessionsOf(state);
  if (sessions.length === 0) return null;
  const [latest] = sessions;
  const working = sessions.filter((s) => s.mood === "working").length;
  const waiting = sessionsWaiting(state);
  const line = [
    working ? `${working} working` : "",
    waiting ? `${waiting} your turn` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <RowShell
      testId="notch-row-sessions"
      face={
        <span className="nrow-terminal">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5" />
          </svg>
        </span>
      }
      name="Sessions"
      count={sessions.length}
      time={rowTime(latest, now)}
      line={line || latest.name}
      dot={null}
      selected={selected}
      onClick={onClick}
    />
  );
}
