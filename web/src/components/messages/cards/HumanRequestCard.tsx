/**
 * HumanRequestCard — the in-thread surface for a bot's blocking ask.
 *
 * The broker raises a human-decision request and announces it in the channel
 * as a system message (Kind="human_request_raised",
 * postRequestRaisedChatMessageLocked in internal/team). That announcement used
 * to render as a bare sentence:
 *
 *   Office 23:58
 *   ❓ @ceo asks you (blocking) (request request-3): Add Prospector to the
 *   team? Answer it in the Inbox, or reply in this thread.
 *
 * Three things were wrong with that, and this card fixes all three:
 *
 *  1. It was TEXT where the human needed CONTROLS. The request already carries
 *     its own options — "Add them", "Not now" — and the human had to read a
 *     sentence and go find them somewhere else. Here the options are buttons.
 *
 *  2. It was attributed to "Office", a speaker that does not exist. The wire
 *     message really is sent by "system" (deliberately — notifyBotsLoop
 *     skips system senders, so attributing it to the asking bot would make the
 *     announcement wake other bots). The card reads the real asker out of the
 *     payload and renders THAT, so the byline is "@ceo asks you".
 *
 *  3. It pointed at "the Inbox", a destination the nav no longer has — the
 *     standalone Inbox was consolidated into Tasks.
 *
 * The card joins against the LIVE request by id rather than trusting the
 * payload's snapshot, so options and answered-state are always current: an ask
 * answered from the Tasks board or the docked InterviewBar settles here too,
 * and scrollback shows the resolved outcome instead of dead buttons.
 *
 * Security: payload fields are plain text, rendered as text, never as HTML.
 * The broker-side sanitizer is authoritative (PR #684); this is
 * defense-in-depth.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  answerRequest,
  type BotRequest,
  type InterviewOption,
} from "../../../api/client";
import { useRequests } from "../../../hooks/useRequests";
import {
  requestOptionNeedsText,
  requestOptionTextHint,
} from "../../../lib/requestOptions";
import { showNotice } from "../../ui/Toast";

export interface HumanRequestRaisedPayload {
  request_id?: string;
  from?: string;
  question?: string;
  title?: string;
  label?: string;
  blocking?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseHumanRequestRaisedPayload(
  raw: unknown,
): HumanRequestRaisedPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: HumanRequestRaisedPayload = {};
  if (isNonEmptyString(r.request_id)) out.request_id = r.request_id;
  if (isNonEmptyString(r.from)) out.from = r.from;
  if (isNonEmptyString(r.question)) out.question = r.question;
  if (isNonEmptyString(r.title)) out.title = r.title;
  if (isNonEmptyString(r.label)) out.label = r.label;
  if (typeof r.blocking === "boolean") out.blocking = r.blocking;
  return out;
}

/** Strip the markdown emphasis and leading list numbering bots tend to emit,
 *  matching how InterviewBar presents the same question text. */
function cleanQuestion(text: string): string {
  return text.replace(/\*\*/g, "").replace(/^\s*\d+\.\s*/, "");
}

/** Free-text answer box, shown once the human picks an option that demands
 *  one. Focus follows the choice they just made. */
function RequestTextAnswer({
  request,
  option,
  submitting,
  onCancel,
  onSubmit,
}: {
  request: BotRequest;
  option: InterviewOption;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  // The human just clicked the option that opens this box, so the caret
  // belongs here. Done with a ref rather than autoFocus so the focus move is
  // scoped to this deliberate interaction, not to mount.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="request-card-text">
      <textarea
        ref={ref}
        className="request-card-textarea"
        placeholder={requestOptionTextHint(request, option)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (text.trim()) onSubmit(text.trim());
          }
        }}
        rows={3}
      />
      <div className="request-card-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onSubmit(text.trim())}
          disabled={submitting || !text.trim()}
        >
          {submitting ? "Sending…" : `Send as ${option.label}`}
        </button>
      </div>
    </div>
  );
}

/** The decision row: the request's own options as buttons. */
function RequestOptions({
  request,
  options,
  submitting,
  onPick,
}: {
  request: BotRequest;
  options: InterviewOption[];
  submitting: boolean;
  onPick: (option: InterviewOption) => void;
}) {
  return (
    <div className="request-card-actions">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`btn btn-sm ${option.id === request.recommended_id ? "btn-primary" : "btn-ghost"}`}
          onClick={() => onPick(option)}
          disabled={submitting}
          title={option.description}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface HumanRequestCardProps {
  payload: HumanRequestRaisedPayload;
  /** Prose fallback from the message body, shown when the payload carries no
   *  question (a message written before the payload existed). */
  fallbackText?: string;
}

export function HumanRequestCard({
  payload,
  fallbackText,
}: HumanRequestCardProps) {
  const queryClient = useQueryClient();
  const { all } = useRequests();
  const [submitting, setSubmitting] = useState(false);
  const [textOption, setTextOption] = useState<InterviewOption | null>(null);

  const requestId = payload.request_id ?? "";
  // Join against the live request. Absent means it was answered and reaped, or
  // this is an old message whose request is long gone — either way there is
  // nothing left to decide, so the card settles.
  const live = requestId ? all.find((r) => r.id === requestId) : undefined;

  const asker = payload.from ?? live?.from ?? "";
  const question = cleanQuestion(
    payload.question || live?.question || fallbackText || "",
  );
  const title = payload.title || live?.title || "";
  const blocking =
    payload.blocking ?? Boolean(live?.blocking || live?.required);

  const status = (live?.status ?? "").toLowerCase();
  const isPending =
    Boolean(live) &&
    (status === "" || status === "open" || status === "pending");
  const options: InterviewOption[] = live?.options ?? live?.choices ?? [];

  async function submit(option: InterviewOption, text?: string) {
    if (submitting || !requestId) return;
    setSubmitting(true);
    try {
      await answerRequest(requestId, option.id, text);
      await queryClient.invalidateQueries({ queryKey: ["requests"] });
      await queryClient.invalidateQueries({ queryKey: ["requests-badge"] });
      await queryClient.invalidateQueries({ queryKey: ["office-stats"] });
      setTextOption(null);
    } catch (err: unknown) {
      showNotice(
        err instanceof Error ? err.message : "Failed to answer",
        "error",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleOption(option: InterviewOption) {
    if (live && requestOptionNeedsText(live, option)) {
      setTextOption(option);
      return;
    }
    void submit(option);
  }

  const heading =
    payload.label === "interview" ? "asks you" : "needs a decision";

  function renderBody() {
    if (!(isPending && live)) {
      return (
        <div className="request-card-help" data-testid="human-request-settled">
          {live ? "Answered." : "No longer waiting on you."}
        </div>
      );
    }
    if (textOption) {
      return (
        <RequestTextAnswer
          request={live}
          option={textOption}
          submitting={submitting}
          onCancel={() => setTextOption(null)}
          onSubmit={(text) => void submit(textOption, text)}
        />
      );
    }
    if (options.length > 0) {
      return (
        <RequestOptions
          request={live}
          options={options}
          submitting={submitting}
          onPick={handleOption}
        />
      );
    }
    // Pending but optionless — a free-text ask. The thread reply IS the answer
    // path (the broker anchored this message as req.ReplyTo), so say that
    // rather than rendering an empty action row.
    return (
      <div className="request-card-help">Reply in this thread to answer.</div>
    );
  }

  return (
    <div
      className={`request-card${blocking && isPending ? " request-card--blocking" : ""}`}
      data-testid="human-request-card"
      data-request-id={requestId}
      data-pending={isPending ? "true" : "false"}
    >
      <div className="request-card-head">
        <span className="request-card-icon" aria-hidden="true">
          ❓
        </span>
        <span className="request-card-eyebrow">
          {asker ? (
            <span className="request-card-asker">@{asker}</span>
          ) : (
            "A bot"
          )}{" "}
          {heading}
          {blocking && isPending ? (
            <span className="request-card-badge">Blocking</span>
          ) : null}
        </span>
      </div>

      {title && title !== question && title !== "Request" ? (
        <div className="request-card-title">{title}</div>
      ) : null}
      <div className="request-card-question">{question}</div>

      {renderBody()}
    </div>
  );
}
