/**
 * React Query hooks for the Data section, over the `dataClient` singleton.
 * Record mutations live in `useDataSpacesRecords.ts` and the key factory in
 * `useDataSpacesKeys.ts`; both are re-exported here so callers import from
 * one place.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type AttributeInput,
  type AttributePatch,
  type DataSpace,
  DataValidationError,
  type DeleteKind,
  type ObjectTypeInput,
  type RecordQuery,
  type SpaceAccess,
  type SpaceSchema,
} from "../api/dataspaces";
import { dataClient } from "../api/dataspacesClient";
import {
  replaceSpaceInList,
  replaceSpaceInSchema,
} from "../lib/dataSpaceCache";
import {
  dataKeys,
  invalidateSchema,
  invalidateSpace,
} from "./useDataSpacesKeys";

export { dataKeys } from "./useDataSpacesKeys";
export {
  type CreateRecordInput,
  type LinkRecordsInput,
  type UnlinkRecordsInput,
  type UpdateRecordValuesInput,
  useCreateRecord,
  useLinkRecords,
  useUnlinkRecords,
  useUpdateRecordValues,
} from "./useDataSpacesRecords";

export interface UpdateObjectTypeInput {
  typeId: string;
  patch: Partial<ObjectTypeInput>;
}

export interface AddAttributeInput {
  typeId: string;
  input: AttributeInput;
}

export interface UpdateAttributeInput {
  typeId: string;
  attributeId: string;
  patch: AttributePatch;
}

export interface UpdateSpaceAccessInput {
  spaceId: string;
  access: SpaceAccess;
}

export interface PreviewDeleteInput {
  kind: DeleteKind;
  ids: readonly string[];
}

export function useDataSpaces() {
  return useQuery({
    queryKey: dataKeys.spaces(),
    queryFn: () => dataClient.listSpaces(),
  });
}

export function useSpaceSchema(spaceId: string) {
  return useQuery({
    queryKey: dataKeys.schema(spaceId),
    queryFn: () => dataClient.getSchema(spaceId),
    // An unknown space is a final answer, not a flake: show not-found at once.
    retry: (failureCount, error) =>
      !(error instanceof DataValidationError) && failureCount < 1,
  });
}

/** Keeps the previous page on screen while the next sort or page loads. */
export function useRecordPage(spaceId: string, query: RecordQuery) {
  return useQuery({
    queryKey: dataKeys.recordPage(spaceId, query),
    queryFn: () => dataClient.queryRecords(spaceId, query),
    placeholderData: keepPreviousData,
  });
}

/** Disabled while `recordId` is null, e.g. a closed peek drawer. */
export function useDataRecord(spaceId: string, recordId: string | null) {
  return useQuery({
    queryKey: dataKeys.record(spaceId, recordId ?? ""),
    queryFn: () => dataClient.getRecord(spaceId, recordId ?? ""),
    enabled: recordId !== null,
  });
}

/**
 * Changes who can use a space: private, shared with named bots, or global.
 * Takes the space id per call, because the control sits on the space list as
 * well as inside a space. The server's normalized answer is written into both
 * caches at once, then both are invalidated.
 */
export function useUpdateSpaceAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceId, access }: UpdateSpaceAccessInput) =>
      dataClient.updateSpaceAccess(spaceId, access),
    onSuccess: (space) => {
      queryClient.setQueryData<readonly DataSpace[]>(
        dataKeys.spaces(),
        (spaces) => replaceSpaceInList(spaces, space),
      );
      queryClient.setQueryData<SpaceSchema>(
        dataKeys.schema(space.id),
        (schema) => replaceSpaceInSchema(schema, space),
      );
      return invalidateSchema(queryClient, space.id);
    },
  });
}

export function useCreateObjectType(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ObjectTypeInput) =>
      dataClient.createObjectType(spaceId, input),
    onSuccess: () => invalidateSchema(queryClient, spaceId),
  });
}

export function useUpdateObjectType(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ typeId, patch }: UpdateObjectTypeInput) =>
      dataClient.updateObjectType(spaceId, typeId, patch),
    onSuccess: () => invalidateSchema(queryClient, spaceId),
  });
}

export function useAddAttribute(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ typeId, input }: AddAttributeInput) =>
      dataClient.addAttribute(spaceId, typeId, input),
    onSuccess: () => invalidateSchema(queryClient, spaceId),
  });
}

export function useUpdateAttribute(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ typeId, attributeId, patch }: UpdateAttributeInput) =>
      dataClient.updateAttribute(spaceId, typeId, attributeId, patch),
    onSuccess: () => invalidateSchema(queryClient, spaceId),
  });
}

/** Step one of a delete. Reads only; nothing is invalidated. */
export function usePreviewDelete(spaceId: string) {
  return useMutation({
    mutationFn: ({ kind, ids }: PreviewDeleteInput) =>
      dataClient.previewDelete(spaceId, kind, ids),
  });
}

/**
 * Step two of a delete; takes the preview token. A delete can remove
 * records, links, attributes, and types at once, so everything cached for
 * the space is invalidated.
 */
export function useExecuteDelete(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => dataClient.executeDelete(spaceId, token),
    onSuccess: () => invalidateSpace(queryClient, spaceId),
  });
}
