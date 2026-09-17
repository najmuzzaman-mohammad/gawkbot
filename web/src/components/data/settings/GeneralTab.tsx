import { type FormEvent, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { ObjectType, ObjectTypeInput } from "../../../api/dataspaces";
import { useUpdateObjectType } from "../../../hooks/useDataSpaces";
import { showNotice } from "../../ui/Toast";
import { Button } from "../DataButton";
import { DeletePreviewDialog } from "../DeletePreviewDialog";
import { IconPicker } from "../index/IconPicker";
import { copyText } from "./copyText";
import {
  errorMessage,
  FormError,
  ReadOnlyValue,
  TextAreaField,
  TextField,
} from "./formControls";

import "../../../styles/data-schema.css";

interface GeneralTabProps {
  spaceId: string;
  objectType: ObjectType;
  /**
   * Tells the page a delete is in flight. The schema refetch drops the type
   * a moment before the dialog reports back, and the page uses this to keep
   * the tab mounted instead of flashing a not-found state.
   */
  onDeleteOpenChange?: (isOpen: boolean) => void;
}

interface GeneralDraft {
  name: string;
  namePlural: string;
  icon: string;
  description: string;
}

function draftFor(type: ObjectType): GeneralDraft {
  return {
    name: type.name,
    namePlural: type.namePlural,
    icon: type.icon,
    description: type.description,
  };
}

/** Only what changed, so an untouched field is never rewritten. */
function patchFor(
  type: ObjectType,
  draft: GeneralDraft,
): Partial<ObjectTypeInput> {
  const name = draft.name.trim();
  const namePlural = draft.namePlural.trim();
  const description = draft.description.trim();
  return {
    ...(name !== type.name ? { name } : {}),
    ...(namePlural !== type.namePlural ? { namePlural } : {}),
    ...(draft.icon !== type.icon ? { icon: draft.icon } : {}),
    ...(description !== type.description ? { description } : {}),
  };
}

interface CopyButtonProps {
  value: string;
  what: string;
}

function CopyButton({ value, what }: CopyButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void copyText(value, what);
      }}
    >
      Copy<span className="data-visually-hidden"> {what.toLowerCase()}</span>
    </Button>
  );
}

/**
 * General settings of one object type: the editable display fields, the
 * identifiers bots and apps use, and the danger zone.
 */
export function GeneralTab({
  spaceId,
  objectType,
  onDeleteOpenChange,
}: GeneralTabProps) {
  const navigate = useNavigate();
  const updateObjectType = useUpdateObjectType(spaceId);
  const [draft, setDraft] = useState<GeneralDraft>(() => draftFor(objectType));
  const [error, setError] = useState<string | null>(null);
  const [isDeleteOpen, setIsDeleteOpenState] = useState(false);

  const hasDeletedRef = useRef(false);

  function setIsDeleteOpen(isOpen: boolean) {
    setIsDeleteOpenState(isOpen);
    // After a delete the page keeps holding the type until navigation lands.
    if (!hasDeletedRef.current) onDeleteOpenChange?.(isOpen);
  }

  const patch = patchFor(objectType, draft);
  const isDirty = Object.keys(patch).length > 0;
  const isBusy = updateObjectType.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.name.trim() === "" || draft.namePlural.trim() === "") {
      setError("The name and the plural name cannot be empty.");
      return;
    }
    setError(null);
    try {
      const saved = await updateObjectType.mutateAsync({
        typeId: objectType.id,
        patch,
      });
      setDraft(draftFor(saved));
      showNotice("Object type saved.", "success");
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="data-settings-panel">
      <section aria-labelledby="data-general-heading">
        <h2 className="data-section-heading" id="data-general-heading">
          General
        </h2>
        <form
          className="data-form data-form--page"
          noValidate={true}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div className="data-form-row">
            <TextField
              label="Name"
              value={draft.name}
              isRequired={true}
              disabled={isBusy}
              autoComplete="off"
              onChange={(name) => setDraft({ ...draft, name })}
            />
            <TextField
              label="Plural name"
              value={draft.namePlural}
              isRequired={true}
              disabled={isBusy}
              autoComplete="off"
              onChange={(namePlural) => setDraft({ ...draft, namePlural })}
            />
          </div>
          <IconPicker
            value={draft.icon}
            disabled={isBusy}
            onChange={(icon) => setDraft({ ...draft, icon })}
          />
          <TextAreaField
            label="Description"
            value={draft.description}
            disabled={isBusy}
            onChange={(description) => setDraft({ ...draft, description })}
          />
          <FormError message={error} />
          <div>
            <Button type="submit" disabled={!isDirty || isBusy}>
              {isBusy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="data-identifiers-heading">
        <h2 className="data-section-heading" id="data-identifiers-heading">
          Identifiers
        </h2>
        <div className="data-form data-form--page">
          <ReadOnlyValue
            label="Slug"
            value={objectType.slug}
            isMono={true}
            hint="Bots and apps address this object type by its slug. A rename never changes it."
            action={<CopyButton value={objectType.slug} what="Slug" />}
          />
          <ReadOnlyValue
            label="Id"
            value={objectType.id}
            isMono={true}
            action={<CopyButton value={objectType.id} what="Id" />}
          />
        </div>
      </section>

      <section
        className="data-danger-zone"
        aria-labelledby="data-danger-heading"
      >
        <h2 className="data-section-heading" id="data-danger-heading">
          Danger zone
        </h2>
        {/* TODO(agent-data-model): "Delete all records" is not shipped. The
            delete preview takes an explicit id set for kind `records`, and
            collecting every record id of a type from the client does not
            scale past one page. It needs a server operation (for example a
            `records_of_type` delete kind) before it can be offered here. */}
        <div className="data-danger-row">
          <div>
            <p className="data-danger-title">Delete object type</p>
            <p className="data-form-hint">
              Removes {objectType.name}, its attributes, its{" "}
              {objectType.recordCount.toLocaleString()} records, and every link
              to them. You see the exact counts before anything is removed.
            </p>
          </div>
          <Button
            type="button"
            variant="destructive"
            onClick={() => setIsDeleteOpen(true)}
          >
            Delete object type
          </Button>
        </div>
      </section>

      <DeletePreviewDialog
        spaceId={spaceId}
        kind="object_type"
        ids={[objectType.id]}
        subjectLabel={`the ${objectType.name} object type`}
        open={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        onDeleted={() => {
          hasDeletedRef.current = true;
          showNotice(`Deleted ${objectType.name}.`, "success");
          void navigate({ to: "/data/$spaceId", params: { spaceId } });
        }}
      />
    </div>
  );
}
