import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  DataRecord,
  RecordPage,
  RecordValuesPatch,
  SpaceSchema,
} from "../api/dataspaces";
import { dataClient } from "../api/dataspacesClient";
import {
  patchRecord,
  patchRecordInPage,
  replaceRecordInPage,
} from "../lib/dataRecordCache";
import {
  dataKeys,
  invalidateSchema,
  spaceRecordPagesKey,
  spaceRecordsKey,
} from "./useDataSpacesKeys";

const FALLBACK_PRIMARY_SLUG = "name";

export interface CreateRecordInput {
  typeId: string;
  values: RecordValuesPatch;
}

export interface UpdateRecordValuesInput {
  recordId: string;
  typeId: string;
  values: RecordValuesPatch;
}

export interface LinkRecordsInput {
  recordId: string;
  typeId: string;
  attributeSlug: string;
  targetId: string;
  /** Swap a conflicting to-one link instead of failing. */
  replace?: boolean;
}

export type UnlinkRecordsInput = Omit<LinkRecordsInput, "replace">;

interface RecordSnapshot {
  pages: readonly (readonly [QueryKey, RecordPage | undefined])[];
  record: DataRecord | undefined;
}

function cachedType(queryClient: QueryClient, spaceId: string, typeId: string) {
  return queryClient
    .getQueryData<SpaceSchema>(dataKeys.schema(spaceId))
    ?.objectTypes.find((type) => type.id === typeId);
}

function touchesPrimary(
  queryClient: QueryClient,
  spaceId: string,
  input: UpdateRecordValuesInput,
): boolean {
  const primary = cachedType(
    queryClient,
    spaceId,
    input.typeId,
  )?.attributes.find((attribute) => attribute.isPrimary);
  return (primary?.slug ?? FALLBACK_PRIMARY_SLUG) in input.values;
}

export function useCreateRecord(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ typeId, values }: CreateRecordInput) =>
      dataClient.createRecord(spaceId, typeId, values),
    onSuccess: (record) => {
      queryClient.setQueryData(dataKeys.record(spaceId, record.id), record);
      // Record counts live on the schema and the space list.
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: dataKeys.recordPages(spaceId, record.typeId),
        }),
        invalidateSchema(queryClient, spaceId),
      ]);
    },
  });
}

/**
 * Optimistic inline edit. Every cached page of the type and the single-record
 * query are patched at once, then restored from the snapshot if the write
 * fails. The error is not swallowed: `mutateAsync` rejects with it and
 * `mutate` hands it to the caller's own `onError`, so the caller can toast.
 * (It is not rethrown from `onError` here; React Query v5 would turn that
 * into an unhandled rejection rather than propagate it.)
 */
export function useUpdateRecordValues(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    DataRecord,
    Error,
    UpdateRecordValuesInput,
    RecordSnapshot
  >({
    mutationFn: ({ recordId, values }) =>
      dataClient.updateRecord(spaceId, recordId, values),
    onMutate: async ({ recordId, typeId, values }) => {
      const pagesKey = dataKeys.recordPages(spaceId, typeId);
      const recordKey = dataKeys.record(spaceId, recordId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: pagesKey }),
        queryClient.cancelQueries({ queryKey: recordKey }),
      ]);
      const snapshot: RecordSnapshot = {
        pages: queryClient.getQueriesData<RecordPage>({ queryKey: pagesKey }),
        record: queryClient.getQueryData<DataRecord>(recordKey),
      };
      const stamp = new Date().toISOString();
      queryClient.setQueriesData<RecordPage>({ queryKey: pagesKey }, (page) =>
        patchRecordInPage(page, recordId, values, stamp),
      );
      queryClient.setQueryData<DataRecord>(recordKey, (current) =>
        current ? patchRecord(current, values, stamp) : current,
      );
      return snapshot;
    },
    onError: (_error, { recordId }, snapshot) => {
      if (!snapshot) return;
      for (const [key, page] of snapshot.pages) {
        queryClient.setQueryData(key, page);
      }
      queryClient.setQueryData(
        dataKeys.record(spaceId, recordId),
        snapshot.record,
      );
    },
    onSuccess: (record) => {
      // The server's coerced values replace the optimistic guess at once.
      queryClient.setQueryData(dataKeys.record(spaceId, record.id), record);
      queryClient.setQueriesData<RecordPage>(
        { queryKey: dataKeys.recordPages(spaceId, record.typeId) },
        (page) => replaceRecordInPage(page, record),
      );
    },
    onSettled: (_record, _error, input) => {
      if (touchesPrimary(queryClient, spaceId, input)) {
        // A rename changes the chip label on every record that links here.
        return Promise.all([
          queryClient.invalidateQueries({
            queryKey: spaceRecordPagesKey(spaceId),
          }),
          queryClient.invalidateQueries({ queryKey: spaceRecordsKey(spaceId) }),
        ]);
      }
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: dataKeys.recordPages(spaceId, input.typeId),
        }),
        queryClient.invalidateQueries({
          queryKey: dataKeys.record(spaceId, input.recordId),
        }),
      ]);
    },
  });
}

/**
 * Shared settle step for link and unlink. Not optimistic: the returned record
 * is written to the cache, then both sides are invalidated, because the
 * inverse attribute on the target type changed too. With `replace`, a third
 * record lost its link, so every single-record query in the space is marked
 * stale.
 */
function settleLinkChange(
  queryClient: QueryClient,
  spaceId: string,
  input: UnlinkRecordsInput,
  record: DataRecord,
) {
  queryClient.setQueryData(dataKeys.record(spaceId, record.id), record);
  const targetTypeId = cachedType(
    queryClient,
    spaceId,
    input.typeId,
  )?.attributes.find((attribute) => attribute.slug === input.attributeSlug)
    ?.relationship?.targetTypeId;
  const pageKeys = targetTypeId
    ? [
        dataKeys.recordPages(spaceId, input.typeId),
        dataKeys.recordPages(spaceId, targetTypeId),
      ]
    : // Schema not cached: fall back to every table in the space.
      [spaceRecordPagesKey(spaceId)];
  return Promise.all([
    ...pageKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    queryClient.invalidateQueries({
      queryKey: spaceRecordsKey(spaceId),
      predicate: (query) => query.queryKey[3] !== record.id,
    }),
  ]);
}

export function useLinkRecords(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkRecordsInput) =>
      dataClient.linkRecords(
        spaceId,
        input.recordId,
        input.attributeSlug,
        input.targetId,
        input.replace,
      ),
    onSuccess: (record, input) =>
      settleLinkChange(queryClient, spaceId, input, record),
  });
}

export function useUnlinkRecords(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UnlinkRecordsInput) =>
      dataClient.unlinkRecords(
        spaceId,
        input.recordId,
        input.attributeSlug,
        input.targetId,
      ),
    onSuccess: (record, input) =>
      settleLinkChange(queryClient, spaceId, input, record),
  });
}
