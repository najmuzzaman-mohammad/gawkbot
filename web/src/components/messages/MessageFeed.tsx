import { useEffect, useMemo, useRef } from "react";

import type { Message } from "../../api/client";
import { useMessages } from "../../hooks/useMessages";
import { formatDateLabel } from "../../lib/format";
import { OFFICE_LOADING_PHRASES } from "../../lib/officeLoadingPhrases";
import { useChannelSlug } from "../../routes/useCurrentRoute";
import { useAppStore } from "../../stores/app";
import { ThinkingLoader } from "../ui/ThinkingLoader";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";

function dateDayKey(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

type ThreadMessage = {
  message: Message;
  grouped: boolean;
};

type FeedElement =
  | { type: "date"; key: string; label: string }
  | {
      type: "thread";
      key: string;
      parent: ThreadMessage;
      replies: ThreadMessage[];
    };

export function messagesAfterClearMarker(
  messages: Message[],
  markerId: string | null | undefined,
): Message[] {
  if (!markerId) return messages;
  const markerIndex = messages.findIndex((m) => m.id === markerId);
  if (markerIndex === -1) return [];
  return messages.slice(markerIndex + 1);
}

/**
 * MessageFeed — the channel's live message stream.
 *
 * The channel is resolved here and NOWHERE ELSE in this subtree, because the
 * resolution used to be `channel ?? routeChannel ?? "general"` and that is two
 * bugs in one expression:
 *
 *   - `??` is NULLISH, so an empty STRING passed straight through and was
 *     queried as a channel slug.
 *   - the `"general"` tail invented a conversation home for a task that has
 *     none, pointing the feed at the room the one-room removal retires.
 *
 * Now: a real emptiness check, and no fallback. With no channel there is no
 * conversation to show, so the feed says so rather than showing someone
 * else's. Resolution happens in this outer component, which calls exactly one
 * hook before branching, so the inner feed below is only ever mounted with a
 * genuinely non-empty channel and never fires a query for one.
 */
export function MessageFeed({
  channel,
  readOnly,
}: {
  channel?: string;
  readOnly?: boolean;
} = {}) {
  // Prefer an explicit channel (the task-detail chat passes the task's channel,
  // where useChannelSlug() is null). Fall back to the channel route slug.
  const routeChannel = useChannelSlug();
  const currentChannel = channel?.trim() || routeChannel?.trim() || "";

  if (!currentChannel) {
    return (
      <div className="messages" data-testid="messages-no-channel">
        <div className="channel-empty-state">
          <span className="title">No conversation here yet</span>
          <span className="body">
            This task has no conversation home. Assign an owner and the
            conversation starts in their DM.
          </span>
        </div>
      </div>
    );
  }

  return (
    <ChannelMessageFeed channel={currentChannel} readOnly={readOnly ?? false} />
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cognitive complexity is baselined for a focused follow-up refactor.
function ChannelMessageFeed({
  channel,
  readOnly,
}: {
  channel: string;
  /** Viewing a conversation you are not in (a consult opened from a relay
   *  marker). Suppresses reactions — a reaction is a mark left ON someone
   *  else's conversation, so it is participation even though it is not
   *  speech. Reading and navigating stay available. */
  readOnly: boolean;
}) {
  // Non-empty by construction — MessageFeed above is the only caller and
  // guards it, so nothing here has to re-check.
  const currentChannel = channel;
  const clearMarkerId = useAppStore(
    (s) => s.clearedMessageIdsByChannel[currentChannel] ?? null,
  );
  const setActiveThread = useAppStore((s) => s.setActiveThread);
  const collapsedThreads = useAppStore((s) => s.collapsedThreads);
  const toggleThreadCollapsed = useAppStore((s) => s.toggleThreadCollapsed);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);

  const copyMessageLink = (id: string) => {
    const url = new URL(window.location.href);
    url.hash = `#msg-${id}`;
    navigator.clipboard?.writeText(url.toString()).catch(() => {});
  };

  const { data: rawMessages = [], isLoading } = useMessages(currentChannel);
  const messages = useMemo(() => {
    const visible = messagesAfterClearMarker(rawMessages, clearMarkerId);
    if (!readOnly) return visible;
    // Read-only: drop reactions from the DATA rather than hiding the pills
    // with CSS. The pill IS the toggle — there is no separate add-reaction
    // control — so a `display: none` would leave a keyboard-reachable button
    // that posts a reaction into a conversation the viewer is only permitted
    // to read. Removing the data removes the control with it.
    return visible.map((m) =>
      m.reactions ? { ...m, reactions: undefined } : m,
    );
  }, [rawMessages, clearMarkerId, readOnly]);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (messages.length > prevLengthRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  if (isLoading && messages.length === 0) {
    return (
      <div className="messages messages-loading">
        <ThinkingLoader
          variant="block"
          label="Loading messages…"
          phrases={OFFICE_LOADING_PHRASES}
        />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="messages">
        <div className="channel-empty-state">
          <span className="eyebrow">quiet before the standup</span>
          <span className="title">#{currentChannel} is empty. For now.</span>
          <span className="body">
            This is where your agents will argue, claim tasks, and show
            progress. They notice things you did not ask them to notice.
          </span>
          <div className="channel-empty-hints">
            <div>
              Try <code>@ceo what should we build this week?</code>
            </div>
            <div>
              Type <code>/</code> for commands, <code>@</code> to mention a bot.
            </div>
          </div>
          <span className="channel-empty-foot">
            Michael would be proud. Probably.
          </span>
        </div>
        <TypingIndicator channel={currentChannel} />
      </div>
    );
  }

  // Build thread-aware element list. Top-level channel messages become thread
  // heads; direct replies become their children; deep-thread replies stay in
  // the side panel. Grouping by sender + 5-min window applies both to parents
  // and to consecutive replies within the same thread so long exchanges read
  // as one continuous block.
  const elements: FeedElement[] = [];
  const byId = new Map<string, Message>();
  for (const m of messages) byId.set(m.id, m);

  const repliesByParent = new Map<string, Message[]>();
  for (const msg of messages) {
    if (msg.content?.startsWith("[STATUS]")) continue;
    if (!msg.reply_to) continue;
    const parent = byId.get(msg.reply_to);
    if (!parent) continue;
    if (parent.reply_to) continue; // deep thread lives in the side panel
    const list = repliesByParent.get(parent.id) ?? [];
    list.push(msg);
    repliesByParent.set(parent.id, list);
  }

  let lastDate = "";
  let lastFrom = "";
  let lastTime = "";

  const wrap = (msg: Message): ThreadMessage => {
    let grouped = false;
    if (lastFrom === msg.from && msg.timestamp && lastTime) {
      const delta =
        new Date(msg.timestamp).getTime() - new Date(lastTime).getTime();
      if (delta >= 0 && delta < 5 * 60 * 1000) grouped = true;
    }
    lastFrom = msg.from;
    lastTime = msg.timestamp || lastTime;
    return { message: msg, grouped };
  };

  const maybeEmitDateSeparator = (msg: Message) => {
    if (!msg.timestamp) return;
    const dayKey = dateDayKey(msg.timestamp);
    if (dayKey === lastDate) return;
    elements.push({
      type: "date",
      key: `date-${dayKey}`,
      label: formatDateLabel(msg.timestamp),
    });
    lastDate = dayKey;
    lastFrom = "";
    lastTime = "";
  };

  for (const msg of messages) {
    if (msg.content?.startsWith("[STATUS]")) continue;
    if (msg.reply_to) continue; // only top-level messages seed threads

    maybeEmitDateSeparator(msg);
    const parent = wrap(msg);

    const rawReplies = repliesByParent.get(msg.id) ?? [];
    const replies: ThreadMessage[] = [];
    for (const r of rawReplies) {
      maybeEmitDateSeparator(r);
      replies.push(wrap(r));
    }

    elements.push({
      type: "thread",
      key: `thread-${msg.id}`,
      parent,
      replies,
    });
  }

  return (
    <div className="messages" ref={containerRef}>
      {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cognitive complexity is baselined for a focused follow-up refactor. */}
      {elements.map((el) => {
        if (el.type === "date") {
          return (
            <div key={el.key} className="date-separator">
              <div className="date-separator-line" />
              <span className="date-separator-text">{el.label}</span>
              <div className="date-separator-line" />
            </div>
          );
        }
        const hasReplies = el.replies.length > 0;
        const parentId = el.parent.message.id;
        const isCollapsed = hasReplies && (collapsedThreads[parentId] ?? false);
        return (
          <div
            key={el.key}
            className={`thread-group${hasReplies ? " thread-group-has-replies" : ""}${isCollapsed ? " thread-group-collapsed" : ""}`}
          >
            <MessageBubble
              message={el.parent.message}
              grouped={el.parent.grouped}
              replyCount={el.replies.length}
              onOpenThread={(id) =>
                setActiveThread({ id, channelSlug: currentChannel })
              }
              onCopyLink={copyMessageLink}
              channel={currentChannel}
            />
            {hasReplies && (
              <button
                type="button"
                className="thread-collapse-toggle"
                onClick={() => toggleThreadCollapsed(parentId)}
                aria-expanded={!isCollapsed}
                aria-controls={`thread-${parentId}-replies`}
              >
                <svg
                  aria-hidden="true"
                  focusable="false"
                  className="thread-collapse-chevron"
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={isCollapsed ? "m9 18 6-6-6-6" : "m6 9 6 6 6-6"} />
                </svg>
                {isCollapsed
                  ? `Show ${el.replies.length} ${el.replies.length === 1 ? "reply" : "replies"}`
                  : "Hide thread"}
              </button>
            )}
            {hasReplies && !isCollapsed && (
              <div className="thread-replies" id={`thread-${parentId}-replies`}>
                {el.replies.map((r) => (
                  <MessageBubble
                    key={r.message.id}
                    message={r.message}
                    grouped={r.grouped}
                    isReply={true}
                    onOpenThread={(id) =>
                      setActiveThread({ id, channelSlug: currentChannel })
                    }
                    onCopyLink={copyMessageLink}
                    channel={currentChannel}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      <TypingIndicator channel={currentChannel} />
    </div>
  );
}
