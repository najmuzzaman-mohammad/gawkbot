/**
 * Column order and hidden columns for one records table, kept per space and
 * object type in localStorage. Everything here is pure and total: stored data
 * is treated as untrusted, so garbage reads as "no preferences" and slugs
 * that no longer exist in the schema are dropped on the way in.
 */

export const COLUMN_PREFS_VERSION = 1;
const KEY_PREFIX = "wuphf.data.columns";

export interface ColumnPrefs {
  /** Attribute slugs, in display order. */
  order: readonly string[];
  /** Attribute slugs the operator has hidden. */
  hidden: readonly string[];
}

export type MoveDirection = "left" | "right";

export const EMPTY_COLUMN_PREFS: ColumnPrefs = { order: [], hidden: [] };

/** The slice of `Storage` this module needs, so tests can pass a plain fake. */
export interface PrefsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function columnPrefsKey(spaceId: string, typeId: string): string {
  return `${KEY_PREFIX}.v${COLUMN_PREFS_VERSION}:${spaceId}:${typeId}`;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item !== "") seen.add(item);
  }
  return [...seen];
}

/** Never throws. Anything unreadable yields empty preferences. */
export function parseColumnPrefs(raw: string | null): ColumnPrefs {
  if (raw === null || raw === "") return EMPTY_COLUMN_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_COLUMN_PREFS;
    }
    const record = parsed as Record<string, unknown>;
    return {
      order: stringList(record.order),
      hidden: stringList(record.hidden),
    };
  } catch {
    // Malformed JSON is the same as nothing stored.
    return EMPTY_COLUMN_PREFS;
  }
}

/**
 * Fits stored preferences to the current schema: unknown slugs are dropped,
 * and attributes added since the last visit are appended in schema order.
 */
export function reconcileColumnPrefs(
  prefs: ColumnPrefs,
  schemaSlugs: readonly string[],
): ColumnPrefs {
  const known = new Set(schemaSlugs);
  const kept = prefs.order.filter((slug) => known.has(slug));
  const placed = new Set(kept);
  const added = schemaSlugs.filter((slug) => !placed.has(slug));
  return {
    order: [...kept, ...added],
    hidden: prefs.hidden.filter((slug) => known.has(slug)),
  };
}

export function loadColumnPrefs(
  storage: PrefsStorage | null,
  key: string,
  schemaSlugs: readonly string[],
): ColumnPrefs {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    // Storage can be blocked outright (private mode, a sandboxed frame).
    raw = null;
  }
  return reconcileColumnPrefs(parseColumnPrefs(raw), schemaSlugs);
}

/** Returns false when the write was refused; the table still works. */
export function saveColumnPrefs(
  storage: PrefsStorage | null,
  key: string,
  prefs: ColumnPrefs,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      key,
      JSON.stringify({ order: prefs.order, hidden: prefs.hidden }),
    );
    return true;
  } catch {
    // Quota or a blocked store. Preferences are a convenience, not data.
    return false;
  }
}

function visibleOrder(prefs: ColumnPrefs): string[] {
  const hidden = new Set(prefs.hidden);
  return prefs.order.filter((slug) => !hidden.has(slug));
}

export function canMoveColumn(
  prefs: ColumnPrefs,
  slug: string,
  direction: MoveDirection,
): boolean {
  const visible = visibleOrder(prefs);
  const index = visible.indexOf(slug);
  if (index === -1) return false;
  return direction === "left" ? index > 0 : index < visible.length - 1;
}

/**
 * Swaps a column with its nearest VISIBLE neighbor, so a move is never spent
 * stepping over a hidden column the operator cannot see.
 */
export function moveColumn(
  prefs: ColumnPrefs,
  slug: string,
  direction: MoveDirection,
): ColumnPrefs {
  if (!canMoveColumn(prefs, slug, direction)) return prefs;
  const visible = visibleOrder(prefs);
  const index = visible.indexOf(slug);
  const neighbor = visible[direction === "left" ? index - 1 : index + 1];
  const order = prefs.order.map((item) => {
    if (item === slug) return neighbor;
    if (item === neighbor) return slug;
    return item;
  });
  return { ...prefs, order };
}

export function hideColumn(prefs: ColumnPrefs, slug: string): ColumnPrefs {
  if (prefs.hidden.includes(slug) || !prefs.order.includes(slug)) return prefs;
  return { ...prefs, hidden: [...prefs.hidden, slug] };
}

export function showColumn(prefs: ColumnPrefs, slug: string): ColumnPrefs {
  if (!prefs.hidden.includes(slug)) return prefs;
  return { ...prefs, hidden: prefs.hidden.filter((item) => item !== slug) };
}
