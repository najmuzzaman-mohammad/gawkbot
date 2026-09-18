import { Link } from "@tanstack/react-router";

import type { DataSpace } from "../../../api/dataspaces";
import { useDataSpaces } from "../../../hooks/useDataSpaces";
import { formatRelativeTime } from "../../../lib/format";
import { PixelAvatar } from "../../ui/PixelAvatar";
import { BotByline } from "../BotByline";
import { DataEmptyState } from "../DataEmptyState";
import { DataPageHeader } from "../DataPageHeader";
import { errorMessage } from "../settings/formControls";
import { AccessBadge } from "./AccessBadge";
import { type BotSpaceGroup, groupSpaces, sharedWithLine } from "./groupSpaces";
import { countLabel } from "./schemaSummary";

import "../../../styles/data-schema.css";

const CRUMBS = [{ label: "Data" }] as const;
const SUBTITLE =
  "Each bot keeps one data space per use case. The apps a bot builds read and write the records in its spaces.";
const EXAMPLE_PROMPT = "Track my seed raise";
const GROUP_AVATAR_SIZE = 20;

interface SpaceRowProps {
  space: DataSpace;
  showOwner: boolean;
}

function SpaceRow({ space, showOwner }: SpaceRowProps) {
  return (
    <tr>
      <th scope="row" className="data-list-name">
        <Link
          className="data-list-link"
          to="/data/$spaceId"
          params={{ spaceId: space.id }}
        >
          {space.name}
        </Link>
        {showOwner ? (
          <span className="data-list-owner">
            <BotByline actor={space.owner} verb="Owned by" />
          </span>
        ) : null}
      </th>
      <td className="data-list-description" title={space.description}>
        {space.description === "" ? (
          <span className="data-list-muted">No description</span>
        ) : (
          space.description
        )}
      </td>
      <td className="data-list-nowrap">
        <AccessBadge access={space.access} />
      </td>
      <td className="data-list-number">
        {space.objectTypeCount.toLocaleString()}
      </td>
      <td className="data-list-number">{space.recordCount.toLocaleString()}</td>
      <td className="data-list-number">
        {space.attachedAppIds.length.toLocaleString()}
      </td>
      <td className="data-list-nowrap">
        <time dateTime={space.updatedAt}>
          {formatRelativeTime(space.updatedAt)}
        </time>
      </td>
    </tr>
  );
}

const COLUMNS = (
  <thead>
    <tr>
      <th scope="col">Space</th>
      <th scope="col">Description</th>
      <th scope="col">Access</th>
      <th scope="col" className="data-list-number">
        Object types
      </th>
      <th scope="col" className="data-list-number">
        Records
      </th>
      <th scope="col" className="data-list-number">
        Apps attached
      </th>
      <th scope="col">Updated</th>
    </tr>
  </thead>
);

interface SpaceTableProps {
  spaces: readonly DataSpace[];
  /** Global rows say who owns them; bot groups already do in the heading. */
  showOwner: boolean;
}

function SpaceTable({ spaces, showOwner }: SpaceTableProps) {
  return (
    <div className="data-list-scroll">
      <table className="data-list-table">
        {COLUMNS}
        <tbody>
          {spaces.map((space) => (
            <SpaceRow key={space.id} space={space} showOwner={showOwner} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface GlobalGroupProps {
  spaces: readonly DataSpace[];
}

function GlobalGroup({ spaces }: GlobalGroupProps) {
  return (
    <section
      className="data-bot-group"
      aria-labelledby="data-global-group"
      data-testid="data-global-group"
    >
      <h2 className="data-bot-group-heading" id="data-global-group">
        Global
      </h2>
      <p className="data-bot-group-caption">
        Every bot in the office reads and writes these.
      </p>
      <SpaceTable spaces={spaces} showOwner={true} />
    </section>
  );
}

interface BotGroupProps {
  group: BotSpaceGroup;
}

function BotGroup({ group }: BotGroupProps) {
  const headingId = `data-bot-group-${group.owner}`;
  const sharedLine = sharedWithLine(group.sharedWithCount);
  return (
    <section
      className="data-bot-group"
      aria-labelledby={headingId}
      data-testid={`data-bot-group-${group.owner}`}
    >
      <h2 className="data-bot-group-heading" id={headingId}>
        <PixelAvatar slug={group.owner} size={GROUP_AVATAR_SIZE} />
        <span>@{group.owner}</span>
        <span className="data-bot-group-count">
          {countLabel(group.spaces.length, "space", "spaces")}
        </span>
      </h2>
      {sharedLine ? (
        <p className="data-bot-group-caption">{sharedLine}</p>
      ) : null}
      <SpaceTable spaces={group.spaces} showOwner={false} />
    </section>
  );
}

/**
 * `/data`: global spaces first, then every other space under the bot that
 * owns it. A space shared with a bot is not repeated under that bot; its
 * group says how many it can also reach. There is no "create space" action
 * in v1 because bots create spaces.
 */
export function DataIndexPage() {
  const spacesQuery = useDataSpaces();
  const groups = groupSpaces(spacesQuery.data ?? []);
  const isEmpty = groups.global.length === 0 && groups.bots.length === 0;

  return (
    <>
      <DataPageHeader crumbs={CRUMBS} title="Data" subtitle={SUBTITLE} />
      <div className="data-page-body">
        {spacesQuery.isPending ? (
          <p className="data-page-status" aria-busy="true">
            Loading data spaces…
          </p>
        ) : spacesQuery.isError ? (
          <p className="data-form-error" role="alert">
            {errorMessage(spacesQuery.error)}
          </p>
        ) : isEmpty ? (
          <DataEmptyState
            title="No data spaces yet"
            body={`Bots create data spaces when you give them something to keep track of. Say this to a bot in any channel: "${EXAMPLE_PROMPT}".`}
          />
        ) : (
          <>
            {groups.global.length > 0 ? (
              <GlobalGroup spaces={groups.global} />
            ) : null}
            {groups.bots.map((group) => (
              <BotGroup key={group.owner} group={group} />
            ))}
          </>
        )}
      </div>
    </>
  );
}
