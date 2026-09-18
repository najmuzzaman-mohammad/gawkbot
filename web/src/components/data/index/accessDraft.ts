/**
 * Draft state for the sharing dialog. Pure: draft to and from `SpaceAccess`,
 * dirtiness, and the bot rows (office roster merged with orphan grants).
 */

import type {
  AccessLevel,
  SpaceAccess,
  SpaceScope,
} from "../../../api/dataspaces";
import {
  normalizeAccess,
  normalizeBotSlug,
} from "../../../api/dataspacesAccess";

export type DraftLevel = AccessLevel | "none";

export const DRAFT_LEVELS: readonly DraftLevel[] = ["none", "read", "write"];

export const DRAFT_LEVEL_LABELS: Readonly<Record<DraftLevel, string>> = {
  none: "No access",
  read: "Can read",
  write: "Can write",
};

export interface AccessDraft {
  scope: SpaceScope;
  /** Bot slug to level. A missing bot means "none". */
  levels: Readonly<Record<string, DraftLevel>>;
}

/** The operator's slug in the office roster; never a grantee. */
export const HUMAN_SLUG = "human";
/** Above this many bots the dialog shows a filter input. */
export const ROSTER_FILTER_THRESHOLD = 8;

export function draftFromAccess(access: SpaceAccess): AccessDraft {
  return {
    scope: access.scope,
    levels: Object.fromEntries(
      access.grants.map((grant) => [normalizeBotSlug(grant.bot), grant.level]),
    ),
  };
}

export function draftLevel(draft: AccessDraft, bot: string): DraftLevel {
  return draft.levels[bot] ?? "none";
}

export function setDraftLevel(
  draft: AccessDraft,
  bot: string,
  level: DraftLevel,
): AccessDraft {
  return { ...draft, levels: { ...draft.levels, [bot]: level } };
}

/**
 * The access the draft would store, in canonical form. Shared with nobody
 * comes back as private, the same way the store treats it.
 */
export function draftToAccess(owner: string, draft: AccessDraft): SpaceAccess {
  const grants = Object.entries(draft.levels).flatMap(([bot, level]) =>
    level === "none" ? [] : [{ bot, level }],
  );
  return normalizeAccess(owner, { scope: draft.scope, grants });
}

function sameAccess(a: SpaceAccess, b: SpaceAccess): boolean {
  return (
    a.scope === b.scope &&
    a.grants.length === b.grants.length &&
    a.grants.every(
      (grant, index) =>
        grant.bot === b.grants[index].bot &&
        grant.level === b.grants[index].level,
    )
  );
}

export function isAccessDirty(
  owner: string,
  stored: SpaceAccess,
  draft: AccessDraft,
): boolean {
  return !sameAccess(
    normalizeAccess(owner, stored),
    draftToAccess(owner, draft),
  );
}

/** Shared is picked but no bot has a level: it would store as private. */
export function isSharedWithNobody(owner: string, draft: AccessDraft): boolean {
  return (
    draft.scope === "shared" && draftToAccess(owner, draft).scope === "private"
  );
}

/** True when saving would newly open the space to every bot. */
export function isBecomingGlobal(
  stored: SpaceAccess,
  draft: AccessDraft,
): boolean {
  return draft.scope === "global" && stored.scope !== "global";
}

export interface BotRow {
  bot: string;
  /** False for a bot that holds a grant but is not in the roster. */
  isInOffice: boolean;
}

/**
 * Office bots except the owner and the operator, in roster order, followed by
 * every bot that holds a grant without being in the roster. A grant is never
 * invisible, so it can always be revoked.
 */
export function mergeRoster(
  owner: string,
  roster: readonly string[],
  stored: SpaceAccess,
): readonly BotRow[] {
  const ownerSlug = normalizeBotSlug(owner);
  const inOffice = [...new Set(roster.map(normalizeBotSlug))].filter(
    (bot) => bot !== "" && bot !== ownerSlug && bot !== HUMAN_SLUG,
  );
  const orphans = stored.grants
    .map((grant) => normalizeBotSlug(grant.bot))
    .filter((bot) => bot !== ownerSlug && !inOffice.includes(bot))
    .sort();
  return [
    ...inOffice.map((bot) => ({ bot, isInOffice: true })),
    ...[...new Set(orphans)].map((bot) => ({ bot, isInOffice: false })),
  ];
}

export function filterBotRows(
  rows: readonly BotRow[],
  query: string,
): readonly BotRow[] {
  const needle = query.trim().toLowerCase().replace(/^@/, "");
  if (needle === "") return rows;
  return rows.filter((row) => row.bot.includes(needle));
}

export function scopeExplanation(scope: SpaceScope, owner: string): string {
  switch (scope) {
    case "private":
      return `Only @${owner} and you can use this data space.`;
    case "shared":
      return `@${owner}, you, and the bots you pick.`;
    case "global":
      return "Every bot in the office can read and write, including bots you add later.";
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

export const SCOPE_LABELS: Readonly<Record<SpaceScope, string>> = {
  private: "Private",
  shared: "Shared",
  global: "Global",
};
