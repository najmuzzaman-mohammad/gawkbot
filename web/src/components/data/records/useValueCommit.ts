import { useCallback, useState } from "react";

import type { AttributeValue, DataRecord } from "../../../api/dataspaces";
import { useUpdateRecordValues } from "../../../hooks/useDataSpaces";
import { showNotice } from "../../ui/Toast";

export interface PendingValueTarget {
  recordId: string;
  slug: string;
}

export interface ValueCommit {
  /** The one write in flight, if any. Cells compare against it. */
  pending: PendingValueTarget | null;
  commit: (
    record: Pick<DataRecord, "id" | "typeId">,
    slug: string,
    next: AttributeValue | null,
  ) => void;
}

const FALLBACK_ERROR = "That change could not be saved.";

export function isPendingValue(
  pending: PendingValueTarget | null,
  recordId: string,
  slug: string,
): boolean {
  return pending?.recordId === recordId && pending.slug === slug;
}

/**
 * One inline value write, shared by the records table and the record page.
 * The mutation is optimistic and restores its snapshot on failure; this hook
 * adds the two things a screen needs on top: which cell is saving, and a
 * toast carrying the store's own message (it already names the valid
 * options, the allowed range, or the record that holds a unique value).
 */
export function useValueCommit(spaceId: string): ValueCommit {
  const { mutate } = useUpdateRecordValues(spaceId);
  const [pending, setPending] = useState<PendingValueTarget | null>(null);

  const commit = useCallback<ValueCommit["commit"]>(
    (record, slug, next) => {
      const target: PendingValueTarget = { recordId: record.id, slug };
      setPending(target);
      mutate(
        {
          recordId: record.id,
          typeId: record.typeId,
          values: { [slug]: next },
        },
        {
          onError: (error) => {
            showNotice(error.message || FALLBACK_ERROR, "error");
          },
          onSettled: () => {
            // A newer edit may already own the pending slot; leave it alone.
            setPending((current) => (current === target ? null : current));
          },
        },
      );
    },
    [mutate],
  );

  return { pending, commit };
}
