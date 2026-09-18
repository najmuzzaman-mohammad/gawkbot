import { type FormEvent, useId, useState } from "react";

import {
  type DataSpace,
  SPACE_SCOPES,
  type SpaceScope,
} from "../../../api/dataspaces";
import { useUpdateSpaceAccess } from "../../../hooks/useDataSpaces";
import { useOfficeMembers } from "../../../hooks/useMembers";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";
import { PixelAvatar } from "../../ui/PixelAvatar";
import { showNotice } from "../../ui/Toast";
import { Button } from "../DataButton";
import { errorMessage, FormError } from "../settings/formControls";
import {
  type AccessDraft,
  type BotRow,
  DRAFT_LEVEL_LABELS,
  DRAFT_LEVELS,
  draftFromAccess,
  draftLevel,
  draftToAccess,
  filterBotRows,
  isAccessDirty,
  isBecomingGlobal,
  isSharedWithNobody,
  mergeRoster,
  ROSTER_FILTER_THRESHOLD,
  SCOPE_LABELS,
  scopeExplanation,
  setDraftLevel,
} from "./accessDraft";

import "../../../styles/data-schema.css";

const BOT_AVATAR_SIZE = 18;

interface BotLevelRowProps {
  row: BotRow;
  draft: AccessDraft;
  onChange: (draft: AccessDraft) => void;
}

/** One bot: avatar, slug, and a three-way radio group drawn as segments. */
function BotLevelRow({ row, draft, onChange }: BotLevelRowProps) {
  const groupName = useId();
  const current = draftLevel(draft, row.bot);
  return (
    <li className="data-share-bot">
      <span className="data-share-bot-name">
        <PixelAvatar slug={row.bot} size={BOT_AVATAR_SIZE} />
        <span>@{row.bot}</span>
        {row.isInOffice ? null : (
          <span className="data-chip">not in the office</span>
        )}
      </span>
      <fieldset className="data-segmented">
        <legend className="data-visually-hidden">Access for @{row.bot}</legend>
        {DRAFT_LEVELS.map((level) => (
          <label key={level} className="data-segmented-option">
            <input
              type="radio"
              name={groupName}
              value={level}
              checked={current === level}
              onChange={() => onChange(setDraftLevel(draft, row.bot, level))}
            />
            <span>{DRAFT_LEVEL_LABELS[level]}</span>
          </label>
        ))}
      </fieldset>
    </li>
  );
}

interface ShareSpaceDialogViewProps {
  space: DataSpace;
  /** Office bot slugs. The owner and the operator are filtered out here. */
  roster: readonly string[];
  onClose: () => void;
}

/**
 * The sharing form over a given roster. `ShareSpaceDialog` feeds it the live
 * office roster; stories and tests can hand it any list.
 */
export function ShareSpaceDialogView({
  space,
  roster,
  onClose,
}: ShareSpaceDialogViewProps) {
  const scopeGroupName = useId();
  const filterId = useId();
  const updateAccess = useUpdateSpaceAccess();
  const [draft, setDraft] = useState<AccessDraft>(() =>
    draftFromAccess(space.access),
  );
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rows = mergeRoster(space.owner, roster, space.access);
  const visibleRows = filterBotRows(rows, filter);
  const isBusy = updateAccess.isPending;
  const isDirty = isAccessDirty(space.owner, space.access, draft);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await updateAccess.mutateAsync({
        spaceId: space.id,
        access: draftToAccess(space.owner, draft),
      });
      showNotice("Sharing updated", "success");
      onClose();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={true}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="data-dialog" data-testid="data-share-space">
        <DialogHeader>
          <DialogTitle>Share {space.name}</DialogTitle>
          <DialogDescription>
            Choose which bots can use this data space. You always have full
            access.
          </DialogDescription>
        </DialogHeader>
        <form
          className="data-form"
          noValidate={true}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <fieldset className="data-mode-group" disabled={isBusy}>
            <legend className="data-form-label">Who can use it</legend>
            {SPACE_SCOPES.map((scope: SpaceScope) => {
              const inputId = `${scopeGroupName}-${scope}`;
              const hintId = `${inputId}-hint`;
              return (
                <div key={scope} className="data-mode-option">
                  <input
                    id={inputId}
                    type="radio"
                    name={scopeGroupName}
                    value={scope}
                    checked={draft.scope === scope}
                    aria-describedby={hintId}
                    onChange={() => setDraft({ ...draft, scope })}
                  />
                  <div className="data-form-check-text">
                    <label htmlFor={inputId}>{SCOPE_LABELS[scope]}</label>
                    <p className="data-form-hint" id={hintId}>
                      {scopeExplanation(scope, space.owner)}
                    </p>
                  </div>
                </div>
              );
            })}
          </fieldset>
          {draft.scope === "shared" ? (
            <fieldset className="data-share-bots" disabled={isBusy}>
              <legend className="data-form-label">Bots</legend>
              {rows.length > ROSTER_FILTER_THRESHOLD ? (
                <>
                  <label className="data-visually-hidden" htmlFor={filterId}>
                    Filter bots
                  </label>
                  <input
                    id={filterId}
                    className="data-form-input"
                    type="search"
                    placeholder="Filter bots"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </>
              ) : null}
              {rows.length === 0 ? (
                <p className="data-form-hint">
                  @{space.owner} is the only bot in the office. Add another bot
                  to share with it.
                </p>
              ) : visibleRows.length === 0 ? (
                <p className="data-form-hint">
                  No bot matches "{filter.trim()}".
                </p>
              ) : (
                <ul className="data-share-bot-list">
                  {visibleRows.map((row) => (
                    <BotLevelRow
                      key={row.bot}
                      row={row}
                      draft={draft}
                      onChange={setDraft}
                    />
                  ))}
                </ul>
              )}
              {isSharedWithNobody(space.owner, draft) ? (
                <p className="data-form-hint" role="status">
                  Pick at least one bot, or choose Private.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          {isBecomingGlobal(space.access, draft) ? (
            <p className="data-share-confirm" role="status">
              Every bot will be able to change this data.
            </p>
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
            <Button type="submit" disabled={isBusy || !isDirty}>
              {isBusy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ShareSpaceDialogProps {
  space: DataSpace;
  onClose: () => void;
}

/**
 * Sharing for one data space, over the live office roster. Mount it while it
 * is open (the draft starts from the stored access once).
 */
export function ShareSpaceDialog({ space, onClose }: ShareSpaceDialogProps) {
  const membersQuery = useOfficeMembers();
  // Until the roster arrives, treat the granted bots as present, so nobody is
  // marked "not in the office" on the strength of a request still in flight.
  const roster = membersQuery.data
    ? membersQuery.data.map((member) => member.slug)
    : space.access.grants.map((grant) => grant.bot);
  return (
    <ShareSpaceDialogView space={space} roster={roster} onClose={onClose} />
  );
}
