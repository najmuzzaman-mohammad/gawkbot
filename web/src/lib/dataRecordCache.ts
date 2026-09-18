/**
 * Pure cache patchers for data records, used by the optimistic update in
 * `useUpdateRecordValues`. Every function returns a new object and hands back
 * the input reference untouched when nothing changed, so React Query can
 * skip the re-render.
 */

import type {
  AttributeValue,
  DataRecord,
  RecordPage,
  RecordValuesPatch,
} from "../api/dataspaces";

/** Applies a patch to a values map. `null` removes the key. */
export function applyValuesPatch(
  values: Readonly<Record<string, AttributeValue>>,
  patch: RecordValuesPatch,
): Readonly<Record<string, AttributeValue>> {
  const kept = Object.entries(values).filter(([slug]) => !(slug in patch));
  const set = Object.entries(patch).filter(
    (entry): entry is [string, AttributeValue] =>
      entry[1] !== null && entry[1] !== undefined,
  );
  return Object.fromEntries([...kept, ...set]);
}

export function patchRecord(
  record: DataRecord,
  patch: RecordValuesPatch,
  updatedAt?: string,
): DataRecord {
  if (Object.keys(patch).length === 0) return record;
  return {
    ...record,
    values: applyValuesPatch(record.values, patch),
    updatedAt: updatedAt ?? record.updatedAt,
  };
}

/** Patches one record inside a page. `undefined` in, `undefined` out. */
export function patchRecordInPage(
  page: RecordPage | undefined,
  recordId: string,
  patch: RecordValuesPatch,
  updatedAt?: string,
): RecordPage | undefined {
  if (!page?.records.some((record) => record.id === recordId)) return page;
  return {
    ...page,
    records: page.records.map((record) =>
      record.id === recordId ? patchRecord(record, patch, updatedAt) : record,
    ),
  };
}

/** Swaps in a server-returned record wherever the page already shows it. */
export function replaceRecordInPage(
  page: RecordPage | undefined,
  next: DataRecord,
): RecordPage | undefined {
  if (!page?.records.some((record) => record.id === next.id)) return page;
  return {
    ...page,
    records: page.records.map((record) =>
      record.id === next.id ? next : record,
    ),
  };
}

export function removeRecordsFromPage(
  page: RecordPage | undefined,
  recordIds: readonly string[],
): RecordPage | undefined {
  if (!page) return page;
  const gone = new Set(recordIds);
  const records = page.records.filter((record) => !gone.has(record.id));
  const removed = page.records.length - records.length;
  if (removed === 0) return page;
  return { records, total: Math.max(0, page.total - removed) };
}
