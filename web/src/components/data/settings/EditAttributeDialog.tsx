import { type FormEvent, useState } from "react";

import type {
  AttributeDefinition,
  AttributePatch,
} from "../../../api/dataspaces";
import { useUpdateAttribute } from "../../../hooks/useDataSpaces";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";
import { Button } from "../DataButton";
import { attributeTypeLabel } from "../values/valueFormat";
import { type DraftOption, hasOptions, mintOptionKey } from "./attributeDraft";
import {
  CheckField,
  errorMessage,
  FormError,
  ReadOnlyValue,
  TextAreaField,
  TextField,
} from "./formControls";

import "../../../styles/data-schema.css";

const IMMUTABLE_HINT = "Cannot change after creation.";

interface EditAttributeDialogProps {
  spaceId: string;
  typeId: string;
  /**
   * The parent mounts the dialog per attribute (`key={attribute.id}`), so the
   * draft starts from this value once and a background schema refetch never
   * resets what the operator has typed.
   */
  attribute: AttributeDefinition;
  onClose: () => void;
}

interface EditDraft {
  name: string;
  description: string;
  isRequired: boolean;
  /** Option id to its edited name. */
  optionNames: Readonly<Record<string, string>>;
  /** Options that do not exist yet. */
  newOptions: readonly DraftOption[];
  pendingOption: string;
}

function draftFor(attribute: AttributeDefinition): EditDraft {
  return {
    name: attribute.name,
    description: attribute.description,
    isRequired: attribute.isRequired,
    optionNames: Object.fromEntries(
      attribute.options.map((option) => [option.id, option.name]),
    ),
    newOptions: [],
    pendingOption: "",
  };
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/**
 * The store takes one option rename per patch, so an edit becomes a short
 * sequence: the field changes and new options first, then each rename.
 */
function patchesFor(
  attribute: AttributeDefinition,
  draft: EditDraft,
): readonly AttributePatch[] {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const pending = draft.pendingOption.trim();
  const addOptions = [
    ...draft.newOptions.map((option) => option.name),
    ...(pending === "" ? [] : [pending]),
  ];
  const main: AttributePatch = {
    ...(name !== attribute.name ? { name } : {}),
    ...(description !== attribute.description ? { description } : {}),
    ...(draft.isRequired !== attribute.isRequired
      ? { isRequired: draft.isRequired }
      : {}),
    ...(addOptions.length > 0 ? { addOptions } : {}),
  };
  const renames: AttributePatch[] = attribute.options
    .filter((option) => {
      const edited = draft.optionNames[option.id]?.trim() ?? option.name;
      return edited !== "" && edited !== option.name;
    })
    .map((option) => ({
      renameOption: {
        id: option.id,
        name: draft.optionNames[option.id].trim(),
      },
    }));
  return [...(Object.keys(main).length > 0 ? [main] : []), ...renames];
}

/**
 * Edit an attribute. Name, description, required, and the option list can
 * change; type, unique, and multiple are fixed at creation and shown
 * read-only so the operator can see why.
 */
export function EditAttributeDialog({
  spaceId,
  typeId,
  attribute,
  onClose,
}: EditAttributeDialogProps) {
  const updateAttribute = useUpdateAttribute(spaceId);
  const [draft, setDraft] = useState<EditDraft>(() => draftFor(attribute));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const withOptions = hasOptions(attribute.type);
  // The primary attribute is always required; a relationship never is.
  const isRequiredLocked =
    attribute.isPrimary || attribute.type === "relationship";
  const patches = patchesFor(attribute, draft);
  const isDirty = patches.length > 0;

  function addPendingOption() {
    setDraft((current) => {
      const pending = current.pendingOption.trim();
      if (pending === "") return current;
      return {
        ...current,
        newOptions: [
          ...current.newOptions,
          { key: mintOptionKey(), name: pending },
        ],
        pendingOption: "",
      };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Captured now: each patch refetches the schema and changes `patches`.
    const toApply = patches;
    if (draft.name.trim() === "") {
      setError("The attribute needs a name.");
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      for (const patch of toApply) {
        await updateAttribute.mutateAsync({
          typeId,
          attributeId: attribute.id,
          patch,
        });
      }
      onClose();
    } catch (cause: unknown) {
      // Earlier patches in the sequence may have landed; the refetched
      // schema shows exactly what did.
      setError(errorMessage(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog
      open={true}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="data-dialog" data-testid="data-edit-attribute">
        <DialogHeader>
          <DialogTitle>Edit {attribute.name}</DialogTitle>
          <DialogDescription>
            A rename changes the display name only. The slug stays the same, so
            bots and apps keep working.
          </DialogDescription>
        </DialogHeader>
        <form
          className="data-form"
          noValidate={true}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <TextField
            label="Name"
            value={draft.name}
            isRequired={true}
            disabled={isSaving}
            autoComplete="off"
            onChange={(name) => setDraft({ ...draft, name })}
          />
          <TextAreaField
            label="Description"
            value={draft.description}
            disabled={isSaving}
            onChange={(description) => setDraft({ ...draft, description })}
          />
          <CheckField
            label="Required"
            checked={draft.isRequired}
            disabled={isSaving || isRequiredLocked}
            hint={
              attribute.isPrimary
                ? "The primary attribute is always required."
                : attribute.type === "relationship"
                  ? "A relationship attribute cannot be required."
                  : "A record cannot be saved without a value."
            }
            onChange={(isRequired) => setDraft({ ...draft, isRequired })}
          />
          {withOptions ? (
            <fieldset className="data-options-editor" disabled={isSaving}>
              <legend className="data-form-label">Options</legend>
              <ol className="data-options-list">
                {attribute.options.map((option, index) => (
                  <li key={option.id} className="data-options-row">
                    <input
                      className="data-form-input"
                      type="text"
                      aria-label={`Option ${index + 1}`}
                      value={draft.optionNames[option.id] ?? option.name}
                      autoComplete="off"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          optionNames: {
                            ...draft.optionNames,
                            [option.id]: event.target.value,
                          },
                        })
                      }
                    />
                  </li>
                ))}
                {draft.newOptions.map((added) => (
                  <li
                    key={added.key}
                    className="data-options-row data-options-row--new"
                  >
                    <span>{added.name}</span>
                    <span className="data-chip">New</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove new option ${added.name}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          newOptions: draft.newOptions.filter(
                            (other) => other.key !== added.key,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ol>
              <div className="data-options-row">
                <input
                  className="data-form-input"
                  type="text"
                  aria-label="New option name"
                  placeholder="New option"
                  value={draft.pendingOption}
                  autoComplete="off"
                  onChange={(event) =>
                    setDraft({ ...draft, pendingOption: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addPendingOption();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={draft.pendingOption.trim() === ""}
                  onClick={addPendingOption}
                >
                  Add option
                </Button>
              </div>
              <p className="data-form-hint">
                Renaming keeps existing records pointing at the same option.
                Options cannot be removed yet.
              </p>
            </fieldset>
          ) : null}
          <div className="data-form-row data-form-row--thirds">
            <ReadOnlyValue
              label="Type"
              value={attributeTypeLabel(attribute.type)}
            />
            <ReadOnlyValue label="Unique" value={yesNo(attribute.isUnique)} />
            <ReadOnlyValue
              label="Multiple values"
              value={yesNo(attribute.isMultivalue)}
            />
          </div>
          <p className="data-form-hint">{IMMUTABLE_HINT}</p>
          <FormError message={error} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || !isDirty}>
              {isSaving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
