/**
 * TasksList — /tasks surface.
 *
 * Renders issue-level tasks (back-compat read of GET /tasks?all_channels=true)
 * as a 7-stage board. The data substrate keeps the broker's granular
 * `lifecycle_state` values; the board groups them into the seven
 * user-facing STAGES it derives in TypeScript (see `stageForState` in
 * lib/types/lifecycle.ts).
 *
 *   Scheduled Tasks · Backlog · In progress · Blocked ·
 *   Needs human input · Done · Archive
 *
 * The Scheduled column is the one exception to the lifecycle grouping —
 * it is fed by routines (the scheduler), not by any lifecycle_state, so
 * each card there is a SchedulerJob that links to its routine detail.
 * Every other card opens the shared TaskModal in place; /tasks/$taskId
 * stays reachable as a URL but is no longer where a click lands.
 */

import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getInboxItems } from "../../api/lifecycle";
import type { OfficeStats, OfficeStatsTasks } from "../../api/platform";
import { getScheduler, type SchedulerJob } from "../../api/scheduler";
import {
  getOfficeTasks,
  type Task,
  taskToLifecycleState,
} from "../../api/tasks";
import { useOfficeStats } from "../../hooks/useOfficeStats";
import { isNoticeRequest, needsYouCount } from "../../lib/needsYou";
import { router } from "../../lib/router";
import { formatTaskTitleForDisplay } from "../../lib/taskTitle";
import {
  type InboxItem,
  type InboxItemRequest,
  type InboxItemReview,
  renderInboxItemKey,
} from "../../lib/types/inbox";
import {
  type LifecycleStage,
  type LifecycleState,
  STAGE_LABELS,
  STAGE_ORDER,
  stageForState,
} from "../../lib/types/lifecycle";
import { useAppStore } from "../../stores/app";
import {
  routineKey,
  routineLabel,
  routineSchedule,
} from "../apps/routines/routineModel";
import {
  isCadenceSchedulerJob,
  isSystemRoutine,
} from "../apps/schedulerJobClassification";
import { TaskCreateDialog } from "../tasks/TaskCreateDialog";
import { LifecycleStatePill } from "./LifecycleStatePill";
import {
  activityDotForLifecycleState,
  TaskStatusDot,
} from "./TaskActivityStream";

// ── Helpers ────────────────────────────────────────────────────────────

export function isIssueTask(task: Task): boolean {
  // Sub-tasks are not top-level board rows — they render nested under their
  // parent's card (see TaskCardGroup), in the parent's lane. Filtering them
  // out of the top-level set here keeps each child tied to its parent instead
  // of floating as an independent card. Use the same trimmed parentIssueId()
  // the grouping uses, so a whitespace-only parent_issue_id can't be excluded
  // here yet treated as top-level there (which would hide the row entirely).
  if (parentIssueId(task) !== "") {
    return false;
  }
  return task.task_type === "issue" || task.pipeline_id === "issue";
}

/** Returns the sub-task's parent id, or "" when the task is top-level. */
function parentIssueId(task: Task): string {
  return task.parent_issue_id?.trim() ?? "";
}

/** Lowercased haystack used by the board's filter box for a single task. */
function taskMatchesQuery(task: Task, needle: string): boolean {
  const hay = `${task.title ?? ""} ${task.description ?? ""} ${task.owner ?? ""} ${task.channel ?? ""}`;
  return hay.toLowerCase().includes(needle);
}

/**
 * How long a stalled task has been quiet, as short human text ("23m", "2h").
 * Returns undefined when the task is not stalled or the stamp is unparseable
 * — a marker is only worth showing when it can say HOW long, since "quiet"
 * without a duration tells the reader nothing they cannot already see.
 *
 * A negative delta (clock skew between broker and browser) is treated as not
 * stalled rather than rendered as "quiet for -3m".
 */
export function quietForLabel(stalledSince?: string): string | undefined {
  const stamp = stalledSince?.trim();
  if (!stamp) return undefined;
  const since = new Date(stamp).getTime();
  if (Number.isNaN(since)) return undefined;
  const minutes = Math.floor((Date.now() - since) / 60_000);
  if (minutes < 1) return undefined;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * "N unassigned" toggle in the board header.
 *
 * Ownerless work has no other home on this board: a card reads "Unassigned"
 * one at a time, and nothing says how many there are without scanning every
 * lane. That mattered less when the CEO routed every task and held the whole
 * board in its head. Now that bots file their own work, nobody is watching
 * for a task nobody picked up.
 *
 * Counted from the tasks the board already fetched, so this needs no field in
 * /office/stats.
 */
function UnassignedChip({
  count,
  active,
  onToggle,
}: {
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className="issues-unassigned-chip"
      data-testid="issues-unassigned-chip"
      aria-pressed={active}
      onClick={onToggle}
      title={active ? "Show all tasks" : "Show only tasks nobody owns"}
    >
      {count} unassigned
    </button>
  );
}

/** Per-stage hint copy shown under the column header. The `scheduled`
 *  column is fed by routines, not lifecycle_state, so its hint reflects
 *  that. */
const STAGE_HINT: Record<LifecycleStage, string> = {
  scheduled: "Recurring scheduled tasks",
  backlog: "Parked or awaiting staffing",
  in_progress: "Owner bot working — includes revising",
  blocked: "Waiting on an upstream task, or owner stopped",
  needs_human: "Decisions, bot questions, and reviews waiting on you",
  done: "Landed",
  archive: "Filed away — archived or rejected",
};

// ── Sub-components ─────────────────────────────────────────────────────

// Memoized: the board re-derives its columns on every 10s task poll. Without
// memo, every card in every lane re-renders even when its own task is
// unchanged. Props are a single `task` object — React Query keeps the
// reference stable when the row's data hasn't changed.
const TaskCard = memo(function TaskCard({
  task,
  isSubtask = false,
}: {
  task: Task;
  /** Renders the compact, indented variant shown nested under a parent. */
  isSubtask?: boolean;
}) {
  const state = taskToLifecycleState(task);
  const ownerSlug = task.owner?.trim() || undefined;
  // Live "what's happening" line: the owner's current activity snapshot
  // (SSE-fed), surfaced on the card so the board reads at a glance — state,
  // who owns it, and what they're doing right now. Only shown while running;
  // other states are conveyed by the state pill.
  const snapshot = useAppStore((s) =>
    ownerSlug ? s.botActivitySnapshots[ownerSlug] : undefined,
  );
  const isRunning = activityDotForLifecycleState(state) === "running";
  const activity = isRunning ? snapshot?.activity?.trim() : undefined;
  // "Stuck" and "quiet" used to look identical on this board: a task whose
  // owner hit an auth wall and one that is merely slow both rendered as a
  // card in a lane. The broker has always known the difference — the
  // silent-stall watchdog stamps stalled_since — but it only ever announced
  // it as a chat post from "system", which is being retired, so the board is
  // now the only place this can surface.
  //
  // Deliberately worded as "quiet", not "stuck": the watchdog detects absence
  // of visible activity, which is not proof of failure. The card says what is
  // observed and the title says what to do about it.
  const stalledFor = quietForLabel(task.stalled_since);
  // Opens the shared task modal in place rather than navigating to the
  // chat-primary /tasks/$taskId surface. The route still works as a URL.
  const openTaskModal = useAppStore((s) => s.openTaskModal);

  return (
    <button
      type="button"
      className={`issues-kanban-card${isSubtask ? " issues-kanban-card--subtask" : ""}`}
      onClick={() => openTaskModal(task.id)}
      data-testid={isSubtask ? "issue-subtask-row" : "issue-row"}
      aria-label={`${isSubtask ? "Sub-task" : "Task"}: ${formatTaskTitleForDisplay(
        task.title,
      )}, state: ${state}${
        ownerSlug ? `, owner: ${ownerSlug}` : ", unassigned"
      }`}
    >
      <div className="issues-kanban-card-title">
        {formatTaskTitleForDisplay(task.title) || "Untitled"}
      </div>
      <div className="issues-kanban-card-meta">
        <LifecycleStatePill state={state} />
        {ownerSlug ? (
          <span className="issues-kanban-card-owner">@{ownerSlug}</span>
        ) : (
          <span className="issues-kanban-card-owner issues-kanban-card-owner--unassigned">
            Unassigned
          </span>
        )}
      </div>
      {stalledFor ? (
        <div
          className="issues-kanban-card-stalled"
          data-testid="issue-stalled"
          title="No visible activity from the owner. It may still be working — open the task to check or restart it."
        >
          <span className="issues-kanban-card-stalled-dot" aria-hidden={true} />
          <span className="issues-kanban-card-activity-text">
            Quiet for {stalledFor}
          </span>
        </div>
      ) : activity ? (
        <div className="issues-kanban-card-activity" title={activity}>
          <TaskStatusDot lifecycleState={state} />
          <span className="issues-kanban-card-activity-text">{activity}</span>
        </div>
      ) : null}
    </button>
  );
});

/**
 * A top-level task card together with its sub-tasks, rendered as one list
 * item. Sub-tasks nest directly beneath the parent card and stay in the
 * SAME lane as the parent — regardless of each child's own lifecycle stage —
 * so the board reads as a hierarchy ("these belong to that"). Each sub-task
 * opens its own task modal; the nesting is purely the visual tie back to the
 * parent.
 */
const TaskCardGroup = memo(function TaskCardGroup({
  task,
  subtasks,
}: {
  task: Task;
  subtasks: Task[];
}) {
  return (
    <li className="issues-kanban-card-group">
      <TaskCard task={task} />
      {subtasks.length > 0 ? (
        <ul
          className="issues-kanban-subtasks"
          aria-label={`Sub-tasks of ${
            formatTaskTitleForDisplay(task.title) || "task"
          }`}
          data-testid={`issue-subtasks-${task.id}`}
        >
          {subtasks.map((child) => (
            <li key={child.id}>
              <TaskCard task={child} isSubtask={true} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
});

/** Human-readable "next run" sub-line for a scheduled-task card. Prefers
 *  the routine's stored next_run timestamp, falling back to the cadence
 *  summary so the card always carries a schedule signal. */
function scheduledSubLine(job: SchedulerJob): string {
  if (job.next_run) {
    const next = new Date(job.next_run);
    if (!Number.isNaN(next.getTime())) {
      return `Next run ${next.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }
  }
  return routineSchedule(job).text;
}

/** Card for the Scheduled Tasks column. Reuses the task-card visual
 *  shell (title + meta sub-line) so the column reads consistently with
 *  the lifecycle columns, but navigates to the routine detail surface
 *  instead of a task detail. */
const ScheduledTaskCard = memo(function ScheduledTaskCard({
  job,
}: {
  job: SchedulerJob;
}) {
  const title = routineLabel(job);
  const { slug } = job;

  function navigate() {
    if (slug) {
      void router.navigate({
        to: "/routines/$routineSlug",
        params: { routineSlug: slug },
      });
      return;
    }
    // No slug to deep-link with — fall back to the Routines workspace.
    void router.navigate({ to: "/apps/$appId", params: { appId: "routines" } });
  }

  return (
    <button
      type="button"
      className="issues-kanban-card"
      onClick={navigate}
      data-testid="scheduled-task-row"
      aria-label={`Scheduled task: ${title}`}
    >
      <div className="issues-kanban-card-title">{title || "Untitled"}</div>
      <div className="issues-kanban-card-meta">
        <span className="issues-kanban-card-schedule">
          {scheduledSubLine(job)}
        </span>
      </div>
    </button>
  );
});

/** Search text for a folded attention item, so the board filter matches a
 *  request's question / author or a review's source + target path. */
function attentionSearchText(item: InboxItemRequest | InboxItemReview): string {
  if (item.kind === "request") {
    return `${item.title ?? ""} ${item.request.question ?? ""} ${item.request.from ?? ""}`;
  }
  return `${item.title ?? ""} ${item.review.sourceSlug ?? ""} ${item.review.targetPath ?? ""}`;
}

/** Card for a non-task attention item — a blocking bot request or a
 *  pending review — folded into the "Needs human input" lane when the
 *  standalone Inbox was consolidated into the board. Clicking a request
 *  opens the chat where its InterviewBar answers it; a review opens the
 *  Wiki Reviews tab. Reuses the task-card shell so the lane reads
 *  consistently with the lifecycle columns above it. */
const AttentionItemCard = memo(function AttentionItemCard({
  item,
}: {
  item: InboxItemRequest | InboxItemReview;
}) {
  const openTaskModal = useAppStore((s) => s.openTaskModal);

  function navigate() {
    if (item.kind === "request") {
      // Deliberately no channel jump: a task is not a doorway to a room. The
      // conversation lives in the office channel where the task was created,
      // reachable from Channels in the sidebar. A request that carries its
      // task opens that task's modal in place; one that doesn't falls back to
      // the board.
      const issueId = item.request.issueId?.trim();
      if (issueId) {
        openTaskModal(issueId);
        return;
      }
      void router.navigate({ to: "/tasks" });
      return;
    }
    // review → the Wiki, the home of promoted articles. The dedicated
    // promotion-review surface has been retired.
    void router.navigate({ to: "/wiki" });
  }

  const isRequest = item.kind === "request";
  const typeLabel = isRequest ? "Question" : "Review";
  const title = isRequest
    ? item.title || item.request.question || "Open request"
    : item.title || "Pending review";
  const subline = isRequest
    ? item.request.from
      ? `from @${item.request.from}`
      : "Awaiting your answer"
    : `${item.review.sourceSlug} → ${item.review.targetPath}`;

  return (
    <button
      type="button"
      className="issues-kanban-card"
      onClick={navigate}
      data-testid={isRequest ? "attention-request-row" : "attention-review-row"}
      aria-label={`${typeLabel}: ${title}`}
    >
      <div className="issues-kanban-card-title">{title}</div>
      <div className="issues-kanban-card-meta">
        <span className="issues-kanban-card-kind">{typeLabel}</span>
        <span className="issues-kanban-card-owner">{subline}</span>
      </div>
    </button>
  );
});

function TasksListSkeleton() {
  return (
    <div
      className="issues-list issues-list--loading"
      data-testid="issues-list-loading"
      aria-busy="true"
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="issues-list-skeleton-row"
          style={{ width: `${50 + i * 10}%` }}
        />
      ))}
    </div>
  );
}

function TasksListError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="issues-list issues-list--error"
      data-testid="issues-list-error"
    >
      <div role="alert" className="issues-list-error-card">
        <strong>Could not load tasks</strong>
        <p>{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="issues-list-retry-btn"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function TasksEmptyState({ onOpenCreate }: { onOpenCreate: () => void }) {
  return (
    <div
      className="issues-list issues-list--empty"
      data-testid="issues-list-empty"
    >
      <p className="issues-empty-copy">
        No tasks yet. The team is watching this space, which is all they can do
        until you file something.
      </p>
      <button
        type="button"
        className="issues-new-btn"
        onClick={onOpenCreate}
        data-testid="issues-new-btn"
      >
        + New task
      </button>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

interface TasksListProps {
  /** Used in tests to skip the fetch. */
  initialTasks?: Task[];
  /**
   * Used in tests to seed the shared stats counts without a broker.
   *
   * Carries the FULL payload rather than just the task buckets, because the
   * Needs-human header is needsYouCount(stats) — a tasks-only seam would make
   * the seeded path compute that header differently from production, which is
   * the class of split this whole change exists to remove.
   */
  initialStats?: OfficeStats;
  /**
   * Used in tests to seed the folded attention items (blocking requests +
   * pending reviews) shown in the Needs-human lane without a broker poll.
   */
  initialInboxItems?: InboxItem[];
}

/**
 * Maps a board stage onto its field in the shared /office/stats tasks
 * payload. `scheduled` returns null — that lane is fed by routines, not
 * lifecycle state, so its count always comes from the local job list.
 */
function statsCountForStage(
  stats: OfficeStatsTasks,
  stage: LifecycleStage,
): number | null {
  switch (stage) {
    case "backlog":
      return stats.backlog;
    case "in_progress":
      return stats.active;
    case "blocked":
      return stats.blocked;
    case "needs_human":
      return stats.needs_human;
    case "done":
      return stats.done;
    case "archive":
      return stats.archive;
    default:
      return null;
  }
}

// Per-lane collapse preference, persisted across reloads. A lane with no
// explicit preference auto-collapses when EMPTY so the board leads with active
// work instead of a row of empty columns. An explicit click (expand/collapse)
// wins over the auto-default and is remembered.
const BOARD_LANE_PREFS_KEY = "wuphf-board-lane-prefs";

function readLanePrefs(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BOARD_LANE_PREFS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Keep only boolean values — a stale/tampered entry with a string or
    // number would otherwise pass through and break isLaneCollapsed's
    // `lanePrefs[stage] ?? count === 0` (a truthy string short-circuits the
    // empty-lane auto-collapse default).
    const clean: Record<string, boolean> = {};
    for (const [stage, collapsed] of Object.entries(parsed)) {
      if (typeof collapsed === "boolean") clean[stage] = collapsed;
    }
    return clean;
  } catch {
    // Corrupt/blocked storage — fall back to the auto (empty-collapsed) default.
  }
  return {};
}

export function TasksList({
  initialTasks,
  initialStats,
  initialInboxItems,
}: TasksListProps = {}) {
  const [query, setQuery] = useState("");
  const [showUnassignedOnly, setShowUnassignedOnly] = useState(false);
  // Inline dialog replaces /tasks/new full-page form for the in-app path.
  // The route stays mounted as a fallback for direct URL navigation.
  const [createOpen, setCreateOpen] = useState(false);
  // stage -> true (collapsed) / false (expanded). Absent = auto (collapse when
  // the lane is empty). Read isLaneCollapsed() for the resolved value.
  const [lanePrefs, setLanePrefs] =
    useState<Record<string, boolean>>(readLanePrefs);

  function isLaneCollapsed(stage: LifecycleStage, count: number): boolean {
    return lanePrefs[stage] ?? count === 0;
  }

  function toggleLane(stage: LifecycleStage, currentlyCollapsed: boolean) {
    setLanePrefs((prev) => {
      const next = { ...prev, [stage]: !currentlyCollapsed };
      try {
        window.localStorage.setItem(BOARD_LANE_PREFS_KEY, JSON.stringify(next));
      } catch {
        // Persistence is best-effort; the in-memory state still updates.
      }
      return next;
    });
  }

  const result = useQuery({
    queryKey: ["issues", "list"],
    // includeDone so the Done + Archive columns populate — the broker
    // otherwise drops landed/closed tasks from the default list.
    queryFn: () => getOfficeTasks({ includeDone: true }),
    initialData: initialTasks ? { tasks: initialTasks } : undefined,
    staleTime: 5_000,
    refetchInterval: 10_000,
    enabled: !initialTasks,
  });

  // Routines feed the Scheduled column. Skipped in test renders (when
  // initialTasks is provided) so unit tests stay free of scheduler mocks.
  const schedulerResult = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => getScheduler(),
    refetchInterval: 15_000,
    enabled: !initialTasks,
  });

  // Blocking requests + pending reviews fold into the Needs-human lane —
  // the two non-task halves of the retired Inbox. Same fan-out the
  // inbox_attention badge counts. Skipped in test renders (initialTasks
  // set); tests seed `initialInboxItems` directly instead.
  const inboxResult = useQuery({
    queryKey: ["inbox-items", "board"],
    queryFn: () => getInboxItems("all"),
    refetchInterval: 10_000,
    staleTime: 5_000,
    enabled: !initialTasks,
  });

  // Shared derived-stats source: lane header counts read the same
  // /office/stats payload the header strip / dashboard / inbox badge
  // consume, so the board header can never disagree with the rest of
  // the shell. Bucketing parity (stats ↔ the cards rendered below) is
  // pinned server-side by TestOfficeStats_MatchesListEndpoints.
  const statsResult = useOfficeStats();
  const stats = initialStats ?? statsResult.data;

  const allTasks = result.data?.tasks ?? [];
  const tasks = useMemo(() => allTasks.filter(isIssueTask), [allTasks]);

  // Group sub-tasks by their parent so each parent card can render its
  // children nested beneath it (TaskCardGroup). Built from the full task set
  // because sub-tasks are filtered out of the top-level `tasks` list above.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of allTasks) {
      const parentId = parentIssueId(task);
      if (!parentId) continue;
      const existing = map.get(parentId);
      if (existing) existing.push(task);
      else map.set(parentId, [task]);
    }
    return map;
  }, [allTasks]);

  const scheduledJobs = useMemo<SchedulerJob[]>(() => {
    const jobs = schedulerResult.data?.jobs ?? [];
    // The work board shows the operator's own recurring routines, not the
    // broker's system plumbing (Nex insights, archive sweeps, follow-up
    // reminders). System routines live in the Scheduled Tasks tool, which
    // has its own show-system toggle.
    return jobs.filter(
      (job) => isCadenceSchedulerJob(job) && !isSystemRoutine(job),
    );
  }, [schedulerResult.data]);

  const unassignedCount = useMemo(
    () => tasks.filter((t) => !t.owner?.trim()).length,
    [tasks],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byOwner = showUnassignedOnly
      ? tasks.filter((t) => !t.owner?.trim())
      : tasks;
    if (!needle) return byOwner;
    // A parent surfaces when it matches OR any of its sub-tasks match, so a
    // search for a child's text still finds it (nested under its parent).
    return byOwner.filter((t) => {
      if (taskMatchesQuery(t, needle)) return true;
      const children = childrenByParent.get(t.id) ?? [];
      return children.some((child) => taskMatchesQuery(child, needle));
    });
  }, [tasks, query, childrenByParent, showUnassignedOnly]);

  const filteredScheduled = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return scheduledJobs;
    return scheduledJobs.filter((job) =>
      routineLabel(job).toLowerCase().includes(needle),
    );
  }, [scheduledJobs, query]);

  // Non-task attention items folded into the Needs-human lane: requests and
  // reviews from the unified inbox feed, EXCLUDING notices.
  //
  // A notice is news, not a decision — the delivery post already announced it
  // in the channel the human is reading. Folding notices in here is what put a
  // card in this lane while the header strip said "all quiet", because the
  // strip never counted them. The lane shows what needs a human; nothing else.
  const attentionItems = useMemo<
    Array<InboxItemRequest | InboxItemReview>
  >(() => {
    const items = initialInboxItems ?? inboxResult.data?.items ?? [];
    return items.filter(
      (item): item is InboxItemRequest | InboxItemReview =>
        (item.kind === "request" && !isNoticeRequest(item)) ||
        item.kind === "review",
    );
  }, [initialInboxItems, inboxResult.data]);

  const filteredAttention = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return attentionItems;
    return attentionItems.filter((item) =>
      attentionSearchText(item).toLowerCase().includes(needle),
    );
  }, [attentionItems, query]);

  // Bucket lifecycle tasks by stage. The scheduled stage is filled
  // separately from routines, so it stays empty here.
  const columns = useMemo(() => {
    const buckets: Record<LifecycleStage, Task[]> = {
      scheduled: [],
      backlog: [],
      in_progress: [],
      blocked: [],
      needs_human: [],
      done: [],
      archive: [],
    };
    for (const task of filtered) {
      const stage = stageForState(taskToLifecycleState(task));
      buckets[stage].push(task);
    }
    return buckets;
  }, [filtered]);

  if (result.isPending && !initialTasks) {
    return <TasksListSkeleton />;
  }

  if (result.isError && !result.data) {
    return (
      <TasksListError
        message={
          result.error instanceof Error
            ? result.error.message
            : "Network or broker error."
        }
        onRetry={() => void result.refetch()}
      />
    );
  }

  // The empty state claims nothing is waiting on you, so it may only render
  // when that is actually true. Attention items — blocking requests and
  // pending reviews — are counted by needsYouCount and folded into the
  // Needs-human lane below, but they are NOT tasks. Gating this on task count
  // alone printed "No tasks yet" underneath a "1 NEED YOU" header chip, a lit
  // sidebar badge, and a desktop notification, with the request itself
  // rendered nowhere at all (observed 2026-09-03: a blocking "Add Prospector
  // to the team?" ask). Anything the header counts, the body must be able to
  // show.
  if (tasks.length === 0 && attentionItems.length === 0) {
    return (
      <>
        <TasksEmptyState onOpenCreate={() => setCreateOpen(true)} />
        <TaskCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      </>
    );
  }

  function columnCount(stage: LifecycleStage): number {
    if (stage === "scheduled") {
      return filteredScheduled.length;
    }
    // Folded request + review cards live only in the Needs-human lane, so
    // its header count is the decision-task count plus those extras.
    const extras = stage === "needs_human" ? filteredAttention.length : 0;
    // Unfiltered board: the Needs-human header is the SHARED "needs you"
    // count, so this lane, the runtime strip, and the sidebar badge can only
    // ever print the same number. Every other lane reads its own bucket from
    // the same stats payload. While a search filter is active — or before the
    // stats query resolves — counts reflect exactly the cards rendered below.
    // Stats counts describe the WHOLE board, so they are only correct while
    // nothing is filtering it. With the search box or the unassigned filter
    // active the header must count the cards actually rendered below it —
    // otherwise the header and its own lane disagree, which is the drift this
    // lane was just fixed for.
    if (!(query.trim() || showUnassignedOnly) && stats) {
      if (stage === "needs_human") return needsYouCount(stats);
      const fromStats = statsCountForStage(stats.tasks, stage);
      if (fromStats !== null) return fromStats;
    }
    return columns[stage].length + extras;
  }

  return (
    <div className="issues-list issues-list--kanban" data-testid="issues-list">
      <header className="issues-list-header">
        <h2 className="issues-list-heading">Tasks</h2>
        <input
          type="search"
          className="issues-list-search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter tasks"
          data-testid="issues-list-search"
        />
        <UnassignedChip
          count={unassignedCount}
          active={showUnassignedOnly}
          onToggle={() => setShowUnassignedOnly((v) => !v)}
        />
        <button
          type="button"
          className="issues-new-btn issues-new-btn--header"
          onClick={() => setCreateOpen(true)}
          data-testid="issues-new-btn"
          title="Create a new task"
        >
          + New task
        </button>
      </header>
      <TaskCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      {/*
        The outer wrapper is a layout grid of columns, not a list — each
        column has its own role="list" of cards below. Putting role="list"
        here too with <section> children that aren't role="listitem" would
        be invalid ARIA, so the wrapper is left as a plain <div>.
      */}
      <div className="issues-kanban" data-testid="issues-list-rows">
        {STAGE_ORDER.map((stage) => {
          const count = columnCount(stage);
          const collapsed = isLaneCollapsed(stage, count);
          return (
            <section
              key={stage}
              className={`issues-kanban-column${collapsed ? " is-collapsed" : ""}`}
              data-column={stage}
              data-collapsed={collapsed}
              data-testid={`issues-kanban-column-${stage}`}
            >
              <header className="issues-kanban-column-header">
                <button
                  type="button"
                  className="issues-kanban-column-toggle"
                  aria-expanded={!collapsed}
                  onClick={() => toggleLane(stage, collapsed)}
                  title={
                    collapsed
                      ? `Expand ${STAGE_LABELS[stage]}`
                      : `Collapse ${STAGE_LABELS[stage]}`
                  }
                  data-testid={`issues-kanban-column-toggle-${stage}`}
                >
                  <span
                    className="issues-kanban-column-caret"
                    aria-hidden="true"
                  >
                    {collapsed ? "›" : "⌄"}
                  </span>
                  <span className="issues-kanban-column-title">
                    {STAGE_LABELS[stage]}
                  </span>
                  <span className="issues-kanban-column-count">{count}</span>
                </button>
              </header>
              {collapsed ? null : (
                <>
                  <p className="issues-kanban-column-hint">
                    {STAGE_HINT[stage]}
                  </p>
                  <ul className="issues-kanban-column-cards">
                    {count === 0 ? (
                      <li
                        className="issues-kanban-column-empty"
                        aria-label={`No tasks in ${STAGE_LABELS[stage]}`}
                        title="Watched closely. Still empty."
                      >
                        —
                      </li>
                    ) : stage === "scheduled" ? (
                      filteredScheduled.map((job) => (
                        <li key={routineKey(job)}>
                          <ScheduledTaskCard job={job} />
                        </li>
                      ))
                    ) : stage === "needs_human" ? (
                      <>
                        {columns[stage].map((task) => (
                          <TaskCardGroup
                            key={task.id}
                            task={task}
                            subtasks={childrenByParent.get(task.id) ?? []}
                          />
                        ))}
                        {filteredAttention.map((item) => (
                          <li key={renderInboxItemKey(item)}>
                            <AttentionItemCard item={item} />
                          </li>
                        ))}
                      </>
                    ) : (
                      columns[stage].map((task) => (
                        <TaskCardGroup
                          key={task.id}
                          task={task}
                          subtasks={childrenByParent.get(task.id) ?? []}
                        />
                      ))
                    )}
                  </ul>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
