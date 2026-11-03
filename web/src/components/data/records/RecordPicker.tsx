import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { Popover } from "@base-ui/react/popover";

import type { ObjectType, RecordRef } from "../../../api/dataspaces";
import { useRecordPage } from "../../../hooks/useDataSpaces";
import { Button } from "../DataButton";
import { recordName } from "./recordModel";
import { useDebouncedValue } from "./useDebouncedValue";
import type { LinkConflict } from "./useRelationshipEdit";

import "../../../styles/data-records.css";

const SEARCH_DEBOUNCE_MS = 250;
const RESULT_LIMIT = 20;
const MAX_QUERY_LIMIT = 100;

export interface RecordPickerListProps {
  spaceId: string;
  targetType: ObjectType;
  /** Already linked; never offered again. */
  excludeIds: readonly string[];
  onPick: (target: RecordRef) => void;
  isPending?: boolean;
  conflict?: LinkConflict | null;
  onMoveHere?: () => void;
  onDismissConflict?: () => void;
}

/**
 * Search box over the TARGET object type plus a listbox of matches. Focus
 * stays in the input; arrow keys move the active option and Enter picks it,
 * which is the combobox pattern and needs no roving tabindex.
 */
export function RecordPickerList({
  spaceId,
  targetType,
  excludeIds,
  onPick,
  isPending = false,
  conflict = null,
  onMoveHere,
  onDismissConflict,
}: RecordPickerListProps) {
  const listId = useId();
  const [text, setText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const query = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  // Linked records are filtered out client side, so ask for that many more.
  const limit = Math.min(MAX_QUERY_LIMIT, RESULT_LIMIT + excludeIds.length);
  const page = useRecordPage(spaceId, {
    typeId: targetType.id,
    ...(query === "" ? {} : { query }),
    limit,
    offset: 0,
  });

  const excluded = new Set(excludeIds);
  const options: readonly RecordRef[] = (page.data?.records ?? [])
    .filter((record) => !excluded.has(record.id))
    .slice(0, RESULT_LIMIT)
    .map((record) => ({
      id: record.id,
      typeId: record.typeId,
      name: recordName(record, targetType),
    }));
  const active = options[Math.min(activeIndex, options.length - 1)];

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        (current) =>
          (Math.min(current, options.length - 1) + step + options.length) %
          options.length,
      );
    } else if (event.key === "Enter" && active && !isPending) {
      event.preventDefault();
      onPick(active);
    }
  };

  const optionId = (id: string) => `${listId}-${id}`;
  const plural = targetType.namePlural.toLowerCase();

  return (
    <div className="dr-picker" data-testid="data-record-picker">
      {conflict ? (
        <div className="dr-picker-conflict" role="alert">
          <p>{conflict.message}</p>
          <div className="dr-picker-conflict-actions">
            <Button size="sm" onClick={onMoveHere} disabled={isPending}>
              Move it here
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismissConflict}>
              Leave it
            </Button>
          </div>
        </div>
      ) : null}
      <input
        className="dr-picker-input"
        type="text"
        role="combobox"
        aria-expanded={true}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active.id) : undefined}
        aria-label={`Search ${plural}`}
        placeholder={`Search ${plural}`}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={handleKeyDown}
      />
      <div
        id={listId}
        className="dr-picker-list"
        role="listbox"
        aria-label={targetType.namePlural}
        aria-busy={page.isFetching}
      >
        {options.map((option) => (
          // A button with role="option": focus stays on the input (the
          // combobox pattern), so options are clickable but not tab stops.
          <button
            key={option.id}
            id={optionId(option.id)}
            type="button"
            className="dr-picker-option"
            role="option"
            tabIndex={-1}
            aria-selected={option.id === active?.id}
            disabled={isPending}
            onPointerMove={() => setActiveIndex(options.indexOf(option))}
            onClick={() => onPick(option)}
          >
            {option.name}
          </button>
        ))}
      </div>
      {options.length === 0 ? (
        <p className="dr-picker-empty" role="status">
          {page.isPending
            ? "Searching"
            : page.isError
              ? "Search failed. Try again."
              : text.trim() === ""
                ? `No ${plural} left to link.`
                : `No ${plural} match.`}
        </p>
      ) : null}
    </div>
  );
}

export interface RecordPickerProps extends RecordPickerListProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the trigger, e.g. "Link Firm to Mirela Okonjo-Hart". */
  triggerLabel: string;
  triggerClassName?: string;
  children: ReactNode;
}

/**
 * The picker in a portalled popover, so a table's scroll container and sticky
 * columns never clip it. Escape and outside click close it and hand focus
 * back to the trigger.
 */
export function RecordPicker({
  open,
  onOpenChange,
  triggerLabel,
  triggerClassName = "dr-icon-button",
  children,
  ...listProps
}: RecordPickerProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {/* Never disabled: closing the popover returns focus here, and a
          disabled trigger could not take it. The list blocks picks itself. */}
      <Popover.Trigger className={triggerClassName} aria-label={triggerLabel}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="dr-popover-positioner"
          align="start"
          sideOffset={4}
        >
          <Popover.Popup className="dr-popover" aria-label={triggerLabel}>
            <RecordPickerList {...listProps} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
