/**
 * TeachWorkflowModal — show one bot a workflow on a screenshare, once.
 *
 * The honest loop, end to end, with no simulated middle:
 *
 *   1. The operator names the job in their own words (required).
 *   2. "Start screenshare" opens the broker's /observe/browser SSE, which runs
 *      runner/cua_observe.py. cua-driver reads the REAL frontmost window's
 *      accessibility tree and visible text on a poll. Nothing rendered here was
 *      not actually reported by the observer.
 *   3. "Stop" ends the capture and shows exactly what was read, so the operator
 *      sees the payload before it is sent anywhere.
 *   4. "Send to @bot" formats it (teachWorkflowSeed) and posts it into the
 *      bot's own DM channel — the same channel the Chat tab writes to, so the
 *      bot is woken and answers there. This component never plans, drafts, or
 *      summarizes the workflow itself.
 *
 * The capture is app-agnostic at the broker (POST /observe/browser takes no
 * app or bot), so pointing it at a bot needed no server change: the only
 * bot-scoped part is where the result is delivered.
 *
 * Capture lifetime is bounded by this modal. Closing it, pressing Escape, or
 * unmounting aborts the SSE, so screen reading can never outlive the visible
 * "reading your screen" banner. Nothing starts without an explicit click.
 *
 * When the host has no observer the broker answers 503 and this modal SAYS SO
 * and points at the chat, which does work. It never falls back to a fake
 * recording, a placeholder frame, or invented steps.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Send } from "iconoir-react";

import { postMessage } from "../../api/client";
import { describeCapture } from "../../appdetail/apps/demoSeed";
import {
  OBSERVE_UNAVAILABLE,
  type ObservedScreen,
  type ObserveSnapshot,
  reduceObserved,
  runObserve,
} from "../../appdetail/apps/observeClient";
import { useWindowEscape } from "../../hooks/useWindowEscape";
import { directChannelSlug } from "../../lib/channels";
import { buildBotWorkflowSeed } from "./teachWorkflowSeed";

type Phase =
  | "idle"
  | "recording"
  | "review"
  | "sending"
  | "sent"
  | "unavailable"
  | "error";

/** Which half broke, so the error copy states the real outcome rather than a
 *  generic one. A failed send still has a capture; a failed capture does not. */
type Failure = { stage: "capture" | "send"; detail: string | null };

interface TeachWorkflowModalProps {
  agentSlug: string;
  /** Display name for the copy. Falls back to the slug when absent. */
  agentName?: string;
  open: boolean;
  onClose: () => void;
  /** Called after the workflow lands, so the caller can show the chat. */
  onSent?: () => void;
}

/** An aborted capture is the operator pressing Stop, not a failure. */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

const DIALOG_PROPS = {
  role: "dialog",
  "aria-modal": true,
  "aria-labelledby": "teach-workflow-title",
} as const;

export function TeachWorkflowModal({
  agentSlug,
  agentName,
  open,
  onClose,
  onSent,
}: TeachWorkflowModalProps) {
  const who = agentName?.trim() || agentSlug;
  const [phase, setPhase] = useState<Phase>("idle");
  const [goal, setGoal] = useState("");
  const [screens, setScreens] = useState<ObservedScreen[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Snapshots accumulate in a ref: the observer polls on an interval and a
  // state append per tick would re-render the whole list on every poll.
  const snapshotsRef = useRef<ObserveSnapshot[]>([]);

  // A capture must never outlive the modal. An orphaned SSE would keep the
  // runner reading the operator's screen after they closed this.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);
  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const close = useCallback(() => {
    stop();
    onClose();
  }, [onClose, stop]);

  useWindowEscape(open, close);

  async function start() {
    const controller = new AbortController();
    abortRef.current = controller;
    snapshotsRef.current = [];
    setScreens([]);
    setFailure(null);
    setPhase("recording");
    try {
      await runObserve({
        signal: controller.signal,
        onSnapshot: (snapshot) => {
          snapshotsRef.current = [...snapshotsRef.current, snapshot];
          setScreens(reduceObserved(snapshotsRef.current));
        },
      });
      setPhase("review");
    } catch (err) {
      if (isAbortError(err)) {
        // Operator pressed Stop (or closed this): keep whatever was read.
        setPhase("review");
        return;
      }
      if (err instanceof Error && err.message === OBSERVE_UNAVAILABLE) {
        setPhase("unavailable");
        return;
      }
      setFailure({
        stage: "capture",
        detail: err instanceof Error ? err.message : String(err),
      });
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }

  async function send() {
    setPhase("sending");
    setFailure(null);
    try {
      await postMessage(
        buildBotWorkflowSeed({ agentSlug, goal, screens }),
        directChannelSlug(agentSlug),
      );
      setPhase("sent");
    } catch (err) {
      setFailure({
        stage: "send",
        detail: err instanceof Error ? err.message : String(err),
      });
      setPhase("error");
    }
  }

  if (!open) return null;

  return (
    <div className="teach-workflow-overlay" role="presentation">
      <div className="teach-workflow-modal card" {...DIALOG_PROPS}>
        <div className="teach-workflow-head">
          <h2 className="teach-workflow-title" id="teach-workflow-title">
            Teach {who} a workflow
          </h2>
          <button
            type="button"
            className="teach-workflow-close"
            onClick={close}
            aria-label="Close teach a workflow"
          >
            Close
          </button>
        </div>

        {phase === "unavailable" ? (
          <NoObserver who={who} onOpenChat={close} />
        ) : phase === "error" && failure ? (
          <TeachError
            failure={failure}
            onRetry={() => {
              setFailure(null);
              // A failed send keeps the capture, so the operator lands back on
              // the review step and can retry without re-recording.
              setPhase(failure.stage === "send" ? "review" : "idle");
            }}
          />
        ) : phase === "sent" ? (
          <Sent
            who={who}
            captured={screens.length > 0}
            onDone={() => {
              onSent?.();
              close();
            }}
          />
        ) : (
          <CaptureFlow
            who={who}
            phase={phase}
            goal={goal}
            screens={screens}
            onGoalChange={setGoal}
            onStart={() => void start()}
            onStop={stop}
            onSend={() => void send()}
            onRecordAgain={() => {
              setScreens([]);
              setPhase("idle");
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The capture surface itself: name the job, share the screen, then review what
 * was read. Split out so the parent holds only the capture lifecycle (SSE,
 * abort, phase) and this holds only its rendering.
 */
function CaptureFlow({
  who,
  phase,
  goal,
  screens,
  onGoalChange,
  onStart,
  onStop,
  onSend,
  onRecordAgain,
}: {
  who: string;
  phase: Phase;
  goal: string;
  screens: ObservedScreen[];
  onGoalChange: (goal: string) => void;
  onStart: () => void;
  onStop: () => void;
  onSend: () => void;
  onRecordAgain: () => void;
}) {
  return (
    <>
      <p className="teach-workflow-intro">
        Share your screen and do the job the way you normally do it. {who} reads
        the windows you are actually on, and you see everything that was read
        before any of it is sent. Show it once. It will do it from now on.
      </p>

      <label className="teach-workflow-field" htmlFor="teach-workflow-goal">
        <span className="teach-workflow-label">
          What are you about to show {who}?
        </span>
        <input
          id="teach-workflow-goal"
          className="input"
          placeholder="File the weekly expense report"
          value={goal}
          disabled={phase !== "idle"}
          onChange={(e) => onGoalChange(e.target.value)}
        />
      </label>

      {phase === "idle" ? (
        <div className="teach-workflow-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!goal.trim()}
            onClick={onStart}
          >
            <Eye width={14} height={14} aria-hidden="true" />
            Start screenshare
          </button>
        </div>
      ) : null}

      {phase === "recording" ? (
        <div className="teach-workflow-live">
          <div className="teach-workflow-live-head" aria-live="polite">
            <span className="teach-workflow-rec" aria-hidden="true" />
            Reading your screen ·{" "}
            {screens.length === 0
              ? "nothing read yet"
              : describeCapture(screens)}
          </div>
          <p className="teach-workflow-note">
            Go do the job now, in the apps you normally use. Come back and press
            Stop when you are done. Closing this window also stops the reading.
          </p>
          <div className="teach-workflow-actions">
            <button type="button" className="btn btn-primary" onClick={onStop}>
              Stop screenshare
            </button>
          </div>
        </div>
      ) : null}

      <CapturedScreens screens={screens} />

      {phase === "review" || phase === "sending" ? (
        <div className="teach-workflow-review">
          <p className="teach-workflow-note">
            {screens.length === 0
              ? "Nothing was read. No screens came back from the observer, so there is nothing to show " +
                who +
                ". Record again, or send just your description."
              : "This is everything that was read. Nothing else goes with it."}
          </p>
          <div className="teach-workflow-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!goal.trim() || phase === "sending"}
              onClick={onSend}
            >
              <Send width={14} height={14} aria-hidden="true" />
              {phase === "sending" ? "Sending…" : `Send to ${who}`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={phase === "sending"}
              onClick={onRecordAgain}
            >
              Record again
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The screens the observer actually read, in the order they were used. */
function CapturedScreens({ screens }: { screens: ObservedScreen[] }) {
  if (screens.length === 0) return null;
  return (
    <ol className="teach-workflow-screens">
      {screens.map((screen, i) => (
        <li
          // The observer keys a screen by app+title; that pair is the identity
          // reduceObserved already deduplicated on.
          key={`${screen.app}|${screen.title}`}
          className="teach-workflow-screen"
        >
          <div className="teach-workflow-screen-head">
            <span className="teach-workflow-screen-n">{i + 1}</span>
            <span className="teach-workflow-screen-app">{screen.app}</span>
            <span className="teach-workflow-screen-title">{screen.title}</span>
          </div>
          {screen.components.length > 0 ? (
            <p className="teach-workflow-screen-els">
              {screen.components.map((c) => `${c.role}:${c.label}`).join(" · ")}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The workflow reached the bot. Say only that, and say what is still open:
 * whether the bot can run every step is the bot's answer to give, not this
 * modal's to claim.
 */
function Sent({
  who,
  captured,
  onDone,
}: {
  who: string;
  captured: boolean;
  onDone: () => void;
}) {
  return (
    <div className="teach-workflow-result">
      <div className="teach-workflow-result-title">Sent to {who}</div>
      <p className="teach-workflow-note">
        {captured
          ? `The screens that were read are now in your chat with ${who}.`
          : `Your description is now in your chat with ${who}. No screens were read, so that is all it has to go on.`}{" "}
        It will reply there with the steps it would take, and with the steps it
        cannot run yet.
      </p>
      <div className="teach-workflow-actions">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Open the chat
        </button>
      </div>
    </div>
  );
}

/** No cua observer on this host. Say it plainly, point at what does work. */
function NoObserver({
  who,
  onOpenChat,
}: {
  who: string;
  onOpenChat: () => void;
}) {
  return (
    <div className="teach-workflow-result">
      <div className="teach-workflow-result-title">
        This computer cannot read your screen
      </div>
      <p className="teach-workflow-note">
        Screen reading needs the cua runner, and it is not installed here, so
        there is nothing to record with and nothing was captured. You can still
        teach {who} the same job by describing it in the chat. That path works.
      </p>
      <div className="teach-workflow-actions">
        <button type="button" className="btn btn-primary" onClick={onOpenChat}>
          Describe it in chat
        </button>
      </div>
    </div>
  );
}

/** Something failed that is not "no observer": the capture, or the send. */
function TeachError({
  failure,
  onRetry,
}: {
  failure: Failure;
  onRetry: () => void;
}) {
  const sendFailed = failure.stage === "send";
  return (
    <div className="teach-workflow-result" role="alert">
      <div className="teach-workflow-result-title">
        {sendFailed ? "This did not reach the bot" : "The reading stopped"}
      </div>
      <p className="teach-workflow-note">
        {sendFailed
          ? "The screens that were read are still here, but the message did not send, so the bot has not seen any of it."
          : "Nothing was captured and nothing was sent."}
        {failure.detail ? ` (${failure.detail})` : ""}
      </p>
      <div className="teach-workflow-actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          {sendFailed ? "Back to what was read" : "Start over"}
        </button>
      </div>
    </div>
  );
}
