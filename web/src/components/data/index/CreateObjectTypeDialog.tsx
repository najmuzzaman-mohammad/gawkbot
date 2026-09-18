import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useCreateObjectType } from "../../../hooks/useDataSpaces";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";
import { Button } from "../DataButton";
import {
  errorMessage,
  FormError,
  ReadOnlyValue,
  TextAreaField,
  TextField,
} from "../settings/formControls";
import { IconPicker } from "./IconPicker";
import { pluralize, slugPreview } from "./naming";

import "../../../styles/data-schema.css";

const DEFAULT_ICON = "box";

interface CreateObjectTypeDialogProps {
  spaceId: string;
  /** Slugs already used in the space, so the preview shows the real suffix. */
  takenSlugs: readonly string[];
  open: boolean;
  onClose: () => void;
}

interface ObjectTypeDraft {
  name: string;
  namePlural: string;
  /** Once the operator types a plural, the name stops driving it. */
  isPluralEdited: boolean;
  icon: string;
  description: string;
}

const EMPTY_DRAFT: ObjectTypeDraft = {
  name: "",
  namePlural: "",
  isPluralEdited: false,
  icon: DEFAULT_ICON,
  description: "",
};

/**
 * New object type. The store adds the primary Name attribute itself, so the
 * dialog only asks what the thing is called; on success the operator lands
 * on the new type's Attributes tab to shape it.
 */
export function CreateObjectTypeDialog({
  spaceId,
  takenSlugs,
  open,
  onClose,
}: CreateObjectTypeDialogProps) {
  const navigate = useNavigate();
  const createObjectType = useCreateObjectType(spaceId);
  const [draft, setDraft] = useState<ObjectTypeDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(EMPTY_DRAFT);
      setError(null);
    }
  }, [open]);

  const trimmedName = draft.name.trim();
  const isBusy = createObjectType.isPending;

  function handleNameChange(name: string) {
    setDraft((current) => ({
      ...current,
      name,
      namePlural: current.isPluralEdited ? current.namePlural : pluralize(name),
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmedName === "") {
      setError("An object type needs a name.");
      return;
    }
    setError(null);
    try {
      const created = await createObjectType.mutateAsync({
        name: trimmedName,
        namePlural: draft.namePlural.trim() || pluralize(trimmedName),
        icon: draft.icon,
        description: draft.description.trim(),
      });
      onClose();
      await navigate({
        to: "/data/$spaceId/t/$typeSlug/settings",
        params: { spaceId, typeSlug: created.slug },
        search: { tab: "attributes" },
      });
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="data-dialog" data-testid="data-create-type">
        <DialogHeader>
          <DialogTitle>New object type</DialogTitle>
          <DialogDescription>
            An object type is one kind of thing you keep records of, such as an
            investor or a project. It starts with a Name attribute.
          </DialogDescription>
        </DialogHeader>
        <form
          className="data-form"
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
              placeholder="Investor"
              autoComplete="off"
              onChange={handleNameChange}
            />
            <TextField
              label="Plural name"
              value={draft.namePlural}
              disabled={isBusy}
              placeholder="Investors"
              autoComplete="off"
              onChange={(namePlural) =>
                setDraft((current) => ({
                  ...current,
                  namePlural,
                  isPluralEdited: true,
                }))
              }
            />
          </div>
          <ReadOnlyValue
            label="Slug"
            value={
              trimmedName === ""
                ? "Type a name to see it"
                : slugPreview(trimmedName, takenSlugs)
            }
            isMono={trimmedName !== ""}
            hint="Bots and apps use the slug. It is set once and a rename never changes it."
          />
          <IconPicker
            value={draft.icon}
            disabled={isBusy}
            onChange={(icon) => setDraft((current) => ({ ...current, icon }))}
          />
          <TextAreaField
            label="Description"
            value={draft.description}
            disabled={isBusy}
            placeholder="What one record of this type stands for."
            onChange={(description) =>
              setDraft((current) => ({ ...current, description }))
            }
          />
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
            <Button type="submit" disabled={isBusy || trimmedName === ""}>
              {isBusy ? "Creating…" : "Create object type"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
