import type { QueryClient } from "@tanstack/react-query";

import type { RecordQuery } from "../api/dataspaces";

const ROOT = "data";

/**
 * Query keys for the Data section. `recordPages` is a prefix of every
 * `recordPage` key for the same type, so one invalidation covers every
 * sort, filter, and page of a table.
 */
export const dataKeys = {
  spaces: () => [ROOT, "spaces"] as const,
  schema: (spaceId: string) => [ROOT, "schema", spaceId] as const,
  recordPages: (spaceId: string, typeId: string) =>
    [ROOT, "records", spaceId, typeId] as const,
  recordPage: (spaceId: string, query: RecordQuery) =>
    [ROOT, "records", spaceId, query.typeId, query] as const,
  record: (spaceId: string, recordId: string) =>
    [ROOT, "record", spaceId, recordId] as const,
};

/** Every record page of every type in a space. */
export function spaceRecordPagesKey(spaceId: string) {
  return [ROOT, "records", spaceId] as const;
}

/** Every single-record query in a space. */
export function spaceRecordsKey(spaceId: string) {
  return [ROOT, "record", spaceId] as const;
}

/** Schema and space list: object type, attribute, and count changes. */
export function invalidateSchema(queryClient: QueryClient, spaceId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: dataKeys.schema(spaceId) }),
    queryClient.invalidateQueries({ queryKey: dataKeys.spaces() }),
  ]);
}

/** Everything cached for a space. Used after a delete. */
export function invalidateSpace(queryClient: QueryClient, spaceId: string) {
  return Promise.all([
    invalidateSchema(queryClient, spaceId),
    queryClient.invalidateQueries({ queryKey: spaceRecordPagesKey(spaceId) }),
    queryClient.invalidateQueries({ queryKey: spaceRecordsKey(spaceId) }),
  ]);
}
