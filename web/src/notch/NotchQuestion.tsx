import { useLayoutEffect, useRef } from "react";

import { type Choice, choicesOf } from "./choices";
import { NotchBot } from "./NotchBot";
import { channelPath, type ReplyTarget } from "./shared";
import type { NotchAgent, NotchAttention, NotchBrief } from "./types";

// A question a bot is waiting on you for: who asks, what, the answers to
// pick from (one keystroke each when selected), and its background.

export interface QuestionHandlers {
  onSelect: (id: string) => void;
  onAnswer: (requestId: string, choiceId: string) => void;
  onReply: (target: ReplyTarget) => void;
  /** Sends text straight to target: a suggested reply, chosen. */
  onSend: (target: ReplyTarget, text: string) => void;
  onOpen: (path: string) => void;
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

function Tag({ tag }: { tag: AgentTag }) {
  return (
    <span className={`ntag${tag.elsewhere ? " is-elsewhere" : ""}`}>
      {tag.text}
    </span>
  );
}

/**
 * What the card offers to send back, as a list: the recommended one on top
 * and marked, each one tap (or its number key, on the selected question).
 * An option's meaning shows once its card is open; a suggested reply always
 * shows its words, since those words are what is sent.
 */
function Choices({
  choices,
  keys,
  busy,
  pending,
  danger,
  onChoose,
}: {
  choices: Choice[];
  keys: boolean;
  busy: boolean;
  /** The replies are still being written. */
  pending?: boolean;
  danger?: (c: Choice) => boolean;
  onChoose: (c: Choice) => void;
}) {
  if (choices.length === 0) {
    return pending ? (
      <p className="nchoices-pending" role="status">
        Writing suggested replies…
      </p>
    ) : null;
  }
  return (
    <ul className="nchoices" aria-label="Choose a reply">
      {choices.map((c, i) => (
        <li key={c.key}>
          <button
            type="button"
            className={`nchoice${c.recommended ? " is-recommended" : ""}${danger?.(c) ? " is-danger" : ""}`}
            disabled={busy}
            onClick={() => onChoose(c)}
          >
            {keys && i < 9 ? <kbd>{i + 1}</kbd> : null}
            <span className="nchoice-text">
              <span className="nchoice-label">
                {c.label}
                {c.recommended ? (
                  <span className="nchoice-rec">Recommended</span>
                ) : null}
              </span>
              {c.detail && (c.kind === "reply" || keys) ? (
                <span className="nchoice-detail">{c.detail}</span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Question({
  item,
  agent,
  selected,
  busy,
  onSelect,
  onAnswer,
  onReply,
  onSend,
  onOpen,
}: {
  item: NotchAttention;
  agent: NotchAgent | undefined;
  selected: boolean;
  busy: boolean;
  onSelect: QuestionHandlers["onSelect"];
  onAnswer: QuestionHandlers["onAnswer"];
  onReply: QuestionHandlers["onReply"];
  onSend: QuestionHandlers["onSend"];
  onOpen: QuestionHandlers["onOpen"];
}) {
  const choices = choicesOf(item);
  const to = agent?.name ?? item.from;
  const choose = (c: Choice) =>
    c.kind === "option"
      ? onAnswer(item.id, c.optionId)
      : onSend({ kind: "answer", requestId: item.id, to }, c.text);
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
      onFocus={() => {
        if (!selected) onSelect(item.id);
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
        <Choices
          choices={choices}
          keys={selected}
          busy={busy}
          pending={item.suggestions_pending}
          danger={(c) =>
            c.kind === "option" && /^(reject|deny|decline)/i.test(c.optionId)
          }
          onChoose={choose}
        />
        <div className="nq-actions">
          <button
            type="button"
            className={`nbtn${choices.length === 0 ? " is-primary" : " is-quiet"}`}
            onClick={() =>
              onReply({
                kind: "answer",
                requestId: item.id,
                to,
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
            Open in gawkbot
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * A session found on this Mac, not a gawkbot bot: a terminal mark beside
 * the name, the one thing that tells them apart in a shared list.
 */
export function SessionMark({ agent }: { agent: NotchAgent }) {
  const what = `${agent.tool_name || "Terminal"} session on this Mac`;
  return (
    <span className="nsession-mark" role="img" aria-label={what} title={what}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5" />
      </svg>
    </span>
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
