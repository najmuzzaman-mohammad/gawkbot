import { useEffect, useState } from "react";

import type {
  DeleteImpact,
  DeleteKind,
  DeletePreview,
} from "../../api/dataspaces";
import { useExecuteDelete, usePreviewDelete } from "../../hooks/useDataSpaces";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/Dialog";
import { Button } from "./DataButton";

interface DeletePreviewDialogProps {
  spaceId: string;
  kind: DeleteKind;
  ids: readonly string[];
  /** What is being deleted, in the operator's words: `the Interview type`. */
  subjectLabel: string;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** Only the non-zero lines, so the preview reads as a sentence, not a form. */
export function describeImpact(impact: DeleteImpact): readonly string[] {
  const lines: string[] = [];
  if (impact.objectTypes > 0) {
    lines.push(plural(impact.objectTypes, "object type", "object types"));
  }
  if (impact.attributes > 0) {
    lines.push(plural(impact.attributes, "attribute", "attributes"));
  }
  if (impact.records > 0) {
    lines.push(plural(impact.records, "record", "records"));
  }
  if (impact.links > 0) {
    lines.push(
      plural(impact.links, "link between records", "links between records"),
    );
  }
  return lines;
}

/**
 * Two-phase delete. Opening the dialog asks the store what would be removed
 * and gets back a token bound to that exact id set; confirming executes the
 * token. Nothing is removed until the operator has seen the counts.
 */
export function DeletePreviewDialog({
  spaceId,
  kind,
  ids,
  subjectLabel,
  open,
  onClose,
  onDeleted,
}: DeletePreviewDialogProps) {
  // `mutateAsync` is referentially stable, so it is a safe effect dependency.
  const { mutateAsync: requestPreview } = usePreviewDelete(spaceId);
  const executeDelete = useExecuteDelete(spaceId);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!open) return;
    let isCurrent = true;
    setPreview(null);
    setError(null);
    requestPreview({ kind, ids: idsKey === "" ? [] : idsKey.split(",") })
      .then((next) => {
        if (isCurrent) setPreview(next);
      })
      .catch((cause: unknown) => {
        if (isCurrent) setError(errorMessage(cause));
      });
    return () => {
      isCurrent = false;
    };
  }, [open, kind, idsKey, requestPreview]);

  async function handleConfirm() {
    if (!preview) return;
    try {
      await executeDelete.mutateAsync(preview.token);
      onDeleted();
      onClose();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  const impactLines = preview ? describeImpact(preview.impact) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="data-dialog" data-testid="data-delete-preview">
        <DialogHeader>
          <DialogTitle>Delete {subjectLabel}?</DialogTitle>
          <DialogDescription>
            This cannot be undone. Here is everything that goes with it.
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          impactLines.length > 0 ? (
            <ul className="data-delete-impact">
              {impactLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="data-delete-impact-none">
              Nothing else depends on it.
            </p>
          )
        ) : error ? null : (
          <p className="data-delete-impact-none" aria-busy="true">
            Counting what would be removed…
          </p>
        )}
        {error ? (
          <p className="data-delete-error" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={!preview || executeDelete.isPending}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {executeDelete.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
