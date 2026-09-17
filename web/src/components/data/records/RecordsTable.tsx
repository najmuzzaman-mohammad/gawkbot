import { useEffect, useRef } from "react";
import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";

import type {
  AttributeValue,
  DataRecord,
  ObjectType,
  SortDirection,
} from "../../../api/dataspaces";
import { AddColumnButton } from "./AddColumnButton";
import { ColumnHeader } from "./ColumnHeader";
import { canMoveColumn } from "./columnPrefs";
import { RecordsTableRow } from "./RecordsTableRow";
import type { ColumnPrefsControls } from "./useColumnPrefs";
import {
  type ColumnDescriptor,
  UPDATED_COLUMN_ID,
  useRecordsTable,
} from "./useRecordsTable";
import type { PendingValueTarget } from "./useValueCommit";

import "../../../styles/data-records.css";

export interface TableSort {
  attribute: string;
  direction: SortDirection;
}

export interface RecordsTableProps {
  spaceId: string;
  type: ObjectType;
  /** Every object type in the space, to resolve relationship targets. */
  objectTypes: readonly ObjectType[];
  records: readonly DataRecord[];
  sort: TableSort | null;
  onSort: (attribute: string, direction: SortDirection) => void;
  columnPrefs: ColumnPrefsControls;
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  pendingValue: PendingValueTarget | null;
  onCommitValue: (
    record: DataRecord,
    slug: string,
    next: AttributeValue | null,
  ) => void;
  onPreview: (recordId: string) => void;
  onDelete: (recordId: string) => void;
  /** A new sort, filter, or page is loading over the rows on screen. */
  isFetching?: boolean;
}

interface SelectAllProps {
  isChecked: boolean;
  isIndeterminate: boolean;
  onToggle: (isChecked: boolean) => void;
}

function SelectAllCheckbox({
  isChecked,
  isIndeterminate,
  onToggle,
}: SelectAllProps) {
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` is a DOM property with no attribute form.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = isIndeterminate;
  }, [isIndeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="dr-checkbox"
      aria-label="Select every row on this page"
      checked={isChecked}
      onChange={(event) => onToggle(event.target.checked)}
    />
  );
}

function ariaSort(
  sort: TableSort | null,
  columnId: string,
): "ascending" | "descending" | undefined {
  if (sort?.attribute !== columnId) return undefined;
  return sort.direction === "asc" ? "ascending" : "descending";
}

/**
 * `<table role="grid">` is sanctioned by ARIA in HTML, and the value cells
 * are `gridcell`s that need a `grid` ancestor. Biome's
 * noNoninteractiveElementToInteractiveRole does not know that pairing and
 * would have the table become a div, so the role is applied from here.
 */
const GRID_ROLE = { role: "grid", "aria-multiselectable": true } as const;

const HEADER_CLASS: Readonly<Record<ColumnDescriptor["kind"], string>> = {
  select: "dr-th dr-th--select",
  name: "dr-th dr-th--name",
  attribute: "dr-th",
  updated: "dr-th dr-th--updated",
  actions: "dr-th dr-th--actions",
};

/**
 * The records grid. A real <table role="grid"> inside its own scroll
 * container, so the page never scrolls sideways. Select and name stick to
 * the start, row actions to the end; everything between them scrolls.
 */
export function RecordsTable({
  spaceId,
  type,
  objectTypes,
  records,
  sort,
  onSort,
  columnPrefs,
  rowSelection,
  onRowSelectionChange,
  pendingValue,
  onCommitValue,
  onPreview,
  onDelete,
  isFetching = false,
}: RecordsTableProps) {
  const { prefs } = columnPrefs;
  const { table, descriptors, hiddenAttributes } = useRecordsTable({
    type,
    records,
    prefs,
    rowSelection,
    onRowSelectionChange,
  });
  const sortedDirection = (columnId: string) =>
    sort?.attribute === columnId ? sort.direction : undefined;

  const renderHeader = (columnId: string, descriptor: ColumnDescriptor) => {
    switch (descriptor.kind) {
      case "select":
        return (
          <SelectAllCheckbox
            isChecked={table.getIsAllRowsSelected()}
            isIndeterminate={table.getIsSomeRowsSelected()}
            onToggle={(isChecked) => table.toggleAllRowsSelected(isChecked)}
          />
        );
      case "name":
        return (
          <ColumnHeader
            label={descriptor.attribute.name}
            attributeType={descriptor.attribute.type}
            sortedDirection={sortedDirection(columnId)}
            onSort={(direction) => onSort(columnId, direction)}
          />
        );
      case "attribute": {
        const { attribute } = descriptor;
        return (
          <ColumnHeader
            label={attribute.name}
            attributeType={attribute.type}
            sortedDirection={sortedDirection(columnId)}
            onSort={
              attribute.type === "relationship"
                ? undefined
                : (direction) => onSort(columnId, direction)
            }
            onMove={(direction) => columnPrefs.move(columnId, direction)}
            canMoveLeft={canMoveColumn(prefs, columnId, "left")}
            canMoveRight={canMoveColumn(prefs, columnId, "right")}
            onHide={() => columnPrefs.hide(columnId)}
          />
        );
      }
      case "updated":
        return (
          <ColumnHeader
            label="Updated"
            sortedDirection={sortedDirection(UPDATED_COLUMN_ID)}
            onSort={(direction) => onSort(UPDATED_COLUMN_ID, direction)}
          />
        );
      case "actions":
        return (
          <div className="dr-th-actions">
            <span className="sr-only">Row actions</span>
            <AddColumnButton
              spaceId={spaceId}
              typeSlug={type.slug}
              hiddenAttributes={hiddenAttributes}
              onShow={columnPrefs.show}
            />
          </div>
        );
      default: {
        const _exhaustive: never = descriptor;
        void _exhaustive;
        return null;
      }
    }
  };

  return (
    <div className="dr-table-scroll" data-testid="data-records-scroll">
      <table
        className="dr-table"
        {...GRID_ROLE}
        aria-label={type.namePlural}
        aria-busy={isFetching}
        data-testid="data-records-table"
      >
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="dr-tr dr-tr--head">
              {group.headers.map((header) => {
                const descriptor = descriptors.get(header.column.id);
                if (!descriptor) return null;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    className={HEADER_CLASS[descriptor.kind]}
                    aria-sort={ariaSort(sort, header.column.id)}
                    data-column={header.column.id}
                  >
                    {renderHeader(header.column.id, descriptor)}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <RecordsTableRow
              key={row.id}
              spaceId={spaceId}
              type={type}
              objectTypes={objectTypes}
              row={row}
              descriptors={descriptors}
              pendingValue={pendingValue}
              onCommitValue={onCommitValue}
              onPreview={onPreview}
              onDelete={onDelete}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
