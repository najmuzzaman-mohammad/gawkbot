import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";

import type {
  AttributeDefinition,
  AttributeValue,
} from "../../../api/dataspaces";
import { useEditLifecycle } from "./useEditLifecycle";
import { ValueCell } from "./ValueCell";
import { ValueField } from "./ValueField";
import { draftToValue, isInlineEditable, valueToDraft } from "./valueFormat";

import "../../../styles/data-values.css";

export interface EditableValueCellProps {
  attribute: AttributeDefinition;
  value: AttributeValue | undefined;
  /**
   * Withhold this and the cell is read-only: capability is expressed by the
   * handler's presence, not by a flag. `null` means "clear the value".
   */
  onCommit?: (next: AttributeValue | null) => void;
  /** A write is in flight: shows a spinner and blocks a second edit. */
  isPending?: boolean;
}

const EDIT_KEYS: ReadonlySet<string> = new Set(["Enter", "F2"]);
const TOGGLE_KEYS: ReadonlySet<string> = new Set(["Enter", " "]);

/**
 * One value in a records table. The cell is a `gridcell`, so whatever renders
 * it owns the surrounding `grid` and `row` roles.
 *
 * Double-click, Enter, or F2 swaps the display for the type's editor. A
 * single click is left free for whatever the row puts around the cell (the
 * name link, the preview chip). Toggles are the exception: they flip in place
 * on click or Space, with no edit mode to enter.
 *
 * Clearing a required attribute is still sent. The client owns that rule and
 * rejects it with a message the caller can show; hiding the attempt here
 * would leave the user with a cell that silently refuses to change.
 */
export function EditableValueCell({
  attribute,
  value,
  onCommit,
  isPending = false,
}: EditableValueCellProps) {
  const cellRef = useRef<HTMLDivElement>(null);
  const wasEditingRef = useRef(false);
  const focusMovedAwayRef = useRef(false);
  const canEdit = onCommit !== undefined && isInlineEditable(attribute);
  const isToggle = attribute.type === "toggle";

  const commitDraft = useCallback(
    (nextDraft: string) => onCommit?.(draftToValue(attribute, nextDraft)),
    [attribute, onCommit],
  );

  const { isEditing, draft, setDraft, start, commit, cancel } =
    useEditLifecycle({
      initialDraft: valueToDraft(attribute, value),
      onCommit: commitDraft,
    });

  // Leaving edit mode unmounts the focused editor, which drops focus to
  // <body> and strands keyboard users outside the grid. Put it back on the
  // cell, unless the edit ended BECAUSE focus went to another element (a
  // click or Tab away), in which case taking it back would fight the user.
  useEffect(() => {
    if (isEditing) {
      wasEditingRef.current = true;
      return;
    }
    if (!wasEditingRef.current) return;
    wasEditingRef.current = false;
    if (focusMovedAwayRef.current) {
      focusMovedAwayRef.current = false;
      return;
    }
    cellRef.current?.focus();
  }, [isEditing]);

  const handleEditorBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    focusMovedAwayRef.current =
      next instanceof Node && !event.currentTarget.contains(next);
  };

  const isInteractive = canEdit && !isPending;

  const flipToggle = () => {
    if (isInteractive) onCommit?.(value !== true);
  };

  const handleClick = () => {
    if (isToggle) flipToggle();
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isInteractive || isToggle) return;
    event.preventDefault();
    start();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed on something inside the cell (a link) belong to it.
    if (event.target !== event.currentTarget || !isInteractive) return;
    if (isToggle) {
      if (!TOGGLE_KEYS.has(event.key)) return;
      event.preventDefault();
      flipToggle();
      return;
    }
    if (!EDIT_KEYS.has(event.key)) return;
    event.preventDefault();
    start();
  };

  if (!canEdit) {
    return (
      <div
        className="dv-cell"
        role="gridcell"
        aria-readonly={true}
        // Not a tab stop, but reachable by a grid's own arrow-key focus.
        tabIndex={-1}
        data-type={attribute.type}
      >
        <ValueCell attribute={attribute} value={value} />
      </div>
    );
  }

  if (isEditing) {
    return (
      <div
        className="dv-cell"
        role="gridcell"
        tabIndex={-1}
        data-type={attribute.type}
        data-editing="true"
        onBlur={handleEditorBlur}
      >
        <ValueField
          attribute={attribute}
          draft={draft}
          onDraftChange={setDraft}
          onCommit={commit}
          onCancel={cancel}
          autoFocus={true}
        />
      </div>
    );
  }

  return (
    <div
      ref={cellRef}
      className="dv-cell"
      role="gridcell"
      aria-busy={isPending}
      data-type={attribute.type}
      data-editable="true"
      data-pending={isPending ? "true" : "false"}
      tabIndex={0}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <ValueCell attribute={attribute} value={value} />
      {isPending ? (
        <span className="dv-cell__spinner" role="status" aria-label="Saving" />
      ) : null}
    </div>
  );
}
