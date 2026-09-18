import { type RefObject, useEffect } from "react";

import type { AttributeDefinition } from "../../../api/dataspaces";

/**
 * The string-draft editor contract. `onCommit` and `onCancel` are optional so
 * the same editors serve the inline cell (both wired) and a plain form such
 * as the new-record modal (neither wired; the form owns submit).
 */
export interface ValueFieldProps {
  attribute: AttributeDefinition;
  draft: string;
  onDraftChange: (next: string) => void;
  onCommit?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
}

interface Focusable {
  focus: () => void;
}

/**
 * Focus on mount, from an effect rather than the `autoFocus` attribute: an
 * inline editor replaces the element the user was standing on, and without an
 * explicit focus the next keystroke (Enter, Escape) goes to the document.
 */
export function useAutoFocus(
  ref: RefObject<(Focusable & { select?: () => void }) | null>,
  autoFocus: boolean | undefined,
): void {
  useEffect(() => {
    if (!autoFocus) return;
    const target = ref.current;
    if (!target) return;
    target.focus();
    target.select?.();
  }, [autoFocus, ref]);
}
