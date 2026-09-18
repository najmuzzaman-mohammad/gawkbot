/**
 * Data tab — every data space this bot can use, from its own side.
 *
 * The Data section lists the whole office; this answers the narrower question
 * an operator asks on a bot's own page: what does THIS bot keep, what has it
 * been let into, and what can it reach because the space is global. The three
 * groups are the three ways a bot gets access, so the tab doubles as the
 * per-bot view of the sharing model.
 */

import { Link } from "@tanstack/react-router";

import type { DataSpace } from "../../../api/dataspaces";
import { botAccessLevel } from "../../../api/dataspacesAccess";
import { useDataSpaces } from "../../../hooks/useDataSpaces";
import { AccessBadge } from "../../data/index/AccessBadge";
import { PixelAvatar } from "../../ui/PixelAvatar";

import "../../../styles/data.css";
import "../../../styles/data-schema.css";

interface DataTabProps {
  agentSlug: string;
}

interface SpaceGroup {
  key: "owned" | "shared" | "global";
  title: string;
  caption: string;
  spaces: readonly DataSpace[];
}

/**
 * Owned first, then spaces another bot let this one into, then global. A
 * space appears once: its owner sees it under Owned even when it is global.
 */
export function groupSpacesForBot(
  spaces: readonly DataSpace[],
  agentSlug: string,
): readonly SpaceGroup[] {
  const owned: DataSpace[] = [];
  const shared: DataSpace[] = [];
  const global: DataSpace[] = [];
  for (const space of spaces) {
    if (space.owner === agentSlug) {
      owned.push(space);
      continue;
    }
    if (space.access.scope === "global") {
      global.push(space);
      continue;
    }
    if (botAccessLevel(space, agentSlug) !== "none") {
      shared.push(space);
    }
  }
  const groups: readonly SpaceGroup[] = [
    {
      key: "owned",
      title: "Owns",
      caption: `Data spaces @${agentSlug} created. It always has full access.`,
      spaces: owned,
    },
    {
      key: "shared",
      title: "Shared with it",
      caption: "Another bot gave it access to these.",
      spaces: shared,
    },
    {
      key: "global",
      title: "Global",
      caption: "Every bot in the office reads and writes these.",
      spaces: global,
    },
  ];
  return groups.filter((group) => group.spaces.length > 0);
}

const LEVEL_LABELS = {
  read: "Can read",
  write: "Can write",
  none: "No access",
} as const;

function SpaceRows({
  spaces,
  agentSlug,
  showOwner,
  showLevel,
}: {
  spaces: readonly DataSpace[];
  agentSlug: string;
  showOwner: boolean;
  showLevel: boolean;
}) {
  return (
    <div className="data-list-scroll">
      <table className="data-list-table">
        <thead>
          <tr>
            <th scope="col">Space</th>
            <th scope="col">Description</th>
            {showLevel ? <th scope="col">This bot</th> : null}
            {showOwner ? (
              <th scope="col">Owner</th>
            ) : (
              <th scope="col">Access</th>
            )}
            <th scope="col" className="data-list-number">
              Object types
            </th>
            <th scope="col" className="data-list-number">
              Records
            </th>
          </tr>
        </thead>
        <tbody>
          {spaces.map((space) => (
            <tr key={space.id}>
              <th scope="row">
                <Link
                  to="/data/$spaceId"
                  params={{ spaceId: space.id }}
                  className="data-list-link"
                >
                  {space.name}
                </Link>
              </th>
              <td className="data-list-description">{space.description}</td>
              {showLevel ? (
                <td className="data-list-nowrap">
                  {LEVEL_LABELS[botAccessLevel(space, agentSlug)]}
                </td>
              ) : null}
              {showOwner ? (
                <td className="data-list-nowrap">
                  <span className="data-byline">
                    <PixelAvatar slug={space.owner} size={14} />
                    <span className="data-byline-slug">@{space.owner}</span>
                  </span>
                </td>
              ) : (
                <td className="data-list-nowrap">
                  <AccessBadge access={space.access} />
                </td>
              )}
              <td className="data-list-number">{space.objectTypeCount}</td>
              <td className="data-list-number">
                {space.recordCount.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataTab({ agentSlug }: DataTabProps) {
  const { data: spaces, isLoading, isError } = useDataSpaces();

  if (isLoading) {
    return (
      <p className="data-empty-body" aria-busy="true">
        Loading data spaces…
      </p>
    );
  }
  if (isError || !spaces) {
    return (
      <p className="data-empty-body" role="alert">
        The data spaces did not load.
      </p>
    );
  }

  const groups = groupSpacesForBot(spaces, agentSlug);

  if (groups.length === 0) {
    return (
      <div className="data-empty" role="status">
        <h2 className="data-empty-title">No data yet</h2>
        <p className="data-empty-body">
          A data space is where @{agentSlug} keeps records for one use case. Ask
          it to track something, for example "track my seed raise", and the
          space it creates shows up here.
        </p>
        <div className="data-empty-action">
          <Link to="/data" className="data-btn data-btn--outline">
            Open Data
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="bot-data-tab">
      {groups.map((group) => (
        <section key={group.key} className="bot-data-group">
          <h3 className="bot-data-group-title">{group.title}</h3>
          <p className="bot-data-group-caption">{group.caption}</p>
          <SpaceRows
            spaces={group.spaces}
            agentSlug={agentSlug}
            showOwner={group.key !== "owned"}
            showLevel={group.key === "shared"}
          />
        </section>
      ))}
    </div>
  );
}
