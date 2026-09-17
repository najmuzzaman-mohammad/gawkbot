import { type FormEvent, useId, useState } from "react";

import {
  type AttributeDefinition,
  type AttributeValue,
  type DataRecord,
  DataValidationError,
  type ObjectType,
} from "../../../api/dataspaces";
import { useCreateRecord } from "../../../hooks/useDataSpaces";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";
import { Button } from "../DataButton";
import { AttributeTypeIcon } from "../values/attributeTypeIcon";
import { ValueField } from "../values/ValueField";
import { draftToValue } from "../values/valueFormat";
import { valueAttributes } from "./recordModel";

import "../../../styles/data-records.css";

export interface NewRecordDialogProps {
  spaceId: string;
  type: ObjectType;
  open: boolean;
  onClose: () => void;
  onCreated: (record: DataRecord) => void;
}

interface FormError {
  /** Attribute slug the store blamed, or null for a form-level error. */
  attribute: string | null;
  message: string;
}

/** Required attributes first (primary at the very top), then the rest. */
export function splitFormAttributes(type: ObjectType): {
  required: readonly AttributeDefinition[];
  optional: readonly AttributeDefinition[];
} {
  const attributes = valueAttributes(type);
  const required = attributes
    .filter((attribute) => attribute.isRequired || attribute.isPrimary)
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));
  const optional = attributes.filter(
    (attribute) => !(attribute.isRequired || attribute.isPrimary),
  );
  return { required, optional };
}

function toFormError(error: unknown): FormError {
  if (error instanceof DataValidationError) {
    return { attribute: error.attribute, message: error.message };
  }
  return {
    attribute: null,
    message:
      error instanceof Error && error.message !== ""
        ? error.message
        : "The record could not be created.",
  };
}

interface FieldRowProps {
  formId: string;
  attribute: AttributeDefinition;
  draft: string;
  error: string | null;
  disabled: boolean;
  autoFocus: boolean;
  onDraftChange: (next: string) => void;
}

function FieldRow({
  formId,
  attribute,
  draft,
  error,
  disabled,
  autoFocus,
  onDraftChange,
}: FieldRowProps) {
  const fieldId = `${formId}-${attribute.slug}`;
  const errorId = `${fieldId}-error`;
  return (
    <div className="dr-form-row" data-invalid={error ? "true" : "false"}>
      <label className="dr-form-label" htmlFor={fieldId}>
        <AttributeTypeIcon type={attribute.type} />
        {attribute.name}
        {attribute.isRequired ? (
          <span className="dr-form-required"> (required)</span>
        ) : null}
      </label>
      {/* No onCommit: Enter in one field must not submit half a form. */}
      <ValueField
        id={fieldId}
        attribute={attribute}
        draft={draft}
        onDraftChange={onDraftChange}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {error ? (
        <p id={errorId} className="dr-form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Create one record. Every field is the same editor the table uses.
 * Relationship attributes are left out on purpose: a record is linked after
 * it exists, from its row or its page.
 */
export function NewRecordDialog({
  spaceId,
  type,
  open,
  onClose,
  onCreated,
}: NewRecordDialogProps) {
  const formId = useId();
  const createRecord = useCreateRecord(spaceId);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<FormError | null>(null);
  const [isOptionalOpen, setIsOptionalOpen] = useState(false);
  const { required, optional } = splitFormAttributes(type);

  const reset = () => {
    setDrafts({});
    setError(null);
    setIsOptionalOpen(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const values: Record<string, AttributeValue> = {};
    for (const attribute of [...required, ...optional]) {
      const value = draftToValue(attribute, drafts[attribute.slug] ?? "");
      if (value !== null) values[attribute.slug] = value;
    }
    try {
      const record = await createRecord.mutateAsync({
        typeId: type.id,
        values,
      });
      reset();
      onCreated(record);
    } catch (cause: unknown) {
      const next = toFormError(cause);
      // The field with the problem must be on screen to show its message.
      if (optional.some((attribute) => attribute.slug === next.attribute)) {
        setIsOptionalOpen(true);
      }
      setError(next);
    }
  };

  const knownSlugs = new Set(
    [...required, ...optional].map((attribute) => attribute.slug),
  );
  const formLevelError =
    error && !(error.attribute && knownSlugs.has(error.attribute))
      ? error.message
      : null;

  const renderRow = (attribute: AttributeDefinition, index: number) => (
    <FieldRow
      key={attribute.slug}
      formId={formId}
      attribute={attribute}
      draft={drafts[attribute.slug] ?? ""}
      error={error?.attribute === attribute.slug ? error.message : null}
      disabled={createRecord.isPending}
      autoFocus={index === 0 && attribute.isPrimary}
      onDraftChange={(next) =>
        setDrafts((current) => ({ ...current, [attribute.slug]: next }))
      }
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="dr-dialog" data-testid="data-new-record">
        <DialogHeader>
          <DialogTitle>Add {type.name}</DialogTitle>
          <DialogDescription>
            Links to other records are added after the {type.name.toLowerCase()}{" "}
            exists.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="dr-form"
          noValidate={true}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          {formLevelError ? (
            <p className="dr-form-error" role="alert">
              {formLevelError}
            </p>
          ) : null}
          {required.map(renderRow)}
          {optional.length > 0 ? (
            <details
              className="dr-form-optional"
              open={isOptionalOpen}
              onToggle={(event) => setIsOptionalOpen(event.currentTarget.open)}
            >
              <summary>Optional attributes</summary>
              <div className="dr-form-optional-body">
                {optional.map(renderRow)}
              </div>
            </details>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={createRecord.isPending}>
            {createRecord.isPending ? "Adding" : `Add ${type.name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
