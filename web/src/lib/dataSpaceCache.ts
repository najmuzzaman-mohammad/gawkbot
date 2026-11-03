/**
 * Pure cache patchers for data spaces, used when a space itself changes (for
 * example its sharing). Each returns a new object, or the input reference
 * untouched when there was nothing to replace.
 */

import type { DataSpace, SpaceSchema } from "../api/dataspaces";

/** Swaps a space into the list where it already appears. Never inserts. */
export function replaceSpaceInList(
  spaces: readonly DataSpace[] | undefined,
  next: DataSpace,
): readonly DataSpace[] | undefined {
  if (!spaces?.some((space) => space.id === next.id)) return spaces;
  return spaces.map((space) => (space.id === next.id ? next : space));
}

/** Swaps the space on a cached schema, leaving the object types alone. */
export function replaceSpaceInSchema(
  schema: SpaceSchema | undefined,
  next: DataSpace,
): SpaceSchema | undefined {
  if (!schema || schema.space.id !== next.id) return schema;
  return { ...schema, space: next };
}
