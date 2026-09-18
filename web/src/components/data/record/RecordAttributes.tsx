import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "iconoir-react";

import type {
  AttributeDefinition,
  AttributeValue,
  DataRecord,
  ObjectType,
} from "../../../api/dataspaces";
import { valueAttributes } from "../records/recordModel";
import {
  isPendingValue,
  type PendingValueTarget,
} from "../records/useValueCommit";
import { AttributeTypeIcon } from "../values/attributeTypeIcon";
import { isEmptyValue } from "../values/valueFormat";
import { InPlaceValue } from "./InPlaceValue";

import "../../../styles/data-record.css";

export interface RecordAttributesProps {
  record: DataRecord;
  type: ObjectType;
  pendingValue: PendingValueTarget | null;
  /** Withhold for a read-only record. */
  onCommit?: (slug: string, next: AttributeValue | null) => void;
}

/** A toggle always reads as Yes or No, so it is never "empty". */
function isFilled(attribute: AttributeDefinition, record: DataRecord): boolean {
  return (
    attribute.type === "toggle" || !isEmptyValue(record.values[attribute.slug])
  );
}

/**
 * The record's own attributes (the name lives in the header; relationships
 * have their own section). Filled attributes form a 2-up grid and are edited
 * where they stand. Empty ones collapse into a strip of "+ Name" buttons;
 * pressing one opens that attribute's editor in the grid.
 */
export function RecordAttributes({
  record,
  type,
  pendingValue,
  onCommit,
}: RecordAttributesProps) {
  const titleId = useId();
  const emptyLabelId = useId();
  const [addingSlug, setAddingSlug] = useState<string | null>(null);
  const [returnFocusSlug, setReturnFocusSlug] = useState<string | null>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());

  const attributes = valueAttributes(type).filter(
    (attribute) => !attribute.isPrimary,
  );
  const shown = attributes.filter(
    (attribute) =>
      isFilled(attribute, record) ||
      attribute.slug === addingSlug ||
      isPendingValue(pendingValue, record.id, attribute.slug),
  );
  const empty = attributes.filter((attribute) => !shown.includes(attribute));

  // A cancelled "+ Phone" puts its chip back; focus goes back with it.
  useEffect(() => {
    if (returnFocusSlug === null) return;
    chipRefs.current.get(returnFocusSlug)?.focus();
    setReturnFocusSlug(null);
  }, [returnFocusSlug]);

  if (attributes.length === 0) {
    return (
      <section className="rp-section" aria-labelledby={titleId}>
        <h2 id={titleId} className="rp-section-title">
          Attributes
        </h2>
        <p className="rp-note">
          {type.name} has no attributes besides its name yet.
        </p>
      </section>
    );
  }

  return (
    <section className="rp-section" aria-labelledby={titleId}>
      <h2 id={titleId} className="rp-section-title">
        Attributes
      </h2>
      {shown.length > 0 ? (
        <dl className="rp-attribute-grid">
          {shown.map((attribute) => (
            <div key={attribute.slug} className="rp-attribute">
              <dt className="rp-attribute-label">
                <AttributeTypeIcon type={attribute.type} />
                {attribute.name}
              </dt>
              <dd className="rp-attribute-value">
                <InPlaceValue
                  attribute={attribute}
                  value={record.values[attribute.slug]}
                  isPending={isPendingValue(
                    pendingValue,
                    record.id,
                    attribute.slug,
                  )}
                  startInEditMode={attribute.slug === addingSlug}
                  onEditEnd={() => {
                    if (attribute.slug !== addingSlug) return;
                    setAddingSlug(null);
                    setReturnFocusSlug(attribute.slug);
                  }}
                  onCommit={
                    onCommit
                      ? (next) => onCommit(attribute.slug, next)
                      : undefined
                  }
                />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {empty.length > 0 ? (
        <div className="rp-empty-strip">
          <span className="rp-empty-strip-label" id={emptyLabelId}>
            Empty
          </span>
          <ul className="rp-empty-chips" aria-labelledby={emptyLabelId}>
            {empty.map((attribute) => (
              <li key={attribute.slug}>
                {onCommit ? (
                  <button
                    ref={(node) => {
                      if (node) chipRefs.current.set(attribute.slug, node);
                      else chipRefs.current.delete(attribute.slug);
                    }}
                    type="button"
                    className="rp-empty-chip"
                    aria-label={`Add ${attribute.name}`}
                    onClick={() => setAddingSlug(attribute.slug)}
                  >
                    <Plus aria-hidden="true" focusable="false" />
                    {attribute.name}
                  </button>
                ) : (
                  <span className="rp-empty-chip" data-static="true">
                    {attribute.name}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
