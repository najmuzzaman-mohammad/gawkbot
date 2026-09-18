/**
 * Sharing rules for data spaces. Pure, no React: the mock client, the UI, and
 * (as the reference) the Go store all follow this one implementation.
 *
 * - `private`: the owner bot and the operator.
 * - `shared`: plus named bots, each with `read` or `write`.
 * - `global`: every bot in the office reads and writes.
 * The owner always has write. The operator always has full access and is not
 * modeled here; these functions answer for bots only.
 */

import {
  ACCESS_LEVELS,
  type AccessLevel,
  type DataSpace,
  DataValidationError,
  SPACE_SCOPES,
  type SpaceAccess,
  type SpaceGrant,
  type SpaceScope,
} from "./dataspaces";

export const BOT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const PRIVATE_ACCESS: SpaceAccess = { scope: "private", grants: [] };
/** `describeAccess` names bots up to this many, then counts them. */
export const MAX_NAMED_BOTS = 2;

export type BotAccessLevel = AccessLevel | "none";
type SpaceAccessSubject = Pick<DataSpace, "owner" | "access">;

export function normalizeBotSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

function isScope(value: unknown): value is SpaceScope {
  return SPACE_SCOPES.some((scope) => scope === value);
}

function isLevel(value: unknown): value is AccessLevel {
  return ACCESS_LEVELS.some((level) => level === value);
}

function normalizeGrant(raw: SpaceGrant): SpaceGrant {
  const given: unknown = raw?.bot;
  const bot = typeof given === "string" ? normalizeBotSlug(given) : "";
  if (!BOT_SLUG_PATTERN.test(bot)) {
    throw new DataValidationError(
      `"${String(given)}" is not a valid bot slug. Use lowercase letters, digits, and dashes, starting with a letter or digit, for example "ops".`,
    );
  }
  if (!isLevel(raw.level)) {
    throw new DataValidationError(
      `"${String(raw.level)}" is not an access level for @${bot}. Valid levels: ${ACCESS_LEVELS.join(", ")}.`,
    );
  }
  return { bot, level: raw.level };
}

/**
 * Returns the canonical form of `access` for a space owned by `owner`:
 * - an unknown scope is an error listing the valid ones;
 * - grants are kept only for `shared`; any other scope stores none, and
 *   whatever was passed in `grants` is ignored without being validated;
 * - bot slugs are trimmed and lowercased, and an invalid one is an error;
 * - a grant naming the owner is dropped (the owner always has write);
 * - a bot named twice keeps the last level given;
 * - grants are sorted by bot slug;
 * - `shared` with no grants left is stored as `private`.
 * Always returns a new object.
 */
export function normalizeAccess(
  owner: string,
  access: SpaceAccess,
): SpaceAccess {
  const scope: unknown = access?.scope;
  if (!isScope(scope)) {
    throw new DataValidationError(
      `"${String(scope)}" is not a sharing scope. Valid scopes: ${SPACE_SCOPES.join(", ")}.`,
    );
  }
  if (scope !== "shared") return { scope, grants: [] };

  const given: unknown = access.grants;
  if (!Array.isArray(given)) {
    throw new DataValidationError(
      "A shared space needs a list of grants, each with a bot and a level.",
    );
  }
  const ownerSlug = normalizeBotSlug(owner);
  const levelByBot = new Map<string, AccessLevel>();
  for (const grant of access.grants.map(normalizeGrant)) {
    if (grant.bot !== ownerSlug) levelByBot.set(grant.bot, grant.level);
  }
  const grants = [...levelByBot]
    .map(([bot, level]): SpaceGrant => ({ bot, level }))
    .sort((a, b) => (a.bot < b.bot ? -1 : 1));
  return grants.length === 0
    ? { scope: "private", grants: [] }
    : { scope: "shared", grants };
}

export function botAccessLevel(
  space: SpaceAccessSubject,
  botSlug: string,
): BotAccessLevel {
  const bot = normalizeBotSlug(botSlug);
  if (bot === "") return "none";
  if (bot === normalizeBotSlug(space.owner)) return "write";
  if (space.access.scope === "global") return "write";
  if (space.access.scope === "private") return "none";
  const grant = space.access.grants.find(
    (item) => normalizeBotSlug(item.bot) === bot,
  );
  return grant ? grant.level : "none";
}

export function canBotRead(
  space: SpaceAccessSubject,
  botSlug: string,
): boolean {
  return botAccessLevel(space, botSlug) !== "none";
}

export function canBotWrite(
  space: SpaceAccessSubject,
  botSlug: string,
): boolean {
  return botAccessLevel(space, botSlug) === "write";
}

/** Short label for a badge or a list row. */
export function describeAccess(access: SpaceAccess): string {
  if (access.scope === "global") return "Global";
  const bots = access.grants.map((grant) => `@${grant.bot}`);
  if (access.scope === "private" || bots.length === 0) return "Private";
  if (bots.length > MAX_NAMED_BOTS) return `Shared with ${bots.length} bots`;
  return `Shared with ${bots.join(" and ")}`;
}
