// AppDemoTab — teach a tool by DEMONSTRATING it instead of describing it.
//
// NOT MOUNTED. Apps no longer author tools, so this is unwired from the app
// tab bar and its hand-off target (AppToolsChat) is gone. The file is kept
// deliberately: the screenshare teaching flow is moving to the BOT surface
// and this is its reference implementation, alongside apps/observeClient.ts
// and apps/demoSeed.ts, which that flow imports directly.
//
// The honest loop, end to end, with no simulated middle:
//
//   1. The operator says what they are about to do (their words, required).
//   2. "Start recording" opens the broker's /observe/browser SSE, which runs
//      runner/cua_observe.py. cua-driver reads the REAL frontmost window's
//      accessibility tree + visible text on a poll. Nothing is rendered here
//      that the observer did not actually report.
//   3. "Stop" ends the capture and shows exactly what was read, so the
//      operator sees the payload before it is sent anywhere.
//   4. "Hand this to the chat" formats it (demoSeed) and seeds the LIVE
//      authoring chat — AppToolsChat → POST /bot/tools/build. The
//      understanding step is the real model on that endpoint; this tab never
//      plans or drafts a tool locally.
//
// When the host has no observer the broker answers 503 and this tab SAYS SO
// and points at the chat-based teach path that does work. It never falls back
// to a fake recording or invented steps. See docs/specs/operator-cua-migration.md §7.

import { useEffect, useRef, useState } from "react";
import { Circle, MonitorPlay, Send, Sparkles, Square } from "lucide-react";

import "../../styles/app-demo-tab.css";

import { buildTeachSeed, describeCapture } from "../apps/demoSeed";
import {
  OBSERVE_UNAVAILABLE,
  type ObservedScreen,
  type ObserveSnapshot,
  reduceObserved,
  runObserve,
} from "../apps/observeClient";
import { Eyebrow } from "../components/primitives";

type Phase = "idle" | "recording" | "review" | "unavailable" | "error";

interface AppDemoTabProps {
  appName: string;
  /** Hand the formatted capture to the live authoring chat. */
  onHandoff?: (seed: string) => void;
  /** Open the bot's chat directly — the fallback when there is no observer. */
  onTeach?: () => void;
}

/** An aborted capture is the operator pressing Stop, not a failure. */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function AppDemoTab({ appName, onHandoff, onTeach }: AppDemoTabProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [goal, setGoal] = useState("");
  const [screens, setScreens] = useState<ObservedScreen[]>([]);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Snapshots accumulate in a ref: the observer polls on an interval and a
  // state-append per tick would re-render the whole list for every poll.
  const snapshotsRef = useRef<ObserveSnapshot[]>([]);

  // A capture must never outlive the tab — an orphaned SSE would keep the
  // runner polling the operator's screen after they navigated away.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  async function start() {
    const controller = new AbortController();
    abortRef.current = controller;
    snapshotsRef.current = [];
    setScreens([]);
    setErrorDetail(null);
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
        // Operator pressed Stop (or left the tab): keep whatever was read.
        setPhase("review");
        return;
      }
      if (err instanceof Error && err.message === OBSERVE_UNAVAILABLE) {
        setPhase("unavailable");
        return;
      }
      setErrorDetail(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }

  function handoff() {
    onHandoff?.(buildTeachSeed(goal, screens));
  }

  return (
    <div className="opr-tool-scoped opr-app-demo">
      <div className="opr-data-intro">
        <Eyebrow>Teach by demonstrating</Eyebrow>
        <p className="opr-scoped-note">
          Show {appName} the job instead of describing it. While you work,
          gawkbot reads the screens you are actually on — the app, the window,
          and the elements on it — then hands that to the chat, which writes the
          tool.
        </p>
      </div>

      {phase === "unavailable" ? (
        <NoObserver appName={appName} onTeach={onTeach} />
      ) : phase === "error" ? (
        <CaptureError detail={errorDetail} onRetry={() => setPhase("idle")} />
      ) : (
        <CaptureFlow
          phase={phase}
          goal={goal}
          screens={screens}
          onGoalChange={setGoal}
          onStart={() => void start()}
          onStop={stop}
          onHandoff={handoff}
          onRecordAgain={() => {
            setScreens([]);
            setPhase("idle");
          }}
        />
      )}
    </div>
  );
}

/**
 * The capture surface itself: state the goal, record, then review what was
 * read. Split out of AppDemoTab so the parent holds only the capture
 * lifecycle (SSE, abort, phase) and this holds only its rendering.
 */
function CaptureFlow({
  phase,
  goal,
  screens,
  onGoalChange,
  onStart,
  onStop,
  onHandoff,
  onRecordAgain,
}: {
  phase: Phase;
  goal: string;
  screens: ObservedScreen[];
  onGoalChange: (goal: string) => void;
  onStart: () => void;
  onStop: () => void;
  onHandoff: () => void;
  onRecordAgain: () => void;
}) {
  return (
    <>
      <label className="opr-demo-goal" htmlFor="opr-demo-goal-input">
        <span className="opr-demo-goal-label">
          What are you about to demonstrate?
        </span>
        <input
          id="opr-demo-goal-input"
          className="opr-composer-input"
          placeholder="Route a new demo request to the right AE"
          value={goal}
          disabled={phase === "recording"}
          onChange={(e) => onGoalChange(e.target.value)}
        />
      </label>

      {phase === "idle" ? (
        <div className="opr-detail-actions">
          <button
            type="button"
            className="opr-btn opr-btn-primary opr-btn-sm"
            disabled={!goal.trim()}
            onClick={onStart}
          >
            <MonitorPlay size={13} strokeWidth={1.9} aria-hidden={true} />
            Start recording
          </button>
        </div>
      ) : null}

      {phase === "recording" ? (
        <div className="opr-demo-live">
          <div className="opr-demo-live-head" aria-live="polite">
            <span className="opr-demo-rec" aria-hidden={true}>
              <Circle size={9} strokeWidth={3} />
            </span>
            Reading your screen ·{" "}
            {screens.length === 0
              ? "nothing read yet"
              : describeCapture(screens)}
          </div>
          <p className="opr-scoped-note">
            Go do the job now, in the apps you normally use. Come back and press
            Stop when you are done.
          </p>
          <div className="opr-detail-actions">
            <button
              type="button"
              className="opr-btn opr-btn-sm"
              onClick={onStop}
            >
              <Square size={12} strokeWidth={2.2} aria-hidden={true} />
              Stop
            </button>
          </div>
        </div>
      ) : null}

      <CapturedScreens screens={screens} />

      {phase === "review" ? (
        <div className="opr-demo-review">
          <p className="opr-scoped-note">
            {screens.length === 0
              ? "Nothing was captured — the observer did not read any screens. You can record again, or send just your description to the chat."
              : "This is everything that was read. Sending it starts the chat writing the tool."}
          </p>
          <div className="opr-detail-actions">
            <button
              type="button"
              className="opr-btn opr-btn-primary opr-btn-sm"
              disabled={!goal.trim()}
              onClick={onHandoff}
            >
              <Send size={13} strokeWidth={1.9} aria-hidden={true} />
              Hand this to the chat
            </button>
            <button
              type="button"
              className="opr-btn opr-btn-sm"
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

/** The screens the observer actually read, newest capture last. */
function CapturedScreens({ screens }: { screens: ObservedScreen[] }) {
  if (screens.length === 0) return null;
  return (
    <ol className="opr-demo-screens">
      {screens.map((screen, i) => (
        <li
          // The observer keys a screen by app+title; that pair is the identity
          // reduceObserved already deduplicated on.
          key={`${screen.app}|${screen.title}`}
          className="opr-tool-card opr-demo-screen"
        >
          <div className="opr-demo-screen-head">
            <span className="opr-demo-screen-n">{i + 1}</span>
            <span className="opr-demo-screen-app">{screen.app}</span>
            <span className="opr-demo-screen-title">{screen.title}</span>
          </div>
          {screen.components.length > 0 ? (
            <p className="opr-demo-screen-els">
              {screen.components.map((c) => `${c.role}:${c.label}`).join(" · ")}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** No cua observer on this host. Say it plainly, point at what does work. */
function NoObserver({
  appName,
  onTeach,
}: {
  appName: string;
  onTeach?: () => void;
}) {
  return (
    <div className="opr-empty">
      <span className="opr-empty-glyph" aria-hidden={true}>
        <MonitorPlay size={16} strokeWidth={1.9} />
      </span>
      <div className="opr-empty-title">
        This computer cannot watch your screen
      </div>
      <div className="opr-empty-hint">
        Screen reading needs the cua runner, and it is not available here, so
        there is nothing to record with. You can still teach {appName} the same
        job by describing it in the chat — that path is fully working.
      </div>
      {onTeach ? (
        <div className="opr-empty-actions">
          <button
            type="button"
            className="opr-btn opr-btn-primary opr-btn-sm"
            onClick={onTeach}
          >
            <Sparkles size={13} strokeWidth={1.9} aria-hidden={true} />
            Teach a tool in chat
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The capture failed for a reason that is not "no observer". */
function CaptureError({
  detail,
  onRetry,
}: {
  detail: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="opr-empty">
      <span className="opr-empty-glyph" aria-hidden={true}>
        <MonitorPlay size={16} strokeWidth={1.9} />
      </span>
      <div className="opr-empty-title">The recording stopped</div>
      <div className="opr-empty-hint">
        Nothing was captured and nothing was sent.
        {detail ? ` (${detail})` : ""}
      </div>
      <div className="opr-empty-actions">
        <button
          type="button"
          className="opr-btn opr-btn-primary opr-btn-sm"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
