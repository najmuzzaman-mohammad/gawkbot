import { type FormEvent, useEffect, useLayoutEffect, useRef } from "react";

import { RuntimeLogo } from "../components/onboarding/RuntimeLogos";
import { SHORTCUTS } from "./keys";
import { NotchBot } from "./NotchBot";
import { NotchHero } from "./NotchHero";
import type {
  NotchAgent,
  NotchAttention,
  NotchBrief,
  NotchSession,
  NotchState,
} from "./types";

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
  /** Agent sessions running on this Mac, each named by what it is doing. */
  sessions?: NotchSession[];
  /** The agent list is folded away until asked for. */
  agentsOpen: boolean;
  onAgentsOpen: (open: boolean) => void;
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
  // Where this card's top was when the pointer entered it. Opening it (and
  // closing the one before it) reflows the list; the scroll is nudged so
  // the card stays under the pointer instead of sliding away from it.
  const hoverTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!(selected && el)) return;
    const anchor = hoverTop.current;
    hoverTop.current = null;
    if (anchor === null) {
      // Selected from the keyboard: bring it into view.
      el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      return;
    }
    const scroller = el.closest(".nscroll");
    if (scroller) scroller.scrollTop += el.getBoundingClientRect().top - anchor;
  }, [selected]);
  const brief = selected ? item.brief : undefined;
  const described = oneTap.filter((o) => o.description);
  return (
    <article
      ref={ref}
      aria-label={`Question from ${agent?.name ?? item.from_name ?? item.from}`}
      className={`nq${selected ? " is-selected" : ""}`}
      data-testid={`notch-attention-${item.id}`}
      data-open={selected ? "true" : undefined}
      onMouseEnter={() => {
        if (!selected) {
          hoverTop.current = ref.current?.getBoundingClientRect().top ?? null;
        }
        onSelect(item.id);
      }}
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
        {brief ? (
          <Brief brief={brief} />
        ) : item.context ? (
          <p className="nq-context">{item.context}</p>
        ) : null}
        {selected && described.length > 0 ? (
          <dl className="nq-means">
            {described.map((o) => (
              <div key={o.id}>
                <dt>{o.label}</dt>
                <dd>{o.description}</dd>
              </div>
            ))}
          </dl>
        ) : null}
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

/**
 * The opened card's background: which project this is, what the asker was
 * working on, its own account of the decision in full, and the last few
 * lines of the conversation that led here.
 */
function Brief({ brief }: { brief: NotchBrief }) {
  const { task, recent } = brief;
  return (
    <div className="nq-brief" data-testid="notch-brief">
      {brief.project ? (
        <section>
          <h4>Project</h4>
          <p>
            <b>#{brief.project}</b>
            {brief.project_about ? ` ${brief.project_about}` : null}
          </p>
        </section>
      ) : null}
      {task ? (
        <section>
          <h4>Working on</h4>
          <p>
            <b>{task.title}</b>
            {task.status ? (
              <span className="ntag">{task.status.replace(/_/g, " ")}</span>
            ) : null}
          </p>
          {task.details ? <p>{task.details}</p> : null}
        </section>
      ) : null}
      {brief.context ? (
        <section>
          <h4>Why it is asking</h4>
          <p>{brief.context}</p>
        </section>
      ) : null}
      {recent && recent.length > 0 ? (
        <section>
          <h4>Just before</h4>
          <ul>
            {recent.map((line) => (
              <li key={`${line.at ?? ""}:${line.from}:${line.text}`}>
                <b>{line.name || line.from}</b> {line.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// The logo says which tool a session runs in, so the words can say what
// the session is about.
const TOOL_LOGO: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** "now", "4m", "2h": how long since a session last did something. */
export function sinceShort(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const min = Math.floor(ms / 60_000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
}

function Sessions({ sessions }: { sessions: NotchSession[] }) {
  const now = Date.now();
  return (
    <section aria-label="Running on this Mac">
      <h3 className="nsection">Running on this Mac · {sessions.length}</h3>
      <ul className="nsessions">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={`nsession${s.active ? " is-active" : ""}`}
            data-testid={`notch-session-${s.id}`}
          >
            <span
              className="nsession-tool"
              role="img"
              aria-label={s.tool_name}
              title={s.tool_name}
            >
              <RuntimeLogo label={TOOL_LOGO[s.tool] ?? s.tool_name} />
            </span>
            <span className="nsession-title">{s.title}</span>
            {s.project ? (
              <span className="nsession-project">{s.project}</span>
            ) : null}
            <span className="nsession-when">
              {s.active ? "working" : sinceShort(s.updated_at, now)}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
  const agentsOpen = props.agentsOpen;
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

        {props.sessions && props.sessions.length > 0 ? (
          <Sessions sessions={props.sessions} />
        ) : null}

        <section aria-label="Agents">
          <h3 className="nsection">
            <button
              type="button"
              className="nsection-toggle"
              aria-expanded={agentsOpen}
              onClick={() => props.onAgentsOpen(!agentsOpen)}
            >
              <span aria-hidden="true">{agentsOpen ? "▾" : "▸"}</span> Agents ·{" "}
              {state.agents.length}
            </button>
          </h3>
          {agentsOpen ? (
            <div className="nagents">
              {state.agents.map((a, i) => {
                const tags = agentTags(a);
                return (
                  <div
                    className="nagent-row"
                    key={a.slug}
                    data-testid={`notch-agent-${a.slug}`}
                  >
                    <button
                      type="button"
                      className="nagent"
                      aria-label={`Message ${a.name}`}
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
                      <span className="nagent-name">{a.name}</span>
                      <span className="nagent-detail">
                        {a.detail || a.mood.replace("_", " ")}
                      </span>
                      {tags.map((tag) => (
                        <Tag key={tag.text} tag={tag} />
                      ))}
                    </button>
                    <button
                      type="button"
                      className="nagent-open"
                      aria-label={`Open ${a.name} in full view`}
                      title="Open in the full app"
                      onClick={() =>
                        props.onOpen(`/agents/${encodeURIComponent(a.slug)}`)
                      }
                    >
                      <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
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
