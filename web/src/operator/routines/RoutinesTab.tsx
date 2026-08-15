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

import { useEffect, useState } from "react";
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
  // Run-now feedback: which routine is mid-queue, and which just queued/ran.
  const [runningId, setRunningId] = useState<string | null>(null);
  const [ranJustNowId, setRanJustNowId] = useState<string | null>(null);
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
  // in the routine's chat session + run history, not in this response.
  async function runNow(r: Routine) {
    if (runningId) return;
    setRunningId(r.id);
    setRanJustNowId(null);
    try {
      if (live && realId) {
        const queued = await tryRunRoutineNow(r.id);
        if (queued) {
          setNotice(null);
          setRanJustNowId(r.id);
        } else {
          // The queue call failed: nothing will run — do not fabricate
          // "ran just now".
          setNotice(
            `Could not queue “${r.name}” — the workspace may be offline. Try again.`,
          );
        }
        return;
      }
      // Mock agent: record the run locally so the row reflects it.
      patch(r.id, (x) => ({ ...x, lastRun: "just now" }));
      setRanJustNowId(r.id);
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
          No routines yet. Create the first one below — a good starter is a
          Monday morning recap of the week ahead.
        </p>
      ) : null}

      <div className="opr-routine-list">
        {routines.map((r) => (
          <div
            key={r.id}
            className={`opr-routine${r.enabled ? "" : " is-disabled"}`}
          >
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
              <span className="opr-routine-lastrun">
                {ranJustNowId === r.id
                  ? live
                    ? "queued — starting in a moment"
                    : "ran just now"
                  : r.enabled
                    ? r.lastRun
                      ? `last ran ${formatLastRun(r.lastRun)}`
                      : "not run yet"
                    : "paused"}
              </span>
            </div>

            <textarea
              className="opr-routine-prompt"
              aria-label={`Prompt for ${r.name}`}
              value={r.prompt}
              rows={2}
              onChange={(e) =>
                patch(r.id, (x) => ({
                  ...x,
                  prompt: e.target.value,
                  draft: true,
                }))
              }
            />

            <div className="opr-routine-actions">
              <button
                type="button"
                className="opr-btn opr-btn-sm"
                onClick={() => toggleEnabled(r)}
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
                onClick={() => publish(r)}
              >
                <CheckCircle2 size={12} strokeWidth={2} aria-hidden={true} />
                Publish new version
              </button>
              <button
                type="button"
                className="opr-btn opr-btn-sm"
                disabled={runningId !== null}
                title="Run this routine's prompt through the agent now"
                onClick={() => void runNow(r)}
              >
                <Play size={12} strokeWidth={2} aria-hidden={true} />
                {runningId === r.id ? "Queueing…" : "Run now"}
              </button>
              <button
                type="button"
                className="opr-btn opr-btn-ghost opr-btn-sm"
                onClick={() => onOpenSession?.(routineSessionKey(r), r.name)}
              >
                <MessageSquareText
                  size={12}
                  strokeWidth={2}
                  aria-hidden={true}
                />
                Open its chat
              </button>
            </div>

            <div className="opr-routine-runs">
              <button
                type="button"
                className={`opr-routine-runs-toggle${
                  expandedRuns.has(r.id) ? " is-open" : ""
                }`}
                aria-expanded={expandedRuns.has(r.id)}
                onClick={() => toggleRuns(r)}
              >
                <ChevronRight size={11} strokeWidth={2} aria-hidden={true} />
                Recent runs
              </button>
              {expandedRuns.has(r.id) ? (
                <RecentRuns runs={runsById[r.id]} />
              ) : null}
            </div>
          </div>
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

// The routine's recent runs from the broker's per-slug run ring: status dot,
// when it ran (humanized), and the first line of its outcome. `undefined` while
// loading; `null`/empty shows the honest empty note.
function RecentRuns({ runs }: { runs: WireRoutineRun[] | null | undefined }) {
  if (runs === undefined) {
    return <p className="opr-scoped-note">Loading recent runs…</p>;
  }
  if (!runs || runs.length === 0) {
    return <p className="opr-scoped-note">No runs recorded yet.</p>;
  }
  return (
    <ul className="opr-routine-runs-list">
      {runs.slice(0, 5).map((run, i) => (
        <li className="opr-routine-run" key={`${run.started_at}-${i}`}>
          <span
            className={`opr-run-led ${runStatusClass(run.status)}`}
            aria-hidden={true}
          />
          <span className="opr-routine-run-when">
            {formatStamp(run.started_at)}
          </span>
          <span className="opr-routine-run-summary">
            {firstLine(run.output_summary || run.message || "") || run.status}
          </span>
        </li>
      ))}
    </ul>
  );
}
