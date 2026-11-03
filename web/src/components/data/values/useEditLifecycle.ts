import { useCallback, useRef, useState } from "react";

export interface UseEditLifecycleOptions {
  /** The stored value as a draft string. Snapshotted when editing starts. */
  initialDraft: string;
  /** Called at most once per edit, and only when the draft actually changed. */
  onCommit: (draft: string) => void;
}

export interface EditLifecycle {
  isEditing: boolean;
  draft: string;
  setDraft: (next: string) => void;
  start: () => void;
  commit: () => void;
  cancel: () => void;
}

/**
 * One edit session: start, change the draft, then commit or cancel.
 *
 * The draft is mirrored into a ref so `commit()` called in the same tick as
 * `setDraft()` (a listbox that selects and commits on one Enter) sees the new
 * text instead of the last rendered one.
 *
 * The session flag is a ref for the same reason: Enter commits, the editor
 * unmounts, and the unmount fires a blur that commits again. The second call
 * finds the session already closed and does nothing.
 */
export function useEditLifecycle({
  initialDraft,
  onCommit,
}: UseEditLifecycleOptions): EditLifecycle {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraftState] = useState(initialDraft);
  const draftRef = useRef(initialDraft);
  const sessionInitialRef = useRef(initialDraft);
  const isSessionOpenRef = useRef(false);

  const setDraft = useCallback((next: string) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const start = useCallback(() => {
    if (isSessionOpenRef.current) return;
    isSessionOpenRef.current = true;
    sessionInitialRef.current = initialDraft;
    draftRef.current = initialDraft;
    setDraftState(initialDraft);
    setIsEditing(true);
  }, [initialDraft]);

  const commit = useCallback(() => {
    if (!isSessionOpenRef.current) return;
    isSessionOpenRef.current = false;
    setIsEditing(false);
    const next = draftRef.current;
    if (next.trim() === sessionInitialRef.current.trim()) return;
    onCommit(next);
  }, [onCommit]);

  const cancel = useCallback(() => {
    if (!isSessionOpenRef.current) return;
    isSessionOpenRef.current = false;
    draftRef.current = sessionInitialRef.current;
    setDraftState(sessionInitialRef.current);
    setIsEditing(false);
  }, []);

  return {
    isEditing,
    // Outside a session the draft tracks the stored value, so a caller that
    // reads it between edits never sees a stale string.
    draft: isEditing ? draft : initialDraft,
    setDraft,
    start,
    commit,
    cancel,
  };
}
