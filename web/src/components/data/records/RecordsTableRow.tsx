import { Link } from "@tanstack/react-router";
import type { Row } from "@tanstack/react-table";
import { OpenNewWindow, SidebarExpand, Trash } from "iconoir-react";

import type {
  AttributeValue,
  DataRecord,
  ObjectType,
} from "../../../api/dataspaces";
import { EditableValueCell } from "../values/EditableValueCell";
import { NameCell } from "./NameCell";
import { RelationshipCell } from "./RelationshipCell";
import {
  absoluteTimeLabel,
  recordName,
  relativeTimeLabel,
} from "./recordModel";
import type { ColumnDescriptor } from "./useRecordsTable";
import { isPendingValue, type PendingValueTarget } from "./useValueCommit";

export interface RecordsTableRowProps {
  spaceId: string;
  type: ObjectType;
  objectTypes: readonly ObjectType[];
  row: Row<DataRecord>;
  descriptors: ReadonlyMap<string, ColumnDescriptor>;
  pendingValue: PendingValueTarget | null;
  onCommitValue: (
    record: DataRecord,
    slug: string,
    next: AttributeValue | null,
  ) => void;
  onPreview: (recordId: string) => void;
  onDelete: (recordId: string) => void;
}

interface CellProps extends Omit<RecordsTableRowProps, "descriptors"> {
  descriptor: ColumnDescriptor;
  name: string;
}

function RecordCell({
  spaceId,
  objectTypes,
  row,
  descriptor,
  name,
  pendingValue,
  onCommitValue,
  onPreview,
  onDelete,
}: CellProps) {
  const record = row.original;
  switch (descriptor.kind) {
    case "select":
      return (
        <td className="dr-td dr-td--select">
          <input
            type="checkbox"
            className="dr-checkbox"
            aria-label={`Select ${name}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        </td>
      );
    case "name": {
      const { attribute } = descriptor;
      return (
        <td className="dr-td dr-td--name">
          <NameCell
            spaceId={spaceId}
            recordId={record.id}
            attribute={attribute}
            value={record.values[attribute.slug]}
            name={name}
            onPreview={onPreview}
            isPending={isPendingValue(pendingValue, record.id, attribute.slug)}
            onRename={(next) => onCommitValue(record, attribute.slug, next)}
          />
        </td>
      );
    }
    case "attribute": {
      const { attribute } = descriptor;
      if (attribute.type === "relationship") {
        const targetTypeId = attribute.relationship?.targetTypeId;
        return (
          <td className="dr-td">
            <RelationshipCell
              spaceId={spaceId}
              record={record}
              recordName={name}
              attribute={attribute}
              targetType={objectTypes.find((item) => item.id === targetTypeId)}
            />
          </td>
        );
      }
      return (
        // The value cell brings its own `gridcell`; the <td> steps aside so
        // the row owns exactly one cell role per column.
        <td className="dr-td dr-td--value" role="presentation">
          <EditableValueCell
            attribute={attribute}
            value={record.values[attribute.slug]}
            isPending={isPendingValue(pendingValue, record.id, attribute.slug)}
            onCommit={(next) => onCommitValue(record, attribute.slug, next)}
          />
        </td>
      );
    }
    case "updated":
      return (
        <td className="dr-td dr-td--updated">
          <time
            dateTime={record.updatedAt}
            title={absoluteTimeLabel(record.updatedAt)}
          >
            {relativeTimeLabel(record.updatedAt)}
          </time>
        </td>
      );
    case "actions":
      return (
        <td className="dr-td dr-td--actions">
          <div className="dr-row-actions">
            <button
              type="button"
              className="dr-icon-button"
              aria-label={`Preview ${name}`}
              onClick={() => onPreview(record.id)}
            >
              <SidebarExpand aria-hidden="true" focusable="false" />
            </button>
            <Link
              className="dr-icon-button"
              to="/data/$spaceId/r/$recordId"
              params={{ spaceId, recordId: record.id }}
              aria-label={`Open record ${name}`}
            >
              <OpenNewWindow aria-hidden="true" focusable="false" />
            </Link>
            <button
              type="button"
              className="dr-icon-button dr-icon-button--danger"
              aria-label={`Delete ${name}`}
              onClick={() => onDelete(record.id)}
            >
              <Trash aria-hidden="true" focusable="false" />
            </button>
          </div>
        </td>
      );
    default: {
      const _exhaustive: never = descriptor;
      void _exhaustive;
      return null;
    }
  }
}

/** One record. The row has no click handler; every action is a real control. */
export function RecordsTableRow({
  descriptors,
  ...props
}: RecordsTableRowProps) {
  const { row, type } = props;
  const name = recordName(row.original, type);
  return (
    <tr
      className="dr-tr"
      aria-selected={row.getIsSelected()}
      data-selected={row.getIsSelected() ? "true" : "false"}
      data-testid="data-record-row"
    >
      {row.getVisibleCells().map((cell) => {
        const descriptor = descriptors.get(cell.column.id);
        if (!descriptor) return null;
        return (
          <RecordCell
            key={cell.id}
            {...props}
            descriptor={descriptor}
            name={name}
          />
        );
      })}
    </tr>
  );
}
