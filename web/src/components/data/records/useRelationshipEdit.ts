import { useCallback, useState } from "react";

import {
  type AttributeDefinition,
  DataValidationError,
  type RecordRef,
} from "../../../api/dataspaces";
import { useLinkRecords, useUnlinkRecords } from "../../../hooks/useDataSpaces";
import { showNotice } from "../../ui/Toast";
import { holdsOne, targetHoldsOne } from "./recordModel";

export interface RelationshipEditInput {
  spaceId: string;
  recordId: string;
  typeId: string;
  attribute: AttributeDefinition;
  /** The records linked through this attribute right now. */
  linked: readonly RecordRef[];
}

/** The target already belongs to another record, and may hold only one. */
export interface LinkConflict {
  targetId: string;
  message: string;
}

export interface RelationshipEdit {
  isPending: boolean;
  conflict: LinkConflict | null;
  /** Resolves true when the link landed. */
  link: (targetId: string) => Promise<boolean>;
  unlink: (targetId: string) => Promise<boolean>;
  /** Retries the conflicting link with `replace`, taking the target over. */
  moveHere: () => Promise<boolean>;
  dismissConflict: () => void;
}

const FALLBACK_ERROR = "That link could not be changed.";
const BOT_HINT = /\s*Pass replace[^.]*\.\s*$/;

/**
 * Store errors end with an instruction written for bots ("Pass replace to
 * move it to ..."). The operator gets a button for that instead.
 */
export function humanizeLinkError(message: string): string {
  const trimmed = message.replace(BOT_HINT, "").trim();
  return trimmed === "" ? FALLBACK_ERROR : trimmed;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? humanizeLinkError(error.message)
    : FALLBACK_ERROR;
}

/**
 * Link and unlink for one relationship attribute of one record. Shared by the
 * table cell and the record page. Not optimistic: a link touches two records
 * and sometimes a third, so the UI waits for the store.
 *
 * To-one attributes replace: picking a record while one is linked swaps it.
 * When the OTHER side is to-one and the target is taken, the store refuses;
 * that surfaces as `conflict` so the caller can offer "Move it here".
 */
export function useRelationshipEdit({
  spaceId,
  recordId,
  typeId,
  attribute,
  linked,
}: RelationshipEditInput): RelationshipEdit {
  const linkMutation = useLinkRecords(spaceId);
  const unlinkMutation = useUnlinkRecords(spaceId);
  const [conflict, setConflict] = useState<LinkConflict | null>(null);
  const { mutateAsync: linkAsync } = linkMutation;
  const { mutateAsync: unlinkAsync } = unlinkMutation;
  const attributeSlug = attribute.slug;
  const replacesOnLink = holdsOne(attribute) && linked.length > 0;
  const canConflict = targetHoldsOne(attribute);

  const runLink = useCallback(
    async (targetId: string, replace: boolean): Promise<boolean> => {
      setConflict(null);
      try {
        await linkAsync({ recordId, typeId, attributeSlug, targetId, replace });
        return true;
      } catch (error: unknown) {
        const isConflict =
          !replace && canConflict && error instanceof DataValidationError;
        if (isConflict) {
          setConflict({ targetId, message: messageOf(error) });
        } else {
          showNotice(messageOf(error), "error");
        }
        return false;
      }
    },
    [attributeSlug, canConflict, linkAsync, recordId, typeId],
  );

  const link = useCallback(
    (targetId: string) => runLink(targetId, replacesOnLink),
    [replacesOnLink, runLink],
  );

  const moveHere = useCallback(
    () =>
      conflict ? runLink(conflict.targetId, true) : Promise.resolve(false),
    [conflict, runLink],
  );

  const unlink = useCallback(
    async (targetId: string): Promise<boolean> => {
      try {
        await unlinkAsync({ recordId, typeId, attributeSlug, targetId });
        return true;
      } catch (error: unknown) {
        showNotice(messageOf(error), "error");
        return false;
      }
    },
    [attributeSlug, recordId, typeId, unlinkAsync],
  );

  const dismissConflict = useCallback(() => setConflict(null), []);

  return {
    isPending: linkMutation.isPending || unlinkMutation.isPending,
    conflict,
    link,
    unlink,
    moveHere,
    dismissConflict,
  };
}
