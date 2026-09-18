import { Link } from "@tanstack/react-router";

import type { DataRecord, ObjectType } from "../../../api/dataspaces";
import { useDataRecord } from "../../../hooks/useDataSpaces";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../ui/Sheet";
import { BotByline } from "../BotByline";
import { AttributeTypeIcon, objectTypeIcon } from "../values/attributeTypeIcon";
import { ValueCell } from "../values/ValueCell";
import { isEmptyValue } from "../values/valueFormat";
import { RelationshipChip } from "./RelationshipChip";
import {
  recordName,
  relationshipAttributes,
  valueAttributes,
} from "./recordModel";

import "../../../styles/data-records.css";

export const PEEK_MAX_ATTRIBUTES = 8;
export const PEEK_MAX_CHIPS = 5;

export interface PeekDrawerProps {
  spaceId: string;
  /** The `peek` search param. Null keeps the drawer closed. */
  recordId: string | null;
  objectTypes: readonly ObjectType[];
  onClose: () => void;
}

interface PeekBodyProps {
  spaceId: string;
  record: DataRecord;
  type: ObjectType;
}

function PeekBody({ spaceId, record, type }: PeekBodyProps) {
  const filled = valueAttributes(type)
    .filter(
      (attribute) =>
        !(attribute.isPrimary || isEmptyValue(record.values[attribute.slug])),
    )
    .slice(0, PEEK_MAX_ATTRIBUTES);
  const relationships = relationshipAttributes(type).filter(
    (attribute) => (record.links[attribute.slug] ?? []).length > 0,
  );

  return (
    <div className="dr-peek-body">
      {filled.length > 0 ? (
        <dl className="dr-peek-attributes">
          {filled.map((attribute) => (
            <div key={attribute.slug} className="dr-peek-attribute">
              <dt>
                <AttributeTypeIcon type={attribute.type} />
                {attribute.name}
              </dt>
              <dd>
                <ValueCell
                  attribute={attribute}
                  value={record.values[attribute.slug]}
                />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="dr-peek-note">No attributes are filled in yet.</p>
      )}
      {relationships.map((attribute) => {
        const linked = record.links[attribute.slug] ?? [];
        const overflow = linked.length - PEEK_MAX_CHIPS;
        return (
          <section key={attribute.slug} className="dr-peek-section">
            <h3 className="dr-peek-section-title">
              {attribute.name}
              <span className="dr-count">{linked.length}</span>
            </h3>
            <div className="dr-chip-list">
              {linked.slice(0, PEEK_MAX_CHIPS).map((target) => (
                <RelationshipChip
                  key={target.id}
                  spaceId={spaceId}
                  target={target}
                />
              ))}
              {overflow > 0 ? (
                <span className="dr-chip-overflow">and {overflow} more</span>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Read-only preview of one record, from the right. Driven entirely by the
 * `peek` search param: closing (the button, the overlay, Escape) clears it.
 */
export function PeekDrawer({
  spaceId,
  recordId,
  objectTypes,
  onClose,
}: PeekDrawerProps) {
  const query = useDataRecord(spaceId, recordId);
  const record = query.data;
  const type = record
    ? objectTypes.find((item) => item.id === record.typeId)
    : undefined;
  const TypeIcon = type ? objectTypeIcon(type.icon) : null;

  return (
    <Sheet
      open={recordId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="dr-peek w-full sm:max-w-md"
        data-testid="data-peek"
      >
        {record && type ? (
          <>
            <SheetHeader className="dr-peek-header text-left">
              <SheetTitle className="dr-peek-title">
                {TypeIcon ? (
                  <TypeIcon aria-hidden="true" focusable="false" />
                ) : null}
                {recordName(record, type)}
              </SheetTitle>
              <SheetDescription className="dr-peek-meta">
                <span className="dr-type-badge">{type.name}</span>
                <BotByline actor={record.createdBy} />
              </SheetDescription>
            </SheetHeader>
            <PeekBody spaceId={spaceId} record={record} type={type} />
            <Link
              className="dr-peek-open"
              to="/data/$spaceId/r/$recordId"
              params={{ spaceId, recordId: record.id }}
            >
              Open full record
            </Link>
          </>
        ) : (
          <SheetHeader className="dr-peek-header text-left">
            <SheetTitle className="dr-peek-title">
              {query.isError ? "Record not found" : "Loading record"}
            </SheetTitle>
            <SheetDescription className="dr-peek-meta">
              {query.isError
                ? "It may have been deleted. Close this preview to go back to the table."
                : "One moment."}
            </SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}
