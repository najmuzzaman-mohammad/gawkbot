import { type FormEvent, useEffect, useRef } from "react";

import { SHORTCUTS } from "./keys";
import { NotchBot } from "./NotchBot";
import { NotchHero } from "./NotchHero";
import type { NotchAgent, NotchAttention, NotchState } from "./types";

// The open notch: a glass panel that drops out of the camera housing.
// Questions first (selectable, every answer numbered so it is one keystroke),
// then every agent, then the composer that replies to whoever is selected,
// by keyboard or by voice.

export type ReplyTarget =
  | { kind: "answer"; requestId: string; to: string }
  | { kind: "message"; slug: string; name: string; channel: string };

export interface ComposerState {
  target: ReplyTarget;
  text: string;
  listening: boolean;
}

export interface PanelProps {
  state: NotchState | null;
  selectedId: string | null;
  answering: ReadonlySet<string>;
  composer: ComposerState | null;
  sending: boolean;
  error: string | null;
  soundOn: boolean;
  voiceAvailable: boolean;
  onSelect: (id: string) => void;
  onAnswer: (requestId: string, choiceId: string) => void;
  onReply: (target: ReplyTarget) => void;
  onComposerText: (text: string) => void;
  onComposerSubmit: () => void;
  onComposerCancel: () => void;
  onVoice: (on: boolean) => void;
  onOpen: (path: string) => void;
  onKeyboard: (active: boolean) => void;
  onToggleSound: () => void;
  /** Leave the widget for the full app; closing that window comes back here. */
  onOpenFull: () => void;
  /** Bumped each time an answer lands; the lead claps for it. */
  cheer?: number;
}

// One short tag per fact: who made the agent, then where it runs. Mirrors
// NotchAgent.tags in the iOS app (GawkbotKit/NotchState.swift).
interface AgentTag {
  text: string;
  elsewhere: boolean;
}

function originTag(agent: NotchAgent): AgentTag | null {
  switch (agent.origin) {
    case "user":
      return { text: "yours", elsewhere: false };
    case "adopted":
      return { text: "adopted", elsewhere: false };
    case "chief_of_staff":
      return { text: "hired by CoS", elsewhere: false };
    case "imported":
      return { text: "imported", elsewhere: false };
    default:
      return null;
  }
}

// "Hermes gateway" for an agent elsewhere; "Claude Code · this Mac" for a
// local one whose tool the broker names ("Claude Code on this machine");
// nothing for a plain local agent.
function whereTag(agent: NotchAgent): AgentTag | null {
  const detail = agent.runs_on_detail?.trim() ?? "";
  if (agent.runs_on === "elsewhere") {
    return { text: detail || "elsewhere", elsewhere: true };
  }
  const tool = detail.replace(/ on this machine$/, "");
  if (!tool || tool === detail) return null;
  return { text: `${tool} · this Mac`, elsewhere: false };
}

/** The one tag a question card shows: where, when that is not here; else who. */
function primaryTag(agent: NotchAgent): AgentTag | null {
  const where = whereTag(agent);
  if (where?.elsewhere) return where;
  return originTag(agent) ?? where;
}

/** Every tag, for the roster. */
function agentTags(agent: NotchAgent): AgentTag[] {
  return [originTag(agent), whereTag(agent)].filter(
    (t): t is AgentTag => t !== null,
  );
}

function Tag({ tag }: { tag: AgentTag }) {
  return (
    <span className={`ntag${tag.elsewhere ? " is-elsewhere" : ""}`}>
      {tag.text}
    </span>
  );
}

export function dmChannel(a: string, b: string): string {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

function channelPath(channel: string | undefined): string {
  return channel ? `/channels/${encodeURIComponent(channel)}` : "/inbox";
}

function Question({
  item,
  agent,
  selected,
  busy,
  onSelect,
  onAnswer,
  onReply,
  onOpen,
}: {
  item: NotchAttention;
  agent: NotchAgent | undefined;
  selected: boolean;
  busy: boolean;
  onSelect: PanelProps["onSelect"];
  onAnswer: PanelProps["onAnswer"];
  onReply: PanelProps["onReply"];
  onOpen: PanelProps["onOpen"];
}) {
  const oneTap = (item.options ?? []).filter((o) => !o.requires_text);
  const tag = agent ? primaryTag(agent) : null;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  return (
    <article
      ref={ref}
      aria-label={`Question from ${agent?.name ?? item.from_name ?? item.from}`}
      className={`nq${selected ? " is-selected" : ""}`}
      data-testid={`notch-attention-${item.id}`}
      onMouseEnter={() => onSelect(item.id)}
    >
      <NotchBot
        slug={item.from || "someone"}
        avatar={agent?.avatar}
        mood="needs_you"
        size={28}
        bare={true}
        label=""
      />
      <div className="nq-body">
        <div className="nq-from">
          <b>{agent?.name ?? item.from_name ?? item.from}</b>
          {tag ? <Tag tag={tag} /> : null}
          {item.blocking ? (
            <span className="ntag is-blocking">holding up work</span>
          ) : null}
        </div>
        <div className="nq-text">
          {item.title ? <strong>{item.title} </strong> : null}
          {item.question && item.question !== item.title ? item.question : null}
        </div>
        <div className="nq-actions">
          {oneTap.map((o, i) => (
            <button
              key={o.id}
              type="button"
              className={`nbtn${o.id === item.recommended_id ? " is-primary" : /^(reject|deny|decline)/i.test(o.id) ? " is-danger" : ""}`}
              disabled={busy}
              onClick={() => onAnswer(item.id, o.id)}
            >
              {selected && i < 9 ? <kbd>{i + 1}</kbd> : null}
              {o.label}
            </button>
          ))}
          <button
            type="button"
            className="nbtn is-quiet"
            onClick={() =>
              onReply({
                kind: "answer",
                requestId: item.id,
                to: agent?.name ?? item.from,
              })
            }
          >
            {selected ? <kbd>R</kbd> : null}Reply
          </button>
          <button
            type="button"
            className="nbtn is-quiet"
            onClick={() => onOpen(channelPath(item.channel))}
          >
            Open
          </button>
        </div>
      </div>
    </article>
  );
}

function Composer({
  composer,
  sending,
  voiceAvailable,
  onText,
  onSubmit,
  onCancel,
  onVoice,
  onKeyboard,
}: {
  composer: ComposerState;
  sending: boolean;
  voiceAvailable: boolean;
  onText: PanelProps["onComposerText"];
  onSubmit: PanelProps["onComposerSubmit"];
  onCancel: PanelProps["onComposerCancel"];
  onVoice: PanelProps["onVoice"];
  onKeyboard: PanelProps["onKeyboard"];
}) {
  const input = useRef<HTMLInputElement>(null);
  // Esc is handled once, by the window key handler (hooks.ts): it cancels
  // this reply first and only closes the notch when nothing is being typed.
  // Remounted per target (see the key on <Composer>), so this runs once per reply.
  useEffect(() => {
    input.current?.focus();
  }, []);
  const to =
    composer.target.kind === "answer"
      ? composer.target.to
      : composer.target.name;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (composer.text.trim() && !sending) onSubmit();
  };
  return (
    <form
      className={`ncompose${composer.listening ? " is-listening" : ""}`}
      onSubmit={submit}
    >
      <div className="ncompose-to">
        {composer.target.kind === "answer" ? "Answering" : "Message"}{" "}
        <b>{to}</b>
        <button
          type="button"
          className="ncompose-x"
          aria-label="Cancel reply"
          onClick={onCancel}
        >
          Esc
        </button>
      </div>
      <div className="ncompose-row">
        <input
          ref={input}
          aria-label={`Reply to ${to}`}
          placeholder={
            composer.listening
              ? "Listening…"
              : `Type, or hold ⌥V to talk to ${to}`
          }
          value={composer.text}
          onChange={(e) => onText(e.target.value)}
          onFocus={() => onKeyboard(true)}
          onBlur={() => onKeyboard(false)}
        />
        {voiceAvailable ? (
          <button
            type="button"
            className={`nmic${composer.listening ? " is-on" : ""}`}
            aria-label={composer.listening ? "Stop listening" : "Talk"}
            aria-pressed={composer.listening}
            onPointerDown={() => onVoice(true)}
            onPointerUp={() => onVoice(false)}
            onPointerLeave={() => composer.listening && onVoice(false)}
          >
            <span className="nmic-wave" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
          </button>
        ) : null}
        <button
          type="submit"
          className="nbtn is-primary"
          disabled={sending || !composer.text.trim()}
        >
          {sending ? "Sending" : "Send"} <kbd>↵</kbd>
        </button>
      </div>
    </form>
  );
}

export function NotchPanel(props: PanelProps) {
  const {
    state,
    selectedId,
    answering,
    composer,
    sending,
    error,
    soundOn,
    voiceAvailable,
  } = props;
  if (!state) {
    return (
      <div className="npanel">
        <div className="nhead">
          <div className="nhead-text">Waking the office…</div>
        </div>
      </div>
    );
  }
  const leadName = state.lead_name || "Chief of Staff";
  const bySlug = new Map(state.agents.map((a) => [a.slug, a]));
  return (
    <div className="npanel">
      <NotchHero
        slug={state.lead ?? "cos"}
        avatar={bySlug.get(state.lead ?? "cos")?.avatar}
        mood={state.mood}
        focusId={selectedId}
        cheer={props.cheer ?? 0}
      >
        <div className="nhead-text">
          <small>{leadName}</small>
          {state.headline}
        </div>
        <button
          type="button"
          className="nicon nicon-wide"
          aria-label="Open full view"
          title="Open the full app (O). Close its window to come back to the notch."
          onClick={props.onOpenFull}
        >
          <span aria-hidden="true">↗</span> Full view
        </button>
        <button
          type="button"
          className="nicon"
          aria-label={soundOn ? "Mute sounds" : "Unmute sounds"}
          aria-pressed={soundOn}
          onClick={props.onToggleSound}
        >
          {soundOn ? "🔊" : "🔈"}
        </button>
      </NotchHero>

      <div className="nscroll">
        {state.attention.length > 0 ? (
          <section aria-label="Needs you">
            <h3 className="nsection">Needs you · {state.attention.length}</h3>
            {state.attention.map((item) => (
              <Question
                key={item.id}
                item={item}
                agent={bySlug.get(item.from)}
                selected={item.id === selectedId}
                busy={answering.has(item.id)}
                onSelect={props.onSelect}
                onAnswer={props.onAnswer}
                onReply={props.onReply}
                onOpen={props.onOpen}
              />
            ))}
          </section>
        ) : null}

        <section aria-label="Agents">
          <h3 className="nsection">Agents · {state.agents.length}</h3>
          <div className="nagents">
            {state.agents.map((a, i) => {
              const tags = agentTags(a);
              return (
                <button
                  type="button"
                  key={a.slug}
                  className="nagent"
                  data-testid={`notch-agent-${a.slug}`}
                  onClick={() =>
                    props.onReply({
                      kind: "message",
                      slug: a.slug,
                      name: a.name,
                      channel:
                        a.is_lead && state.lead_dm
                          ? state.lead_dm
                          : dmChannel("human", a.slug),
                    })
                  }
                >
                  <NotchBot
                    slug={a.slug}
                    avatar={a.avatar}
                    mood={a.mood}
                    size={24}
                    phase={i}
                    label=""
                  />
                  <span className="nagent-name">
                    {a.is_lead ? `${a.name}` : a.name}
                  </span>
                  <span className="nagent-detail">
                    {a.detail || a.mood.replace("_", " ")}
                  </span>
                  {tags.map((tag) => (
                    <Tag key={tag.text} tag={tag} />
                  ))}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {error ? (
        <div className="nerror" role="alert">
          {error}
        </div>
      ) : null}

      {composer ? (
        <Composer
          key={
            composer.target.kind === "answer"
              ? `a:${composer.target.requestId}`
              : `m:${composer.target.channel}`
          }
          composer={composer}
          sending={sending}
          voiceAvailable={voiceAvailable}
          onText={props.onComposerText}
          onSubmit={props.onComposerSubmit}
          onCancel={props.onComposerCancel}
          onVoice={props.onVoice}
          onKeyboard={props.onKeyboard}
        />
      ) : (
        <button
          type="button"
          className="nask"
          onClick={() =>
            state.lead_dm &&
            props.onReply({
              kind: "message",
              slug: state.lead ?? "cos",
              name: leadName,
              channel: state.lead_dm,
            })
          }
        >
          <span>Ask {leadName} to manage any agent…</span>
          <span className="nask-keys">
            <kbd>M</kbd>
            {voiceAvailable ? <kbd>V</kbd> : null}
          </span>
        </button>
      )}

      <footer className="nkeys">
        {SHORTCUTS.map(([k, what]) => (
          <span key={k}>
            <kbd>{k}</kbd> {what}
          </span>
        ))}
      </footer>
    </div>
  );
}
