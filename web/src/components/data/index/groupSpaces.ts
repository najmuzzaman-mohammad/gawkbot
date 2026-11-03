/**
 * Grouping for the Data index: global spaces first, then one group per
 * owning bot. Pure.
 */

import type { DataSpace } from "../../../api/dataspaces";
import { botAccessLevel } from "../../../api/dataspacesAccess";

export interface BotSpaceGroup {
  owner: string;
  /** The bot's own spaces that are not global. */
  spaces: readonly DataSpace[];
  /**
   * Other bots' spaces shared with this bot by name. Global spaces are not
   * counted: every bot has those, and they have their own group.
   */
  sharedWithCount: number;
}

export interface SpaceGroups {
  /** Every global space, whoever owns it. */
  global: readonly DataSpace[];
  /** In the order each owner first appears. */
  bots: readonly BotSpaceGroup[];
}

function isGlobal(space: DataSpace): boolean {
  return space.access.scope === "global";
}

function countSharedWith(spaces: readonly DataSpace[], bot: string): number {
  return spaces.filter(
    (space) =>
      space.access.scope === "shared" &&
      space.owner !== bot &&
      botAccessLevel(space, bot) !== "none",
  ).length;
}

/** A space appears exactly once: under Global, or under its owner. */
export function groupSpaces(spaces: readonly DataSpace[]): SpaceGroups {
  const owned = spaces.filter((space) => !isGlobal(space));
  const owners = [...new Set(owned.map((space) => space.owner))];
  return {
    global: spaces.filter(isGlobal),
    bots: owners.map((owner) => ({
      owner,
      spaces: owned.filter((space) => space.owner === owner),
      sharedWithCount: countSharedWith(spaces, owner),
    })),
  };
}

/** "Also has access to 2 shared spaces", or null when there are none. */
export function sharedWithLine(count: number): string | null {
  if (count <= 0) return null;
  return `Also has access to ${count.toLocaleString()} shared ${count === 1 ? "space" : "spaces"}`;
}
