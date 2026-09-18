import { useState } from "react";
import { Plus } from "iconoir-react";

import type {
  AttributeDefinition,
  DataRecord,
  ObjectType,
} from "../../../api/dataspaces";
import { RecordPicker } from "./RecordPicker";
import { RelationshipChip } from "./RelationshipChip";
import { useRelationshipEdit } from "./useRelationshipEdit";

import "../../../styles/data-records.css";

const MAX_CELL_CHIPS = 3;

export interface RelationshipCellProps {
  spaceId: string;
  record: DataRecord;
  recordName: string;
  attribute: AttributeDefinition;
  /** The object type on the other end; undefined while it cannot be resolved. */
  targetType: ObjectType | undefined;
  /** Read-only when false: chips stay links, the controls are withheld. */
  isEditable?: boolean;
}

/**
 * A relationship attribute in the records table: chips for the linked
 * records, an unlink button on each, and a "+" that opens the record picker.
 * Writes are not optimistic; the cell dims while the store answers.
 */
export function RelationshipCell({
  spaceId,
  record,
  recordName,
  attribute,
  targetType,
  isEditable = true,
}: RelationshipCellProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const linked = record.links[attribute.slug] ?? [];
  const edit = useRelationshipEdit({
    spaceId,
    recordId: record.id,
    typeId: record.typeId,
    attribute,
    linked,
  });
  const shown = linked.slice(0, MAX_CELL_CHIPS);
  const overflow = linked.length - shown.length;
  const canEdit = isEditable && targetType !== undefined;

  const closeOnSuccess = (didLink: boolean) => {
    if (didLink) setIsPickerOpen(false);
  };

  return (
    <div
      className="dr-rel-cell"
      data-pending={edit.isPending ? "true" : "false"}
      aria-busy={edit.isPending}
    >
      {shown.map((target) => (
        <RelationshipChip
          key={target.id}
          spaceId={spaceId}
          target={target}
          ownerName={recordName}
          disabled={edit.isPending}
          onUnlink={canEdit ? () => void edit.unlink(target.id) : undefined}
        />
      ))}
      {overflow > 0 ? (
        <span className="dr-chip-overflow">and {overflow} more</span>
      ) : null}
      {canEdit && targetType ? (
        <RecordPicker
          open={isPickerOpen}
          onOpenChange={(open) => {
            setIsPickerOpen(open);
            if (!open) edit.dismissConflict();
          }}
          triggerLabel={`Link ${attribute.name} to ${recordName}`}
          triggerClassName="dr-icon-button dr-rel-add"
          spaceId={spaceId}
          targetType={targetType}
          excludeIds={linked.map((target) => target.id)}
          isPending={edit.isPending}
          conflict={edit.conflict}
          onPick={(target) => void edit.link(target.id).then(closeOnSuccess)}
          onMoveHere={() => void edit.moveHere().then(closeOnSuccess)}
          onDismissConflict={edit.dismissConflict}
        >
          <Plus aria-hidden="true" focusable="false" />
        </RecordPicker>
      ) : null}
    </div>
  );
}
