import { useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "iconoir-react";

import type {
  AttributeDefinition,
  DataRecord,
  ObjectType,
  RecordRef,
} from "../../../api/dataspaces";
import { RecordPicker } from "../records/RecordPicker";
import { RelationshipChip } from "../records/RelationshipChip";
import { holdsOne, relationshipAttributes } from "../records/recordModel";
import {
  type RelationshipEdit,
  useRelationshipEdit,
} from "../records/useRelationshipEdit";
import { objectTypeIcon } from "../values/attributeTypeIcon";

import "../../../styles/data-record.css";

export const RELATIONSHIP_CAP = 12;

export interface RecordRelationshipsProps {
  spaceId: string;
  record: DataRecord;
  recordName: string;
  type: ObjectType;
  objectTypes: readonly ObjectType[];
  isEditable?: boolean;
}

interface RelationshipSectionProps {
  spaceId: string;
  record: DataRecord;
  recordName: string;
  attribute: AttributeDefinition;
  targetType: ObjectType | undefined;
  isEditable: boolean;
}

interface LinkedRecordsProps {
  listId: string;
  spaceId: string;
  linked: readonly RecordRef[];
  ownerName: string;
  emptyLabel: string;
  disabled: boolean;
  onUnlink?: (targetId: string) => void;
}

function LinkedRecords({
  listId,
  spaceId,
  linked,
  ownerName,
  emptyLabel,
  disabled,
  onUnlink,
}: LinkedRecordsProps) {
  if (linked.length === 0) {
    return <p className="rp-note">No {emptyLabel} linked yet.</p>;
  }
  return (
    <ul id={listId} className="rp-relationship-list">
      {linked.map((target) => (
        <li key={target.id}>
          <RelationshipChip
            spaceId={spaceId}
            target={target}
            ownerName={ownerName}
            disabled={disabled}
            onUnlink={onUnlink ? () => onUnlink(target.id) : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

interface SectionPickerProps {
  spaceId: string;
  attribute: AttributeDefinition;
  targetType: ObjectType;
  linked: readonly RecordRef[];
  edit: RelationshipEdit;
}

/** "+ Link Firm", or "Change Firm" when a to-one attribute is already set. */
function SectionPicker({
  spaceId,
  attribute,
  targetType,
  linked,
  edit,
}: SectionPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const closeOnSuccess = (didLink: boolean) => {
    if (didLink) setIsOpen(false);
  };
  const linkVerb = holdsOne(attribute) && linked.length > 0 ? "Change" : "Link";
  return (
    <RecordPicker
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) edit.dismissConflict();
      }}
      triggerLabel={`${linkVerb} ${targetType.name} for ${attribute.name}`}
      triggerClassName="rp-text-button"
      spaceId={spaceId}
      targetType={targetType}
      excludeIds={linked.map((target) => target.id)}
      isPending={edit.isPending}
      conflict={edit.conflict}
      onPick={(target) => {
        void edit.link(target.id).then(closeOnSuccess);
      }}
      onMoveHere={() => {
        void edit.moveHere().then(closeOnSuccess);
      }}
      onDismissConflict={edit.dismissConflict}
    >
      <Plus aria-hidden="true" focusable="false" />
      {linkVerb} {targetType.name}
    </RecordPicker>
  );
}

function RelationshipSection({
  spaceId,
  record,
  recordName,
  attribute,
  targetType,
  isEditable,
}: RelationshipSectionProps) {
  const headingId = useId();
  const listId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const linked = record.links[attribute.slug] ?? [];
  const edit = useRelationshipEdit({
    spaceId,
    recordId: record.id,
    typeId: record.typeId,
    attribute,
    linked,
  });
  const shown = isExpanded ? linked : linked.slice(0, RELATIONSHIP_CAP);
  const canEdit = isEditable && targetType !== undefined;
  const TargetIcon = targetType ? objectTypeIcon(targetType.icon) : null;

  return (
    <section
      className="rp-relationship"
      aria-labelledby={headingId}
      data-pending={edit.isPending ? "true" : "false"}
      aria-busy={edit.isPending}
      data-testid={`data-relationship-${attribute.slug}`}
    >
      <header className="rp-relationship-head">
        <h3 id={headingId} className="rp-relationship-title">
          {attribute.name}
          <span className="dr-count">
            {linked.length}
            <span className="sr-only"> linked</span>
          </span>
        </h3>
        {targetType ? (
          <Link
            className="rp-relationship-target"
            to="/data/$spaceId/t/$typeSlug"
            params={{ spaceId, typeSlug: targetType.slug }}
          >
            {TargetIcon ? (
              <TargetIcon aria-hidden="true" focusable="false" />
            ) : null}
            {targetType.namePlural}
          </Link>
        ) : null}
      </header>
      <LinkedRecords
        listId={listId}
        spaceId={spaceId}
        linked={shown}
        ownerName={recordName}
        emptyLabel={(targetType?.namePlural ?? "records").toLowerCase()}
        disabled={edit.isPending}
        onUnlink={
          canEdit
            ? (targetId) => {
                void edit.unlink(targetId);
              }
            : undefined
        }
      />
      <div className="rp-relationship-foot">
        {linked.length > RELATIONSHIP_CAP ? (
          <button
            type="button"
            className="rp-text-button"
            aria-expanded={isExpanded}
            aria-controls={listId}
            onClick={() => setIsExpanded((current) => !current)}
          >
            {isExpanded
              ? `Show first ${RELATIONSHIP_CAP}`
              : `Show all ${linked.length.toLocaleString()}`}
          </button>
        ) : null}
        {canEdit && targetType ? (
          <SectionPicker
            spaceId={spaceId}
            attribute={attribute}
            targetType={targetType}
            linked={linked}
            edit={edit}
          />
        ) : null}
      </div>
    </section>
  );
}

/** One subsection per relationship attribute, in schema order. */
export function RecordRelationships({
  spaceId,
  record,
  recordName,
  type,
  objectTypes,
  isEditable = true,
}: RecordRelationshipsProps) {
  const headingId = useId();
  const attributes = relationshipAttributes(type);
  return (
    <section className="rp-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="rp-section-title">
        Relationships
      </h2>
      {attributes.length === 0 ? (
        <p className="rp-note">
          {type.name} is not related to any other object type yet.
        </p>
      ) : (
        attributes.map((attribute) => (
          <RelationshipSection
            key={attribute.slug}
            spaceId={spaceId}
            record={record}
            recordName={recordName}
            attribute={attribute}
            targetType={objectTypes.find(
              (item) => item.id === attribute.relationship?.targetTypeId,
            )}
            isEditable={isEditable}
          />
        ))
      )}
    </section>
  );
}
