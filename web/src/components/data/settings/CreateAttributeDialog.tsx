import { type FormEvent, useEffect, useState } from "react";

import type {
  AttributeInput,
  AttributeType,
  ObjectType,
} from "../../../api/dataspaces";
import { useAddAttribute } from "../../../hooks/useDataSpaces";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";
import { showNotice } from "../../ui/Toast";
import { Button } from "../DataButton";
import { AttributeTypeIcon } from "../values/attributeTypeIcon";
import { attributeTypeLabel } from "../values/valueFormat";
import { AttributeTypePicker } from "./AttributeTypePicker";
import {
  type AttributeDraft,
  attributeDraftToInput,
  CURRENCY_CODES,
  DEFAULT_STATUS_OPTIONS_HINT,
  emptyAttributeDraft,
  hasOptions,
  supportsMultivalue,
  supportsUnique,
  validateAttributeDraft,
} from "./attributeDraft";
import {
  CheckField,
  errorMessage,
  FormError,
  FormField,
  TextAreaField,
  TextField,
} from "./formControls";
import { OptionsEditor } from "./OptionsEditor";
import { RelationshipForm } from "./RelationshipForm";
import {
  DEFAULT_RELATIONSHIP_CARDINALITY,
  type RelationshipDraft,
  validateRelationshipDraft,
} from "./relationshipDefaults";

import "../../../styles/data-schema.css";

interface CreateAttributeDialogProps {
  spaceId: string;
  objectType: ObjectType;
  /** Every type in the space, for the relationship target select. */
  objectTypes: readonly ObjectType[];
  open: boolean;
  onClose: () => void;
}

const EMPTY_RELATIONSHIP: RelationshipDraft = {
  targetTypeId: "",
  name: "",
  cardinality: DEFAULT_RELATIONSHIP_CARDINALITY,
  hasInverse: true,
  inverseName: "",
};

type Step =
  | { kind: "pick" }
  | { kind: "value"; draft: AttributeDraft }
  | { kind: "relationship"; draft: RelationshipDraft };

function stepForType(type: AttributeType): Step {
  return type === "relationship"
    ? { kind: "relationship", draft: EMPTY_RELATIONSHIP }
    : { kind: "value", draft: emptyAttributeDraft(type) };
}

function relationshipInput(draft: RelationshipDraft): AttributeInput {
  return {
    name: draft.name.trim(),
    type: "relationship",
    relationship: {
      targetTypeId: draft.targetTypeId,
      cardinality: draft.cardinality,
      inverseName: draft.hasInverse ? draft.inverseName.trim() : "",
    },
  };
}

interface ValueAttributeFieldsProps {
  draft: AttributeDraft;
  onChange: (draft: AttributeDraft) => void;
  disabled: boolean;
}

/** The controls a type supports, and only those. */
function ValueAttributeFields({
  draft,
  onChange,
  disabled,
}: ValueAttributeFieldsProps) {
  return (
    <>
      <TextField
        label="Name"
        value={draft.name}
        isRequired={true}
        disabled={disabled}
        autoComplete="off"
        onChange={(name) => onChange({ ...draft, name })}
      />
      <TextAreaField
        label="Description"
        value={draft.description}
        disabled={disabled}
        onChange={(description) => onChange({ ...draft, description })}
      />
      {draft.type === "currency" ? (
        <FormField label="Currency" hint="Cannot change after creation.">
          {({ controlId, hintId }) => (
            <select
              id={controlId}
              className="data-form-input"
              value={draft.currencyCode}
              disabled={disabled}
              aria-describedby={hintId}
              onChange={(event) =>
                onChange({ ...draft, currencyCode: event.target.value })
              }
            >
              {CURRENCY_CODES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          )}
        </FormField>
      ) : null}
      {hasOptions(draft.type) ? (
        <OptionsEditor
          options={draft.options}
          disabled={disabled}
          hint={
            draft.type === "status"
              ? `Leave empty to use the defaults. ${DEFAULT_STATUS_OPTIONS_HINT}`
              : "A select attribute needs at least one option."
          }
          onChange={(options) => onChange({ ...draft, options })}
        />
      ) : null}
      <CheckField
        label="Required"
        checked={draft.isRequired}
        disabled={disabled}
        hint="A record cannot be saved without a value."
        onChange={(isRequired) => onChange({ ...draft, isRequired })}
      />
      {supportsUnique(draft.type) ? (
        <CheckField
          label="Unique"
          checked={draft.isUnique}
          disabled={disabled || draft.isMultivalue}
          hint="No two records can share a value. Bots use unique attributes to avoid duplicates. Cannot change after creation."
          onChange={(isUnique) => onChange({ ...draft, isUnique })}
        />
      ) : null}
      {supportsMultivalue(draft.type) ? (
        <CheckField
          label="Multiple values"
          checked={draft.isMultivalue}
          disabled={disabled || draft.isUnique}
          hint={
            draft.isUnique
              ? "A unique attribute holds one value."
              : "A record can hold more than one value. Cannot change after creation."
          }
          onChange={(isMultivalue) => onChange({ ...draft, isMultivalue })}
        />
      ) : null}
    </>
  );
}

/**
 * New attribute, in two steps: pick the type, then fill in the controls that
 * type supports. Picking Relation swaps the body for the relationship form.
 */
export function CreateAttributeDialog({
  spaceId,
  objectType,
  objectTypes,
  open,
  onClose,
}: CreateAttributeDialogProps) {
  const addAttribute = useAddAttribute(spaceId);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const isBusy = addAttribute.isPending;

  useEffect(() => {
    if (open) {
      setStep({ kind: "pick" });
      setError(null);
    }
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind === "pick") return;
    const problem =
      step.kind === "value"
        ? validateAttributeDraft(step.draft)
        : validateRelationshipDraft(step.draft);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    const input =
      step.kind === "value"
        ? attributeDraftToInput(step.draft)
        : relationshipInput(step.draft);
    try {
      const created = await addAttribute.mutateAsync({
        typeId: objectType.id,
        input,
      });
      showNotice(`Added ${created.name} to ${objectType.name}.`, "success");
      onClose();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  const pickedType: AttributeType | null =
    step.kind === "pick"
      ? null
      : step.kind === "value"
        ? step.draft.type
        : "relationship";
  const hasNoTargets =
    step.kind === "relationship" &&
    objectTypes.every((type) => type.id === objectType.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="data-dialog data-dialog--wide"
        data-testid="data-create-attribute"
      >
        <DialogHeader>
          <DialogTitle>New attribute on {objectType.name}</DialogTitle>
          <DialogDescription>
            {pickedType === null
              ? "Pick the type first. It cannot change after creation."
              : "The type cannot change after creation."}
          </DialogDescription>
        </DialogHeader>
        {pickedType === null ? (
          <AttributeTypePicker
            onPick={(type) => {
              setError(null);
              setStep(stepForType(type));
            }}
          />
        ) : (
          <form
            className="data-form"
            noValidate={true}
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
          >
            <div className="data-picked-type">
              <AttributeTypeIcon type={pickedType} />
              <span>{attributeTypeLabel(pickedType)}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isBusy}
                onClick={() => {
                  setError(null);
                  setStep({ kind: "pick" });
                }}
              >
                Change type
              </Button>
            </div>
            {step.kind === "value" ? (
              <ValueAttributeFields
                draft={step.draft}
                disabled={isBusy}
                onChange={(draft) => setStep({ kind: "value", draft })}
              />
            ) : null}
            {step.kind === "relationship" ? (
              <RelationshipForm
                sourceType={objectType}
                objectTypes={objectTypes}
                draft={step.draft}
                disabled={isBusy}
                onChange={(draft) => setStep({ kind: "relationship", draft })}
              />
            ) : null}
            <FormError message={error} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isBusy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isBusy || hasNoTargets}>
                {isBusy ? "Adding…" : "Add attribute"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
