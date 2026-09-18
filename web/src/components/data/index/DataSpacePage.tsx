import { useState } from "react";
import { Link } from "@tanstack/react-router";

import type { DataSpace, ObjectType } from "../../../api/dataspaces";
import { useSpaceSchema } from "../../../hooks/useDataSpaces";
import { BotByline } from "../BotByline";
import { Button } from "../DataButton";
import { DataEmptyState } from "../DataEmptyState";
import { type DataCrumb, DataPageHeader } from "../DataPageHeader";
import {
  cardinalityModeLabel,
  cardinalityPlain,
} from "../settings/relationshipDefaults";
import { objectTypeIcon } from "../values/attributeTypeIcon";
import { AccessBadge } from "./AccessBadge";
import { CreateObjectTypeDialog } from "./CreateObjectTypeDialog";
import { ShareSpaceDialog } from "./ShareSpaceDialog";
import { SpaceLoadError } from "./SpaceLoadError";
import {
  type RelationshipPair,
  relatedTypeNames,
  relationshipPairs,
} from "./schemaSummary";

import "../../../styles/data-schema.css";

const ROOT_CRUMB: DataCrumb = { label: "Data", to: "/data" };

interface DataSpacePageProps {
  spaceId: string;
}

interface ObjectTypeRowProps {
  spaceId: string;
  type: ObjectType;
  objectTypes: readonly ObjectType[];
}

function ObjectTypeRow({ spaceId, type, objectTypes }: ObjectTypeRowProps) {
  const Icon = objectTypeIcon(type.icon);
  const related = relatedTypeNames(type, objectTypes);
  const params = { spaceId, typeSlug: type.slug };
  return (
    <tr>
      <th scope="row" className="data-list-name">
        <Link
          className="data-list-link data-list-link--icon"
          to="/data/$spaceId/t/$typeSlug"
          params={params}
        >
          <Icon aria-hidden="true" focusable="false" />
          {type.namePlural}
        </Link>
      </th>
      <td className="data-list-number">{type.recordCount.toLocaleString()}</td>
      <td className="data-list-number">
        {type.attributes.length.toLocaleString()}
      </td>
      <td>
        {related.length === 0 ? (
          <span className="data-list-muted">None</span>
        ) : (
          related.join(", ")
        )}
      </td>
      <td>
        <BotByline actor={type.createdBy} />
      </td>
      <td className="data-list-actions">
        <Link
          className="data-list-action"
          to="/data/$spaceId/t/$typeSlug/settings"
          params={params}
          search={{ tab: "general" }}
          aria-label={`Settings for ${type.namePlural}`}
        >
          Settings
        </Link>
        <Link
          className="data-list-action"
          to="/data/$spaceId/t/$typeSlug"
          params={params}
          aria-label={`Open ${type.namePlural}`}
        >
          Open
        </Link>
      </td>
    </tr>
  );
}

interface RelationshipLineProps {
  pair: RelationshipPair;
}

function RelationshipLine({ pair }: RelationshipLineProps) {
  return (
    <li className="data-relationship-line">
      <span>
        {pair.sourceType.name}
        {" . "}
        <span className="data-mono">{pair.sourceAttribute.slug}</span>
        {" -> "}
        {pair.targetType.name}
      </span>
      <span className="data-relationship-mode">
        ({cardinalityModeLabel(pair.cardinality)},{" "}
        {cardinalityPlain(pair.cardinality)})
      </span>
      <span className="data-relationship-inverse">
        {pair.inverseAttribute ? (
          <>
            inverse:{" "}
            <span className="data-mono">{pair.inverseAttribute.slug}</span>
          </>
        ) : (
          "no inverse attribute"
        )}
      </span>
    </li>
  );
}

interface SpaceSubtitleProps {
  space: DataSpace;
  canWrite: boolean;
}

/** Description, owner, sharing, and one quiet line when this is read only. */
function SpaceSubtitle({ space, canWrite }: SpaceSubtitleProps) {
  return (
    <>
      {space.description === "" ? null : (
        <span className="data-space-description">{space.description} </span>
      )}
      <span className="data-space-meta">
        <BotByline actor={space.owner} verb="Owned by" />
        <AccessBadge access={space.access} />
      </span>
      {canWrite ? null : (
        <span className="data-readonly-note">
          Read only. @{space.owner} owns this data space and granted read
          access.
        </span>
      )}
    </>
  );
}

interface NoObjectTypesProps {
  ownerSlug: string;
  /** Withheld when the caller may only read; there is then no action. */
  onCreate?: () => void;
}

function NoObjectTypes({ ownerSlug, onCreate }: NoObjectTypesProps) {
  const opening =
    "An object type is one kind of thing this space keeps records of.";
  return (
    <DataEmptyState
      title="No object types yet"
      body={
        onCreate
          ? `${opening} The owning bot usually adds them; you can add one too.`
          : `${opening} @${ownerSlug} owns this space and granted read access, so only that bot can add one.`
      }
      action={
        onCreate ? (
          <Button variant="outline" onClick={onCreate}>
            New object type
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * `/data/$spaceId`: the object types in one space, then a read-only summary
 * of how they relate. Relationships are edited from a type's Attributes tab.
 */
export function DataSpacePage({ spaceId }: DataSpacePageProps) {
  const schemaQuery = useSpaceSchema(spaceId);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);

  if (schemaQuery.isPending) {
    return (
      <>
        <DataPageHeader
          crumbs={[ROOT_CRUMB, { label: "Loading" }]}
          title="Data space"
        />
        <p className="data-page-status" aria-busy="true">
          Loading the data space…
        </p>
      </>
    );
  }

  if (schemaQuery.isError) {
    return <SpaceLoadError error={schemaQuery.error} />;
  }

  const { space, objectTypes, relationships } = schemaQuery.data;
  const pairs = relationshipPairs(objectTypes, relationships);
  // The capability is expressed by withholding the handlers, the way an
  // absent `onCommit` makes a value cell read-only: no disabled buttons that
  // look like they would work if only you tried harder.
  const canWrite = space.callerLevel !== "read";

  return (
    <>
      <DataPageHeader
        crumbs={[ROOT_CRUMB, { label: space.name }]}
        title={space.name}
        subtitle={<SpaceSubtitle space={space} canWrite={canWrite} />}
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setIsShareOpen(true)}>
                Share
              </Button>
              <Button onClick={() => setIsCreateOpen(true)}>
                New object type
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="data-page-body">
        {objectTypes.length === 0 ? (
          <NoObjectTypes
            ownerSlug={space.owner}
            onCreate={canWrite ? () => setIsCreateOpen(true) : undefined}
          />
        ) : (
          <section aria-label="Object types">
            <div className="data-list-scroll">
              <table className="data-list-table">
                <thead>
                  <tr>
                    <th scope="col">Object type</th>
                    <th scope="col" className="data-list-number">
                      Records
                    </th>
                    <th scope="col" className="data-list-number">
                      Attributes
                    </th>
                    <th scope="col">Related to</th>
                    <th scope="col">Created by</th>
                    <th scope="col">
                      <span className="data-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {objectTypes.map((type) => (
                    <ObjectTypeRow
                      key={type.id}
                      spaceId={spaceId}
                      type={type}
                      objectTypes={objectTypes}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {objectTypes.length > 0 ? (
          <section
            className="data-relationships"
            aria-labelledby="data-relationships-heading"
          >
            <h2
              className="data-section-heading"
              id="data-relationships-heading"
            >
              Relationships
            </h2>
            {pairs.length === 0 ? (
              <p className="data-form-hint">
                No relationships yet. Add one from an object type's Attributes
                tab by choosing the Relation attribute type.
              </p>
            ) : (
              <ul className="data-relationship-list">
                {pairs.map((pair) => (
                  <RelationshipLine key={pair.relationshipId} pair={pair} />
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
      {canWrite && isShareOpen ? (
        <ShareSpaceDialog space={space} onClose={() => setIsShareOpen(false)} />
      ) : null}
      {canWrite ? (
        <CreateObjectTypeDialog
          spaceId={spaceId}
          takenSlugs={objectTypes.map((type) => type.slug)}
          open={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
        />
      ) : null}
    </>
  );
}
