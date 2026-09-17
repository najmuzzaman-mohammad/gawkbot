/**
 * Fixture data for the Data section: one space per ICP example in
 * docs/specs/agent-data-model.md, each owned by a different bot. The spaces
 * are built lazily, once, by running the mock engine with a seeded PRNG and a
 * synthetic clock, so ids and values are identical on every run.
 */

import { emptySpaceState } from "./dataspaces.fixtures.builder";
import { buildClientDeliverySpace } from "./dataspaces.fixtures.clientDelivery";
import { buildCompanyDirectorySpace } from "./dataspaces.fixtures.companyDirectory";
import { buildRecruitingSpace } from "./dataspaces.fixtures.recruiting";
import { buildSeedRaiseSpace } from "./dataspaces.fixtures.seedRaise";
import { deepClone, type SpaceState } from "./dataspaces.mock.store";

export {
  CLIENT_DELIVERY_SPACE_ID,
  DELIVERABLE_PRIORITIES,
  PROJECT_STATUSES,
} from "./dataspaces.fixtures.clientDelivery";
export {
  COMPANY_DIRECTORY_SPACE_ID,
  DIRECTORY_TEAMS,
} from "./dataspaces.fixtures.companyDirectory";
export {
  CANDIDATE_STAGES,
  RECRUITING_SPACE_ID,
} from "./dataspaces.fixtures.recruiting";
export {
  SEED_RAISE_SPACE_ID,
  SEED_RAISE_STAGES,
} from "./dataspaces.fixtures.seedRaise";

/** A full snapshot of one space: schema, relationships, records, links. */
export type FixtureSpace = SpaceState;

export interface FixtureSeed {
  /** Defaults to the four fixture spaces, or to none when `emptySpace` is set. */
  spaces?: readonly FixtureSpace[];
  /** Adds one private space with no object types, id `EMPTY_SPACE_ID`. */
  emptySpace?: boolean;
}

export const EMPTY_SPACE_ID = "space_empty";
export const EMPTY_SPACE_OWNER = "cos";

let cachedSpaces: readonly FixtureSpace[] | null = null;

/**
 * The three ICP spaces (Seed raise is private, Client delivery and Recruiting
 * are shared), then the global Company directory.
 */
export function defaultFixtureSpaces(): readonly FixtureSpace[] {
  if (cachedSpaces === null) {
    cachedSpaces = [
      buildSeedRaiseSpace(),
      buildClientDeliverySpace(),
      buildRecruitingSpace(),
      buildCompanyDirectorySpace(),
    ];
  }
  return cachedSpaces;
}

export function emptyFixtureSpace(): FixtureSpace {
  return emptySpaceState({
    id: EMPTY_SPACE_ID,
    key: "empty",
    name: "Untitled space",
    description: "",
    owner: EMPTY_SPACE_OWNER,
    startAt: "2026-09-01T00:00:00.000Z",
  });
}

/** Resolves a seed into independent deep copies, safe to hand to a store. */
export function resolveFixtureSeed(seed: FixtureSeed = {}): FixtureSpace[] {
  const base = seed.spaces ?? (seed.emptySpace ? [] : defaultFixtureSpaces());
  const spaces = seed.emptySpace ? [...base, emptyFixtureSpace()] : [...base];
  return spaces.map((space) => deepClone(space));
}
