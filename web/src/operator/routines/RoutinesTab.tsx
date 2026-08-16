// RoutinesTab — the agent's workflows, Claude-Routines style: each routine is a
// PROMPT the agent runs in its own chat on a schedule. No compiled diagram —
// the chat (which knows the agent's tools) is the runtime. Disable and Publish
// new version live on EACH routine, not on the agent.
//
// With a REAL agent id (app_…) a routine IS a broker scheduler job: the broker
// owns the cron, enable/disable, the revision history (Publish new version =
// a revision with a change note), and the per-run history; on each fire it
// runs the prompt in the routine's pi chat session via the agent service.
// "Run now" queues a fire at the broker (the watchdog picks it up within a
// tick). When the broker is unreachable the tab falls back to the local
// seeded state so the FE keeps working offline.
// See docs/specs/operator-agent-routines.md.

import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  MessageSquareText,
  Play,
  Plus,
  Power,
} from "lucide-react";

import {
  tryCreateRoutine,
  tryListRoutineRuns,
  tryListRoutines,
  tryPatchRoutine,
  tryRunRoutineNow,
  type WireRoutine,
  type WireRoutineRun,
} from "../agents/agentStateClient";
import { isRealAppId } from "../apps/useOperatorApps";
import { Eyebrow } from "../components/primitives";
import {
  formatLastRun,
  formatStamp,
  humanSchedule,
  newRoutine,
  type Routine,
  routineSessionKey,
  SCHEDULE_PRESETS,
} from "./routines";

// A run's status maps to a colored dot: succeeded → green, failed → red,
// anything mid-flight or unknown → the muted default.
function runStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "ok" || s === "success" || s === "succeeded" || s === "done") {
    return "is-ok";
  }
  if (s === "failed" || s === "error" || s === "errored") return "is-bad";
  return "is-pending";
}

// The first non-empty line of a run summary — the glanceable outcome.
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

// A live "Run now" watch: which routine queued, the client clock at queue time
// (runs started after it are the queued one), and the phase the header label
// renders. Cleared when the watched run reaches a terminal status.
interface RunWatch {
  id: string;
  queuedAt: number;
  phase: "queued" | "running" | "overtime";
}

// Watch cadence: the broker watchdog fires within one tick (~20s), so a 2s
// poll bounded at 60s sees most runs start and land.
const RUN_WATCH_INTERVAL_MS = 2_000;
const RUN_WATCH_CAP_MS = 60_000;

// Header labels per watch phase. Wayfinding, not decoration: "queued" points
// at where the outcome lands, and past the cap the label degrades honestly
// instead of freezing on "running now…".
const RUN_WATCH_LABELS: Record<RunWatch["phase"], string> = {
  queued: "queued — watch the play-by-play in its chat",
  running: "running now…",
  overtime: "running — open its chat to watch",
};

// The queued run's fate in a run listing: `landed` once a run started after
// queue time reached a terminal status; `running` while one is still pending.
function watchedOutcome(
  runs: WireRoutineRun[],
  queuedAt: number,
): { landed: WireRoutineRun | undefined; running: boolean } {
  const ours = runs.filter((run) => Date.parse(run.started_at) > queuedAt);
  return {
    landed: ours.find((run) => runStatusClass(run.status) !== "is-pending"),
    running: ours.length > 0,
  };
}

interface StartRunWatchOptions {
  id: string;
  queuedAt: number;
  /** Owns the active interval; the watch clears it when it ends. */
  pollRef: { current: ReturnType<typeof setInterval> | null };
  setRunWatch: Dispatch<SetStateAction<RunWatch | null>>;
  setRunsById: Dispatch<
    SetStateAction<Record<string, WireRoutineRun[] | null>>
  >;
  /** Land the run on the routine row (lastRun := the run's started_at). */
  landRun: (id: string, startedAt: string) => void;
}

// Watch a queued run land: poll the run ring, mirror it into the opened Recent
// runs list, flip the header "queued" → "running" once the queued run starts,
// and stop at a terminal status — lastRun then carries the run's real stamp
// through the normal formatLastRun path. Bounded: past the cap a still-running
// run points at the chat instead of pretending, and an unreachable broker
// stops the poll without inventing progress.
function startRunWatch(opts: StartRunWatchOptions): void {
  const { id, queuedAt, pollRef, setRunWatch, setRunsById, landRun } = opts;
  const watchedFrom = Date.now();
  const stop = (handle: ReturnType<typeof setInterval>) => {
    clearInterval(handle);
    if (pollRef.current === handle) pollRef.current = null;
  };
  const timer = setInterval(() => {
    if (Date.now() - watchedFrom >= RUN_WATCH_CAP_MS) {
      stop(timer);
      setRunWatch((prev) =>
        prev && prev.id === id && prev.phase === "running"
          ? { ...prev, phase: "overtime" }
          : prev,
      );
      return;
    }
    void tryListRoutineRuns(id).then((runs) => {
      if (pollRef.current !== timer) return; // superseded or stopped
      if (!runs) {
        // Offline mid-watch: settle the opened list on the honest empty
        // note and give up quietly.
        setRunsById((prev) => ({ ...prev, [id]: null }));
        stop(timer);
        return;
      }
      setRunsById((prev) => ({ ...prev, [id]: runs }));
      const { landed, running } = watchedOutcome(runs, queuedAt);
      if (landed) {
        stop(timer);
        landRun(id, landed.started_at);
        setRunWatch((prev) => (prev && prev.id === id ? null : prev));
        return;
      }
      if (running) {
        setRunWatch((prev) =>
          prev && prev.id === id && prev.phase === "queued"
            ? { ...prev, phase: "running" }
            : prev,
        );
      }
    });
  }, RUN_WATCH_INTERVAL_MS);
  pollRef.current = timer;
}

// The row's status line: an active watch wins; otherwise the honest last-ran
// stamp (or paused).
function headerLabel(r: Routine, runWatch: RunWatch | null): string {
  if (runWatch && runWatch.id === r.id) {
    return RUN_WATCH_LABELS[runWatch.phase];
  }
  if (!r.enabled) return "paused";
  return r.lastRun ? `last ran ${formatLastRun(r.lastRun)}` : "not run yet";
}

interface RoutinesTabProps {
  agentName: string;
  /** Real agent id (app_…). When set, routines live in the broker's scheduler
   * registry; without it (mock agents) the tab keeps its local seeded state. */
  agentId?: string;
  /** Open the routine's chat session in the Ask Agent dock. Live routines pass
   * their scheduler slug (resolved to a session by the dock). */
  onOpenSession?: (sessionKey: string, title: string) => void;
}

// The wire routine carries an extra `agent` field; the FE shape is the rest.
// `draft` is FE-local (an unpublished prompt edit), never on the wire.
function fromWire(w: WireRoutine): Routine {
  return {
    id: w.id,
    name: w.name,
    prompt: w.prompt,
    schedule: w.schedule,
    enabled: w.enabled,
    version: w.version,
    lastRun: w.lastRun,
  };
}

export function RoutinesTab({
  agentName,
  agentId,
  onOpenSession,
}: RoutinesTabProps) {
  // Real agents START EMPTY — no seeded routines (2026-08-15 audit: fabricated
  // "Route new leads · v5 · last ran 12 minutes ago" rows rendered for real
  // agents, forever when the service was unreachable).
  const [routines, setRoutines] = useState<Routine[]>([]);
  // True once the agent service answered a list — from then on writes go to it.
  const [live, setLive] = useState(false);
  // The service could not be reached — say so instead of faking state.
  const [unavailable, setUnavailable] = useState(false);
  // Transient write-failure notice (per action, cleared on the next success).
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState(SCHEDULE_PRESETS[0].expr);
  // Run-now feedback: which routine is mid-queue, plus the watch that follows
  // a successful live queue (see startRunWatch) — one phase state drives the
  // header label and clears when the watched run lands.
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runWatch, setRunWatch] = useState<RunWatch | null>(null);
  // The active watch poll — one at a time; dies on unmount and when a new
  // Run now supersedes it.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Recent-runs disclosure: which routine cards are expanded, and their loaded
  // run history (undefined = not fetched yet, null = fetched but unavailable).
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [runsById, setRunsById] = useState<
    Record<string, WireRoutineRun[] | null>
  >({});

  const realId = isRealAppId(agentId) ? agentId : undefined;

  useEffect(() => {
    if (!realId) return;
    let cancelled = false;
    void tryListRoutines(realId).then((remote) => {
      if (cancelled) return;
      if (!remote) {
        // Unreachable — keep the honest empty state and say why.
        setUnavailable(true);
        return;
      }
      setLive(true);
      setUnavailable(false);
      setRoutines(remote.map(fromWire));
    });
    return () => {
      cancelled = true;
    };
  }, [realId]);

  function patch(id: string, up: (r: Routine) => Routine) {
    setRoutines((prev) => prev.map((r) => (r.id === id ? up(r) : r)));
  }

  function stopWatchPoll() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // The watch poll must not outlive the component.
  useEffect(() => {
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, []);

  // Expand/collapse a routine's run history; load it lazily on first expand
  // (the broker keeps a per-slug run ring). Offline/mock agents just resolve
  // null and the card shows the honest empty note.
  function toggleRuns(r: Routine) {
    const wasOpen = expandedRuns.has(r.id);
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
    if (!(wasOpen || r.id in runsById)) {
      void tryListRoutineRuns(r.id).then((runs) => {
        setRunsById((prev) => ({ ...prev, [r.id]: runs }));
      });
    }
  }

  function toggleEnabled(r: Routine) {
    if (!(live && realId)) {
      patch(r.id, (x) => ({ ...x, enabled: !x.enabled }));
      return;
    }
    // A failed broker write must NOT flip the switch locally — the scheduler
    // state is unchanged, so pretending otherwise is a lie the operator only
    // discovers when the routine fires (or doesn't).
    void tryPatchRoutine(r.id, { agent: realId, enabled: !r.enabled }).then(
      (updated) => {
        if (updated) {
          setNotice(null);
          patch(r.id, () => fromWire(updated));
        } else {
          setNotice(
            `Could not ${r.enabled ? "pause" : "enable"} “${r.name}” — the workspace may be offline. It is still ${r.enabled ? "running" : "paused"}.`,
          );
        }
      },
    );
  }

  // Prompt edits stay LOCAL while typing (draft) — the broker records a
  // revision per content PATCH, so only Publish sends the edit (one revision,
  // one change note, vN+1). No blur-persistence.
  function publish(r: Routine) {
    if (!(live && realId)) {
      patch(r.id, (x) => ({ ...x, version: x.version + 1, draft: false }));
      return;
    }
    // A failed publish keeps the draft flag — no fake version bump.
    void tryPatchRoutine(r.id, {
      agent: realId,
      prompt: r.prompt,
      changeNote: "Published from the Routines tab",
    }).then((updated) => {
      if (updated) {
        setNotice(null);
        patch(r.id, () => ({ ...fromWire(updated), draft: false }));
      } else {
        setNotice(
          `Could not publish “${r.name}” — the workspace may be offline. Your edit is still here; try again.`,
        );
      }
    });
  }

  // Run now — queues a fire at the broker; the watchdog runs the prompt
  // through the agent (gated server-side) within one tick. The outcome lands
  // in the routine's chat session + run history — so a successful queue opens
  // the Recent runs receipts and watches them until the run lands.
  async function runNow(r: Routine) {
    if (runningId) return;
    setRunningId(r.id);
    stopWatchPoll();
    setRunWatch(null);
    try {
      if (live && realId) {
        const queuedAt = Date.now();
        const queued = await tryRunRoutineNow(r.id);
        if (queued) {
          setNotice(null);
          setRunWatch({ id: r.id, queuedAt, phase: "queued" });
          setExpandedRuns((prev) => new Set(prev).add(r.id));
          startRunWatch({
            id: r.id,
            queuedAt,
            pollRef,
            setRunWatch,
            setRunsById,
            landRun: (rid, startedAt) =>
              patch(rid, (x) => ({ ...x, lastRun: startedAt })),
          });
        } else {
          // The queue call failed: nothing will run — do not fabricate
          // progress.
          setNotice(
            `Could not queue “${r.name}” — the workspace may be offline. Try again.`,
          );
        }
        return;
      }
      // Mock agent: record the run locally so the row reflects it ("last ran
      // just now" through the normal lastRun path).
      patch(r.id, (x) => ({ ...x, lastRun: "just now" }));
    } finally {
      setRunningId(null);
    }
  }

  function add() {
    const p = prompt.trim();
    if (!p) return;
    const n = name.trim() || p.slice(0, 40);
    const clear = () => {
      setName("");
      setPrompt("");
    };
    if (live && realId) {
      void tryCreateRoutine({
        agent: realId,
        name: n,
        prompt: p,
        schedule,
      }).then((created) => {
        if (created) {
          setNotice(null);
          setRoutines((prev) => [...prev, fromWire(created)]);
        } else {
          // Nothing was scheduled — an unscheduled local row would be a lie.
          setNotice(
            `Could not create “${n}” — the workspace may be offline. Try again.`,
          );
        }
      });
      clear();
      return;
    }
    setRoutines((prev) => [...prev, newRoutine(n, p, schedule)]);
    clear();
  }

  return (
    <div className="opr-tool-scoped opr-routines">
      <div className="opr-data-intro">
        <Eyebrow>Routines</Eyebrow>
        <p className="opr-scoped-note">
          A routine is a prompt {agentName} runs in its own chat on a schedule —
          it uses the agent's tools and its outcomes land in Artifacts. Pause or
          publish each routine on its own.
        </p>
      </div>

      {notice ? (
        <div className="opr-routine-notice" role="alert">
          {notice}
        </div>
      ) : null}
      {unavailable ? (
        <p className="opr-scoped-note">
          Routines are unavailable right now — the agent service could not be
          reached. They will appear once the workspace reconnects.
        </p>
      ) : routines.length === 0 ? (
        <p className="opr-scoped-note">
          No routines yet. A good first one is a Monday 9:00 recap of the week
          ahead — the status meeting that no longer needs the meeting. Create it
          below.
        </p>
      ) : null}

      <div className="opr-routine-list">
        {routines.map((r) => (
          <RoutineCard
            key={r.id}
            r={r}
            runWatch={runWatch}
            queueing={runningId === r.id}
            runDisabled={runningId !== null}
            expanded={expandedRuns.has(r.id)}
            runs={runsById[r.id]}
            onToggleEnabled={() => toggleEnabled(r)}
            onPublish={() => publish(r)}
            onRunNow={() => void runNow(r)}
            onToggleRuns={() => toggleRuns(r)}
            onEditPrompt={(value) =>
              patch(r.id, (x) => ({ ...x, prompt: value, draft: true }))
            }
            onOpenChat={() => onOpenSession?.(routineSessionKey(r), r.name)}
          />
        ))}
      </div>

      <div className="opr-routine-new">
        <div className="opr-tool-teach-label">
          <Plus size={12} strokeWidth={2} aria-hidden={true} />
          New routine
        </div>
        <div className="opr-routine-new-grid">
          <input
            className="opr-composer-input"
            aria-label="Routine name"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="opr-conn-select"
            aria-label="Schedule"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          >
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.expr} value={p.expr}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="opr-composer">
          <input
            className="opr-composer-input"
            aria-label="Routine prompt"
            placeholder="The prompt to run… e.g. summarize last week's pipeline and save it as a doc"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button
            type="button"
            className="opr-btn opr-btn-primary"
            onClick={add}
            disabled={!prompt.trim()}
          >
            Add routine
          </button>
        </div>
      </div>
    </div>
  );
}

// One routine card: name/version/schedule/status header, the editable prompt,
// the action row, and the Recent runs disclosure. While a Run now watch is
// live the Open its chat button swaps ghost for primary — the play-by-play is
// one click away.
function RoutineCard({
  r,
  runWatch,
  queueing,
  runDisabled,
  expanded,
  runs,
  onToggleEnabled,
  onPublish,
  onRunNow,
  onToggleRuns,
  onEditPrompt,
  onOpenChat,
}: {
  r: Routine;
  runWatch: RunWatch | null;
  queueing: boolean;
  runDisabled: boolean;
  expanded: boolean;
  runs: WireRoutineRun[] | null | undefined;
  onToggleEnabled: () => void;
  onPublish: () => void;
  onRunNow: () => void;
  onToggleRuns: () => void;
  onEditPrompt: (value: string) => void;
  onOpenChat: () => void;
}) {
  const watching = runWatch !== null && runWatch.id === r.id;
  return (
    <div className={`opr-routine${r.enabled ? "" : " is-disabled"}`}>
      <div className="opr-routine-head">
        <span className="opr-routine-name">{r.name}</span>
        <span className="opr-routine-version">
          v{r.version}
          {r.draft ? " · draft" : ""}
        </span>
        <span className="opr-routine-schedule">
          <CalendarClock size={11} strokeWidth={2} aria-hidden={true} />
          {humanSchedule(r.schedule)}
        </span>
        <span className="opr-routine-lastrun">{headerLabel(r, runWatch)}</span>
      </div>

      <textarea
        className="opr-routine-prompt"
        aria-label={`Prompt for ${r.name}`}
        value={r.prompt}
        rows={2}
        onChange={(e) => onEditPrompt(e.target.value)}
      />

      <div className="opr-routine-actions">
        <button
          type="button"
          className="opr-btn opr-btn-sm"
          onClick={onToggleEnabled}
        >
          <Power size={12} strokeWidth={2} aria-hidden={true} />
          {r.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          className="opr-btn opr-btn-primary opr-btn-sm"
          disabled={!r.draft}
          title={
            r.draft
              ? "Freeze the edited prompt as the next version"
              : "No changes since the last publish"
          }
          onClick={onPublish}
        >
          <CheckCircle2 size={12} strokeWidth={2} aria-hidden={true} />
          Publish new version
        </button>
        <button
          type="button"
          className="opr-btn opr-btn-sm"
          disabled={runDisabled}
          title="Run this routine's prompt through the agent now"
          onClick={onRunNow}
        >
          <Play size={12} strokeWidth={2} aria-hidden={true} />
          {queueing ? "Queueing…" : "Run now"}
        </button>
        <button
          type="button"
          className={`opr-btn ${
            watching ? "opr-btn-primary" : "opr-btn-ghost"
          } opr-btn-sm`}
          onClick={onOpenChat}
        >
          <MessageSquareText size={12} strokeWidth={2} aria-hidden={true} />
          Open its chat
        </button>
      </div>

      <div className="opr-routine-runs">
        <button
          type="button"
          className={`opr-routine-runs-toggle${expanded ? " is-open" : ""}`}
          aria-expanded={expanded}
          onClick={onToggleRuns}
        >
          <ChevronRight size={11} strokeWidth={2} aria-hidden={true} />
          Recent runs
        </button>
        {expanded ? (
          <RecentRuns
            runs={runs}
            watchFrom={watching && runWatch ? runWatch.queuedAt : undefined}
          />
        ) : null}
      </div>
    </div>
  );
}

// The routine's recent runs from the broker's per-slug run ring: status dot,
// when it ran (humanized), and the first line of its outcome. `undefined` while
// loading; `null`/empty shows the honest empty note. During a Run now watch
// the queued run (started after `watchFrom`, still pending) blinks with the
// existing live LED class.
function RecentRuns({
  runs,
  watchFrom,
}: {
  runs: WireRoutineRun[] | null | undefined;
  watchFrom?: number;
}) {
  if (runs === undefined) {
    return (
      <div role="status" aria-label="Loading recent runs">
        <div className="opr-skeleton opr-skel-row" />
      </div>
    );
  }
  if (!runs || runs.length === 0) {
    return <p className="opr-scoped-note">No runs recorded yet.</p>;
  }
  return (
    <ul className="opr-routine-runs-list">
      {runs.slice(0, 5).map((run, i) => {
        const status = runStatusClass(run.status);
        const isLive =
          watchFrom !== undefined &&
          status === "is-pending" &&
          Date.parse(run.started_at) > watchFrom;
        return (
          <li className="opr-routine-run" key={`${run.started_at}-${i}`}>
            <span
              className={`opr-run-led ${status}${isLive ? " opr-led-live" : ""}`}
              aria-hidden={true}
            />
            <span className="opr-routine-run-when">
              {formatStamp(run.started_at)}
            </span>
            <span className="opr-routine-run-summary">
              {firstLine(run.output_summary || run.message || "") || run.status}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
