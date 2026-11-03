import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { getMessages, type Message } from "../api/client";
import { announceOn } from "./announce";
import { markRead } from "./api";
import { questionsFrom } from "./home/model";
import { NotchBot } from "./NotchBot";
import { Composer } from "./NotchComposer";
import { NotchHint } from "./NotchHint";
import { NotchPermissionCard } from "./NotchPermissionCard";
import { Question, type QuestionHandlers } from "./NotchQuestion";
import { NotchVoiceLine } from "./NotchVoiceLine";
import type { RealtimeTalk } from "./realtime/useRealtime";
import type { NotchScreen } from "./screens";
import type { ComposerState, ReplyTarget } from "./shared";
import type { NotchState } from "./types";
import { useThreadVoice } from "./useThreadVoice";

export const THREAD_QUERY_PREFIX = "notch-thread";
const THREAD_LINES = 60;
const THREAD_POLL_MS = 2_000;

export interface NotchThreadProps extends QuestionHandlers {
  state: NotchState;
  screen: Extract<NotchScreen, { kind: "agent" }>;
  composer: ComposerState | null;
  sending: boolean;
  voiceAvailable: boolean;
  selectedId?: string | null;
  answering?: ReadonlySet<string>;
  onComposerText: (text: string) => void;
  onComposerSubmit: () => void;
  onComposerCancel: () => void;
  /** Starts a message to this bot when the box is empty and clicked. */
  onCompose: (target: ReplyTarget) => void;
  onVoice: (on: boolean) => void;
  onKeyboard: (active: boolean) => void;
  /** Stops this bot's running turns. */
  onStop: (slug: string) => void;
  onPermission?: (kind: "accessibility" | "screen_recording") => void;
  /** Talking to the office out loud (realtime/useRealtime.ts). */
  voice?: Pick<RealtimeTalk, "phase" | "heard" | "said" | "error">;
  /** The talk key is down: the bot's new lines wait, unspoken. */
  talking?: boolean;
}

/** Whether a message is the person's own. */
export function isYours(message: Pick<Message, "from">): boolean {
  return message.from === "human" || message.from === "you";
}

/** The last lines of the conversation, oldest first. */
export function threadLines(messages: readonly Message[]): Message[] {
  return [...messages]
    .filter((m) => m.content.trim() !== "")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-THREAD_LINES);
}

/**
 * One bot's chat: its face and name on top, the conversation as bubbles,
 * any question it is waiting on you for, what it is doing right now, and
 * the box at the bottom. Polls while shown and refetches on the live
 * stream like the rest of the notch.
 */
export function NotchThread(props: NotchThreadProps) {
  const { state, screen, composer } = props;
  const agent = state.agents.find((a) => a.slug === screen.slug);
  const query = useQuery({
    queryKey: [THREAD_QUERY_PREFIX, screen.channel],
    queryFn: () => getMessages(screen.channel, null, THREAD_LINES),
    refetchInterval: THREAD_POLL_MS,
  });
  const lines = threadLines(query.data?.messages ?? []);
  const questions = questionsFrom(state, screen.slug);
  // The question the keyboard is on, else this bot's first.
  const openQuestion =
    questions.find((q) => q.id === props.selectedId)?.id ?? questions[0]?.id;
  const list = useRef<HTMLDivElement>(null);
  const working = agent?.mood === "working";
  const bottomKey = `${lines.length}:${questions.length}:${working}`;
  useEffect(() => {
    const el = list.current;
    if (el && bottomKey) el.scrollTop = el.scrollHeight;
  }, [bottomKey]);
  // Shown is read: the newest line is marked each time it changes.
  const newest = lines.at(-1)?.id ?? "";
  useEffect(() => {
    if (newest) void markRead(screen.channel, newest).catch(() => undefined);
  }, [newest, screen.channel]);
  // The bot talks back: its new lines are read out loud as they land.
  useThreadVoice(lines, announceOn(state), props.talking === true);
  const name = agent?.name ?? screen.name;
  const isLead = agent?.is_lead === true;
  const ownTarget: ReplyTarget = {
    kind: "message",
    slug: screen.slug,
    name,
    channel: screen.channel,
  };
  const boxOpen =
    composer &&
    (composer.target.kind === "answer"
      ? questions.some(
          (q) =>
            composer.target.kind === "answer" &&
            q.id === composer.target.requestId,
        )
      : composer.target.channel === screen.channel);
  return (
    <section className="nchat" data-testid={`notch-thread-${screen.slug}`}>
      <header className="nchat-head">
        <NotchBot
          slug={screen.slug}
          avatar={agent?.avatar}
          mood={agent?.mood ?? "idle"}
          size={30}
          label=""
        />
        <button
          type="button"
          className="nchat-name"
          title="Open in the full app"
          aria-label={`Open ${name} in full view`}
          onClick={() =>
            props.onOpen(`/channels/${encodeURIComponent(screen.channel)}`)
          }
        >
          {name} <span aria-hidden="true">›</span>
        </button>
      </header>
      <div className="nchat-msgs" ref={list}>
        {isLead &&
        state.host_wanted &&
        state.permissions &&
        props.onPermission ? (
          <NotchPermissionCard
            permissions={state.permissions}
            onRequest={props.onPermission}
          />
        ) : null}
        {isLead && state.hint ? (
          <NotchHint
            key={state.hint.platform}
            hint={state.hint}
            onOpen={props.onOpen}
          />
        ) : null}
        {query.isLoading ? (
          <p className="nchat-empty">Opening the conversation…</p>
        ) : lines.length === 0 && questions.length === 0 ? (
          <p className="nchat-empty">Nothing said yet. Say the first thing.</p>
        ) : (
          lines.map((m) => (
            <div
              key={m.id}
              className={`nmsg${isYours(m) ? " is-you" : ""}`}
              data-testid="notch-msg"
            >
              <span className="nmsg-text">{m.content}</span>
            </div>
          ))
        )}
        {questions.map((q) => (
          <Question
            key={q.id}
            item={q}
            agent={agent}
            selected={q.id === openQuestion}
            busy={props.answering?.has(q.id) ?? false}
            onSelect={props.onSelect}
            onAnswer={props.onAnswer}
            onReply={props.onReply}
            onSend={props.onSend}
            onOpen={props.onOpen}
          />
        ))}
        {working ? (
          <div className="nchat-working" data-testid="notch-working">
            <span className="nchat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <small>{agent?.detail || "Working"}</small>
          </div>
        ) : null}
      </div>
      {props.voice && props.voice.phase !== "idle" ? (
        <NotchVoiceLine
          phase={props.voice.phase}
          heard={props.voice.heard}
          said={props.voice.said}
          error={props.voice.error}
        />
      ) : null}
      <div className="nchat-foot">
        {boxOpen && composer ? (
          <Composer
            key={
              composer.target.kind === "answer"
                ? `a:${composer.target.requestId}`
                : `m:${screen.channel}`
            }
            composer={composer}
            sending={props.sending}
            voiceAvailable={props.voiceAvailable}
            face={{ slug: screen.slug, avatar: agent?.avatar }}
            onText={props.onComposerText}
            onSubmit={props.onComposerSubmit}
            onCancel={props.onComposerCancel}
            onVoice={props.onVoice}
            onKeyboard={props.onKeyboard}
            onStop={working ? () => props.onStop(screen.slug) : undefined}
          />
        ) : (
          <button
            type="button"
            className="ncompose-idle"
            data-testid="notch-compose-idle"
            onClick={() => props.onCompose(ownTarget)}
          >
            Message {name}…
          </button>
        )}
      </div>
    </section>
  );
}
