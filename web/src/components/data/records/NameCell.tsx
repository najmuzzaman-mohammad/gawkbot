import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { EditPencil, SidebarExpand } from "iconoir-react";

import type {
  AttributeDefinition,
  AttributeValue,
} from "../../../api/dataspaces";
import { useEditLifecycle } from "../values/useEditLifecycle";
import { ValueField } from "../values/ValueField";
import { draftToValue, valueToDraft } from "../values/valueFormat";
import { focusIsUnclaimed } from "./focus";

import "../../../styles/data-records.css";

export interface NameCellProps {
  spaceId: string;
  recordId: string;
  /** The primary attribute; its editor is reused for the rename. */
  attribute: AttributeDefinition;
  value: AttributeValue | undefined;
  /** Display name, already falling back to "Untitled". */
  name: string;
  onPreview: (recordId: string) => void;
  /** Withhold for a read-only name. */
  onRename?: (next: AttributeValue | null) => void;
  isPending?: boolean;
}

/**
 * The primary column. The name is a real link to the record page, so middle
 * click, copy link, and the keyboard all work; the row itself has no click
 * handler. "Preview" opens the peek drawer. Rename is F2 on the link or the
 * pencil button, never a double click, which would fight the link.
 */
export function NameCell({
  spaceId,
  recordId,
  attribute,
  value,
  name,
  onPreview,
  onRename,
  isPending = false,
}: NameCellProps) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const wasEditingRef = useRef(false);

  const commitDraft = useCallback(
    (nextDraft: string) => onRename?.(draftToValue(attribute, nextDraft)),
    [attribute, onRename],
  );
  const { isEditing, draft, setDraft, start, commit, cancel } =
    useEditLifecycle({
      initialDraft: valueToDraft(attribute, value),
      onCommit: commitDraft,
    });
  const canRename = onRename !== undefined && !isPending;

  // The editor unmounts on commit or cancel, which drops focus to <body>.
  // Hand it back to the link, unless the edit ended because the user moved
  // to another control, which by now holds focus and should keep it.
  useEffect(() => {
    if (isEditing) {
      wasEditingRef.current = true;
      return;
    }
    if (!wasEditingRef.current) return;
    wasEditingRef.current = false;
    if (focusIsUnclaimed()) linkRef.current?.focus();
  }, [isEditing]);

  const handleLinkKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== "F2" || !canRename) return;
    event.preventDefault();
    start();
  };

  if (isEditing) {
    return (
      <div className="dr-name-cell" data-editing="true">
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
      className="dr-name-cell"
      data-pending={isPending ? "true" : "false"}
      aria-busy={isPending}
    >
      <Link
        ref={linkRef}
        className="dr-name-link"
        to="/data/$spaceId/r/$recordId"
        params={{ spaceId, recordId }}
        title={name}
        onKeyDown={handleLinkKeyDown}
      >
        {name}
      </Link>
      <span className="dr-name-tools">
        {onRename ? (
          <button
            type="button"
            className="dr-icon-button"
            aria-label={`Rename ${name}`}
            aria-keyshortcuts="F2"
            disabled={!canRename}
            onClick={start}
          >
            <EditPencil aria-hidden="true" focusable="false" />
          </button>
        ) : null}
        <button
          type="button"
          className="dr-preview-chip"
          onClick={() => onPreview(recordId)}
        >
          <SidebarExpand aria-hidden="true" focusable="false" />
          Preview
          <span className="sr-only"> {name}</span>
        </button>
      </span>
    </div>
  );
}
