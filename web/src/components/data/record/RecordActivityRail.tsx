import { useId } from "react";
import { Link } from "@tanstack/react-router";
import { Copy } from "iconoir-react";

import type {
  DataRecord,
  DataSpace,
  ObjectType,
} from "../../../api/dataspaces";
import { showNotice } from "../../ui/Toast";
import { BotByline } from "../BotByline";
import { absoluteTimeLabel, relativeTimeLabel } from "../records/recordModel";

import "../../../styles/data-record.css";

export interface RecordActivityRailProps {
  space: DataSpace;
  type: ObjectType;
  record: DataRecord;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showNotice("Record id copied.", "success");
  } catch {
    showNotice("Copy failed. Select the id and copy it by hand.", "error");
  }
}

/**
 * The right rail. It shows facts the store actually has: ids, provenance,
 * timestamps, and which apps read this data space.
 *
 * TODO(agent-data-model S2/S3): the activity timeline lands with the backend
 * change log. Until the store records changes there is nothing true to show
 * here, so no events are invented.
 */
export function RecordActivityRail({
  space,
  type,
  record,
}: RecordActivityRailProps) {
  const headingId = useId();
  const usedById = useId();
  return (
    <aside className="rp-rail" aria-labelledby={headingId}>
      <h2 id={headingId} className="rp-section-title">
        Details
      </h2>
      <dl className="rp-details">
        <div className="rp-detail">
          <dt>Record id</dt>
          <dd className="rp-detail-id">
            <span className="data-mono">{record.id}</span>
            <button
              type="button"
              className="dr-icon-button"
              aria-label="Copy record id"
              onClick={() => {
                void copyText(record.id);
              }}
            >
              <Copy aria-hidden="true" focusable="false" />
            </button>
          </dd>
        </div>
        <div className="rp-detail">
          <dt>Created</dt>
          <dd>
            <BotByline actor={record.createdBy} verb="By" />
            <time dateTime={record.createdAt}>
              {absoluteTimeLabel(record.createdAt)}
            </time>
          </dd>
        </div>
        <div className="rp-detail">
          <dt>Updated</dt>
          <dd>
            <time
              dateTime={record.updatedAt}
              title={absoluteTimeLabel(record.updatedAt)}
            >
              {relativeTimeLabel(record.updatedAt)}
            </time>
          </dd>
        </div>
        <div className="rp-detail">
          <dt>Object type</dt>
          <dd>
            <Link
              className="rp-link"
              to="/data/$spaceId/t/$typeSlug"
              params={{ spaceId: space.id, typeSlug: type.slug }}
            >
              {type.name}
            </Link>
          </dd>
        </div>
        <div className="rp-detail">
          <dt>Data space</dt>
          <dd>
            <Link
              className="rp-link"
              to="/data/$spaceId"
              params={{ spaceId: space.id }}
            >
              {space.name}
            </Link>
          </dd>
        </div>
      </dl>
      <h3 id={usedById} className="rp-rail-subtitle">
        Used by
      </h3>
      {space.attachedAppIds.length === 0 ? (
        <p className="rp-note">No apps use this data space yet.</p>
      ) : (
        <ul className="rp-used-by" aria-labelledby={usedById}>
          {space.attachedAppIds.map((appId) => (
            <li key={appId}>
              <Link
                className="rp-link data-mono"
                to="/apps/$appId"
                params={{ appId }}
              >
                {appId}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
