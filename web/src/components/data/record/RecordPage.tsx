import { Link } from "@tanstack/react-router";

import type {
  DataRecord,
  ObjectType,
  SpaceSchema,
} from "../../../api/dataspaces";
import { useDataRecord, useSpaceSchema } from "../../../hooks/useDataSpaces";
import { BotByline } from "../BotByline";
import { Button } from "../DataButton";
import { DataEmptyState } from "../DataEmptyState";
import { type DataCrumb, DataCrumbs } from "../DataPageHeader";
import {
  absoluteTimeLabel,
  primaryAttributeOf,
  recordName,
  relativeTimeLabel,
} from "../records/recordModel";
import { isPendingValue, useValueCommit } from "../records/useValueCommit";
import { objectTypeIcon } from "../values/attributeTypeIcon";
import { InPlaceValue } from "./InPlaceValue";
import { RecordActivityRail } from "./RecordActivityRail";
import { RecordAttributes } from "./RecordAttributes";
import { RecordRelationships } from "./RecordRelationships";

import "../../../styles/data.css";
import "../../../styles/data-record.css";

export interface RecordPageProps {
  spaceId: string;
  recordId: string;
}

const DATA_CRUMB: DataCrumb = { label: "Data", to: "/data" };

function RecordSkeleton() {
  return (
    <div
      className="rp-skeleton"
      role="status"
      aria-label="Loading record"
      data-testid="data-record-skeleton"
    >
      <span className="dr-skeleton-bar" data-short="true" />
      <span className="dr-skeleton-bar" />
      <span className="dr-skeleton-bar" />
      <span className="dr-skeleton-bar" data-short="true" />
    </div>
  );
}

interface RecordViewProps {
  schema: SpaceSchema;
  type: ObjectType;
  record: DataRecord;
}

function RecordView({ schema, type, record }: RecordViewProps) {
  const { space, objectTypes } = schema;
  const { pending, commit } = useValueCommit(space.id);
  const name = recordName(record, type);
  const primary = primaryAttributeOf(type);
  const TypeIcon = objectTypeIcon(type.icon);

  return (
    <article className="rp-page">
      <DataCrumbs
        crumbs={[
          DATA_CRUMB,
          {
            label: space.name,
            to: "/data/$spaceId",
            params: { spaceId: space.id },
          },
          {
            label: type.namePlural,
            to: "/data/$spaceId/t/$typeSlug",
            params: { spaceId: space.id, typeSlug: type.slug },
          },
          { label: name },
        ]}
      />
      <div className="rp-layout">
        <div className="rp-main">
          <header className="rp-header">
            <span className="rp-icon-tile" aria-hidden="true">
              <TypeIcon focusable="false" />
            </span>
            <div className="rp-header-text">
              {/* The visible name is its own edit button, so the H1 proper is
                  kept for assistive tech and the document outline. */}
              <h1 className="sr-only">{name}</h1>
              {primary ? (
                <InPlaceValue
                  variant="title"
                  attribute={primary}
                  value={record.values[primary.slug]}
                  isPending={isPendingValue(pending, record.id, primary.slug)}
                  onCommit={(next) => commit(record, primary.slug, next)}
                />
              ) : (
                <p className="rp-value" data-variant="title">
                  {name}
                </p>
              )}
              <p className="rp-header-meta">
                <span className="dr-type-badge">{type.name}</span>
                <BotByline actor={record.createdBy} />
                <span className="rp-header-updated">
                  Updated{" "}
                  <time
                    dateTime={record.updatedAt}
                    title={absoluteTimeLabel(record.updatedAt)}
                  >
                    {relativeTimeLabel(record.updatedAt)}
                  </time>
                </span>
              </p>
            </div>
          </header>
          <RecordAttributes
            record={record}
            type={type}
            pendingValue={pending}
            onCommit={(slug, next) => commit(record, slug, next)}
          />
          <RecordRelationships
            spaceId={space.id}
            record={record}
            recordName={name}
            type={type}
            objectTypes={objectTypes}
          />
        </div>
        <RecordActivityRail space={space} type={type} record={record} />
      </div>
    </article>
  );
}

/**
 * One record: header, attributes editable in place, relationships, and a
 * details rail. No tabs. Two columns from 960px of container width, one
 * column below that.
 */
export function RecordPage({ spaceId, recordId }: RecordPageProps) {
  const schema = useSpaceSchema(spaceId);
  const record = useDataRecord(spaceId, recordId);

  if (schema.isPending || (record.isPending && !schema.isError)) {
    return (
      <div className="rp-page">
        <DataCrumbs crumbs={[DATA_CRUMB, { label: "Loading" }]} />
        <RecordSkeleton />
      </div>
    );
  }

  const type = record.data
    ? schema.data?.objectTypes.find((item) => item.id === record.data.typeId)
    : undefined;

  if (!(schema.data && record.data && type)) {
    const space = schema.data?.space;
    return (
      <div className="rp-page">
        <DataCrumbs
          crumbs={[
            DATA_CRUMB,
            ...(space
              ? [
                  {
                    label: space.name,
                    to: "/data/$spaceId" as const,
                    params: { spaceId: space.id },
                  },
                ]
              : []),
            { label: "Not found" },
          ]}
        />
        <DataEmptyState
          title="This record does not exist"
          body="It may have been deleted, or the link is wrong."
          action={
            <Button variant="outline" asChild={true}>
              {space ? (
                <Link to="/data/$spaceId" params={{ spaceId: space.id }}>
                  Back to {space.name}
                </Link>
              ) : (
                <Link to="/data">Back to Data</Link>
              )}
            </Button>
          }
        />
      </div>
    );
  }

  return <RecordView schema={schema.data} type={type} record={record.data} />;
}
