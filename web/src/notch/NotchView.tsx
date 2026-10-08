import { type FormEvent, useState } from "react";

import { GawkBot } from "./GawkBot";
import type {
  Mood,
  NotchAgent,
  NotchAttention,
  NotchGeometry,
  NotchState,
} from "./types";

// Presentational notch. NotchApp owns data and the native bridge; this file
// only lays out the two shapes:
//
//   collapsed — a black strip exactly as tall as the camera notch, wider by
//               one "ear" on each side. Left ear: the Chief of Staff acting
//               out the office's overall mood. Right ear: up to three
//               agents that most need looking at, plus a count badge when
//               something waits on the human.
//   expanded  — the strip drops into a panel: the Chief of Staff's
//               headline, what needs you (one-tap answers), every agent,
//               and a box to tell the Chief of Staff what to do.

export const EXPANDED_WIDTH = 440;
export const EXPANDED_HEIGHT = 420;

export interface NotchViewProps {
  state: NotchState | null;
  geometry: NotchGeometry;
  expanded: boolean;
  /** Request ids with an answer in flight. */
  answering?: ReadonlySet<string>;
  sending?: boolean;
  error?: string | null;
  onAnswer: (requestId: string, choiceId: string) => void;
  onSend: (text: string) => void;
  onOpen: (path: string) => void;
  onKeyboard: (active: boolean) => void;
}

function collapsedWidth(g: NotchGeometry): number {
  return g.notchWidth + 2 * g.earWidth;
}

function moodRank(mood: Mood): number {
  return { needs_you: 0, error: 1, working: 2, done: 3, idle: 4 }[mood];
}

function originTag(
  agent: NotchAgent,
): { text: string; elsewhere: boolean } | null {
  if (agent.runs_on === "elsewhere") {
    return { text: agent.runs_on_detail || "elsewhere", elsewhere: true };
  }
  switch (agent.origin) {
    case "user":
      return { text: "yours", elsewhere: false };
    case "adopted":
      return { text: "adopted", elsewhere: false };
    case "chief_of_staff":
      return { text: "hired by CoS", elsewhere: false };
    default:
      return null;
  }
}

function channelPath(channel: string | undefined): string {
  return channel ? `/channels/${encodeURIComponent(channel)}` : "/inbox";
}

function Strip({
  state,
  geometry,
}: {
  state: NotchState | null;
  geometry: NotchGeometry;
}) {
  const others = (state?.agents ?? [])
    .filter((a) => !a.is_lead && a.mood !== "idle")
    .sort((a, b) => moodRank(a.mood) - moodRank(b.mood))
    .slice(0, 3);
  const count = state?.attention.length ?? 0;
  const botSize = Math.max(12, Math.min(20, geometry.notchHeight - 12));
  return (
    <div
      className="notch-strip"
      style={{ height: geometry.notchHeight }}
      title={state?.headline}
    >
      <div className="notch-ear">
        <GawkBot
          mood={state?.mood ?? "idle"}
          size={botSize}
          label={`Chief of Staff: ${state?.headline ?? "connecting"}`}
        />
      </div>
      {/* The camera housing sits here; nothing is drawn under it. */}
      <div style={{ width: geometry.notchWidth, flexShrink: 0 }} />
      <div className="notch-ear notch-ear-right">
        {others.map((a, i) => (
          <GawkBot
            key={a.slug}
            mood={a.mood}
            size={botSize - 2}
            phase={i + 1}
            label={`${a.name}: ${a.mood.replace("_", " ")}`}
          />
        ))}
        {count > 0 ? (
          <span
            className="notch-badge mood-needs_you"
            role="img"
            aria-label={`${count} need you`}
          >
            <span>{count}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AttentionCard({
  item,
  busy,
  onAnswer,
  onOpen,
}: {
  item: NotchAttention;
  busy: boolean;
  onAnswer: NotchViewProps["onAnswer"];
  onOpen: NotchViewProps["onOpen"];
}) {
  const oneTap = (item.options ?? []).filter((o) => !o.requires_text);
  const needsTyping =
    oneTap.length === 0 || (item.options ?? []).some((o) => o.requires_text);
  return (
    <div className="notch-card" data-testid={`notch-attention-${item.id}`}>
      <GawkBot mood="needs_you" size={18} label="" />
      <div className="notch-card-body">
        <div className="notch-card-from">
          @{item.from || "someone"}
          {item.blocking ? " · holding up work" : ""}
        </div>
        <div className="notch-card-question">
          {item.title ? <strong>{item.title} </strong> : null}
          {item.question && item.question !== item.title ? item.question : null}
        </div>
        <div className="notch-actions">
          {oneTap.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`notch-btn${o.id === item.recommended_id ? " is-primary" : ""}`}
              disabled={busy}
              onClick={() => onAnswer(item.id, o.id)}
            >
              {o.label}
            </button>
          ))}
          {needsTyping ? (
            <button
              type="button"
              className="notch-btn"
              onClick={() => onOpen(channelPath(item.channel))}
            >
              Answer in app
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AgentRow({ agent, phase }: { agent: NotchAgent; phase: number }) {
  const tag = originTag(agent);
  return (
    <div className="notch-agent" data-testid={`notch-agent-${agent.slug}`}>
      <GawkBot mood={agent.mood} size={16} phase={phase} />
      <span className="notch-agent-name">
        {agent.is_lead ? `${agent.name} (CoS)` : agent.name}
      </span>
      <span className="notch-agent-detail">
        {agent.detail || agent.mood.replace("_", " ")}
      </span>
      {tag ? (
        <span className={`notch-tag${tag.elsewhere ? " is-elsewhere" : ""}`}>
          {tag.text}
        </span>
      ) : null}
    </div>
  );
}

function Compose({
  leadName,
  sending,
  onSend,
  onKeyboard,
}: {
  leadName: string;
  sending: boolean;
  onSend: NotchViewProps["onSend"];
  onKeyboard: NotchViewProps["onKeyboard"];
}) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setText("");
  };
  return (
    <form className="notch-compose" onSubmit={submit}>
      <input
        aria-label={`Message ${leadName}`}
        placeholder={`Tell ${leadName} what to do…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => onKeyboard(true)}
        onBlur={() => onKeyboard(false)}
      />
      <button
        type="submit"
        className="notch-btn is-primary"
        disabled={sending || !text.trim()}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}

function Panel(props: NotchViewProps) {
  const {
    state,
    answering,
    sending,
    error,
    onAnswer,
    onOpen,
    onSend,
    onKeyboard,
  } = props;
  if (!state) {
    return (
      <div className="notch-panel">
        <div className="notch-headline">Waking the office…</div>
      </div>
    );
  }
  const leadName = state.lead_name || "the Chief of Staff";
  return (
    <div className="notch-panel">
      <div className="notch-headline">
        <GawkBot mood={state.mood} size={22} label="" />
        <div>
          <small>{leadName}</small>
          {state.headline}
        </div>
      </div>

      {state.attention.length > 0 ? (
        <>
          <div className="notch-section-title">Needs you</div>
          {state.attention.map((item) => (
            <AttentionCard
              key={item.id}
              item={item}
              busy={answering?.has(item.id) ?? false}
              onAnswer={onAnswer}
              onOpen={onOpen}
            />
          ))}
        </>
      ) : null}

      <div className="notch-section-title">Agents</div>
      <div>
        {state.agents.map((a, i) => (
          <AgentRow key={a.slug} agent={a} phase={i} />
        ))}
      </div>

      {error ? (
        <div className="notch-error" role="alert">
          {error}
        </div>
      ) : null}

      {state.lead_dm ? (
        <Compose
          leadName={leadName}
          sending={!!sending}
          onSend={onSend}
          onKeyboard={onKeyboard}
        />
      ) : null}
    </div>
  );
}

export function NotchView(props: NotchViewProps) {
  const { geometry, expanded, state } = props;
  const width = expanded
    ? Math.max(EXPANDED_WIDTH, collapsedWidth(geometry))
    : collapsedWidth(geometry);
  return (
    <div
      className={`notch-shell ${expanded ? "is-expanded" : "is-collapsed"}`}
      style={{
        width,
        height: expanded ? EXPANDED_HEIGHT : geometry.notchHeight,
      }}
      data-testid="notch-shell"
      data-mood={state?.mood ?? "idle"}
    >
      <Strip state={state} geometry={geometry} />
      {expanded ? <Panel {...props} /> : null}
    </div>
  );
}
