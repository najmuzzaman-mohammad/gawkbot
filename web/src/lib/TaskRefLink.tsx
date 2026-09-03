/**
 * TaskRefLink — the rendered form of an inline task reference in chat prose.
 *
 * Two behaviours the raw id did not have:
 *
 *  1. It reads as what the task IS. "DUNDE-72" on its own tells the reader
 *     nothing; the link text resolves to the task's title ("Ship the Q3
 *     pricing page") and falls back to the id only when the title is
 *     genuinely unknown.
 *  2. Clicking opens the shared task modal in place. It used to navigate to
 *     /tasks/$taskId, which drops the reader into a chat surface — wrong now
 *     that tasks no longer own channels.
 *
 * Titles come from the board's own `["issues","list"]` cache, so a reference
 * in a message the human is already reading beside the board costs no extra
 * request. The cache is read through QueryClientContext directly rather than
 * useQueryClient() because chat markdown is rendered in tests (and in
 * isolated stories) with no QueryClientProvider above it — useQueryClient
 * throws there, and a missing title must degrade to the id, never to a crash.
 */

import {
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import { QueryClientContext } from "@tanstack/react-query";

import type { TaskListResponse } from "../api/tasks";
import { useAppStore } from "../stores/app";
import { formatTaskTitleForDisplay } from "./taskTitle";

/** Board query key. Kept in sync with TasksList / useTaskRecord. */
const TASKS_LIST_KEY = ["issues", "list"] as const;

/**
 * Resolve a task's title from the already-fetched board cache. Returns
 * undefined when there is no QueryClient, no cached list, or no such task —
 * every one of which means "render the id instead".
 */
export function useTaskTitle(taskId: string): string | undefined {
  const client = useContext(QueryClientContext);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!client) return () => {};
      return client.getQueryCache().subscribe(onStoreChange);
    },
    [client],
  );

  const getSnapshot = useCallback(() => {
    if (!(client && taskId)) return undefined;
    const data = client.getQueryData<TaskListResponse>(TASKS_LIST_KEY);
    if (!data) return undefined;
    const wanted = taskId.toLowerCase();
    const match =
      data.tasks.find((t) => t.id === taskId) ??
      data.tasks.find((t) => t.id.toLowerCase() === wanted);
    const title = formatTaskTitleForDisplay(match?.title).trim();
    return title || undefined;
  }, [client, taskId]);

  // Same snapshot getter server-side: with no client there is nothing to
  // read, and the id fallback renders identically on both passes.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface TaskRefLinkProps {
  taskId: string;
  /** Raw matched text, used as the label when no title is known. */
  children: ReactNode;
}

export function TaskRefLink({ taskId, children }: TaskRefLinkProps) {
  const openTaskModal = useAppStore((s) => s.openTaskModal);
  const title = useTaskTitle(taskId);

  return (
    <button
      type="button"
      className="msg-task-link"
      onClick={() => openTaskModal(taskId)}
      data-task-id={taskId}
      // The id stays discoverable even when the label is the title, so a
      // human can still quote "DUNDE-72" back to a bot.
      title={title ? `${taskId} · ${title}` : taskId}
      aria-label={
        title ? `Open task ${taskId}: ${title}` : `Open task ${taskId}`
      }
      disabled={!taskId}
    >
      {/* ALWAYS the id AND the title, in that order.
          The id alone tells a reader nothing ("DUNDE-5" — what is that?),
          and the title alone loses the handle they need to quote back to a
          bot. Showing both is what makes the pill self-explanatory in the
          middle of a sentence. Falls back to the id when the task is not in
          the board cache yet, which is the case for a task created seconds
          ago in this very message. */}
      <span className="msg-task-link-id">{taskId || children}</span>
      {title ? <span className="msg-task-link-title">{title}</span> : null}
    </button>
  );
}
