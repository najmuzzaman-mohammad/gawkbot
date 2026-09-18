import { useCallback, useEffect, useRef } from "react";
import { EditPencil } from "iconoir-react";

import type {
  AttributeDefinition,
  AttributeValue,
} from "../../../api/dataspaces";
import { focusIsUnclaimed } from "../records/focus";
import { useEditLifecycle } from "../values/useEditLifecycle";
import { ToggleGlyph, ValueCell } from "../values/ValueCell";
import { ValueField } from "../values/ValueField";
import {
  draftToValue,
  isEmptyValue,
  valueToDraft,
} from "../values/valueFormat";

import "../../../styles/data-record.css";

const LINK_TYPES: readonly string[] = ["url", "email", "phone"];

export interface InPlaceValueProps {
  attribute: AttributeDefinition;
  value: AttributeValue | undefined;
  /** Withhold for read-only. `null` clears the value. */
  onCommit?: (next: AttributeValue | null) => void;
  isPending?: boolean;
  /** Open the editor on mount: the "+ Phone" chips use this. */
  startInEditMode?: boolean;
  /** Fired when an edit session closes, committed or cancelled. */
  onEditEnd?: () => void;
  /** `title` renders the display at heading size (the record name). */
  variant?: "value" | "title";
}

/**
 * One value on the record page, editable where it stands. This is the record
 * page's counterpart to the table's `EditableValueCell`, which is a
 * `gridcell` and so is not valid outside a grid.
 *
 * The display IS the edit control: a button, so click and Enter both open
 * the editor with no extra wiring. A value that is itself a link (url,
 * email, phone) stays a working link and gets a pencil button beside it
 * instead, because a link inside a button is not valid. Toggles flip on
 * click and never enter edit mode.
 */
export function InPlaceValue({
  attribute,
  value,
  onCommit,
  isPending = false,
  startInEditMode = false,
  onEditEnd,
  variant = "value",
}: InPlaceValueProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(false);
  const didAutoStartRef = useRef(false);
  const onEditEndRef = useRef(onEditEnd);
  onEditEndRef.current = onEditEnd;

  const commitDraft = useCallback(
    (nextDraft: string) => onCommit?.(draftToValue(attribute, nextDraft)),
    [attribute, onCommit],
  );
  const { isEditing, draft, setDraft, start, commit, cancel } =
    useEditLifecycle({
      initialDraft: valueToDraft(attribute, value),
      onCommit: commitDraft,
    });

  useEffect(() => {
    if (!startInEditMode || didAutoStartRef.current) return;
    didAutoStartRef.current = true;
    start();
  }, [startInEditMode, start]);

  // The editor unmounts when a session closes, dropping focus to <body>. Put
  // it back on the control that opened it, unless the user already moved to
  // another control, which by now holds focus and should keep it.
  useEffect(() => {
    if (isEditing) {
      wasEditingRef.current = true;
      return;
    }
    if (!wasEditingRef.current) return;
    wasEditingRef.current = false;
    if (focusIsUnclaimed()) triggerRef.current?.focus();
    onEditEndRef.current?.();
  }, [isEditing]);

  // `aria-disabled`, not `disabled`: focus returns to this control the moment
  // an edit commits, which is also the moment the write goes pending, and a
  // disabled button cannot hold focus.
  const startIfIdle = () => {
    if (!isPending) start();
  };

  const label = attribute.name;
  const canEdit = onCommit !== undefined;

  if (!canEdit) {
    return (
      <div className="rp-value" data-variant={variant}>
        <ValueCell attribute={attribute} value={value} />
      </div>
    );
  }

  if (attribute.type === "toggle") {
    const isChecked = value === true;
    return (
      <button
        type="button"
        className="rp-value rp-value-button"
        aria-pressed={isChecked}
        aria-label={label}
        aria-busy={isPending}
        aria-disabled={isPending}
        onClick={() => {
          if (!isPending) onCommit(!isChecked);
        }}
      >
        <ToggleGlyph isChecked={isChecked} />
        <span>{isChecked ? "Yes" : "No"}</span>
      </button>
    );
  }

  if (isEditing) {
    return (
      <div className="rp-value" data-variant={variant} data-editing="true">
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

  const isLinkValue =
    LINK_TYPES.includes(attribute.type) && !isEmptyValue(value);
  if (isLinkValue) {
    return (
      <div
        className="rp-value rp-value--with-link"
        data-pending={isPending ? "true" : "false"}
        aria-busy={isPending}
      >
        <ValueCell attribute={attribute} value={value} />
        <button
          ref={triggerRef}
          type="button"
          className="dr-icon-button"
          aria-label={`Edit ${label}`}
          aria-disabled={isPending}
          onClick={startIfIdle}
        >
          <EditPencil aria-hidden="true" focusable="false" />
        </button>
      </div>
    );
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      className="rp-value rp-value-button"
      data-variant={variant}
      data-pending={isPending ? "true" : "false"}
      aria-busy={isPending}
      aria-disabled={isPending}
      onClick={startIfIdle}
    >
      {/* Text, not aria-label: a label would hide the value itself. */}
      <span className="sr-only">Edit {label}: </span>
      <ValueCell attribute={attribute} value={value} />
    </button>
  );
}
