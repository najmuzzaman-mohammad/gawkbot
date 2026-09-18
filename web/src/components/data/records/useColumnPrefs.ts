import { useCallback, useMemo, useState } from "react";

import {
  type ColumnPrefs,
  columnPrefsKey,
  hideColumn,
  loadColumnPrefs,
  type MoveDirection,
  moveColumn,
  type PrefsStorage,
  reconcileColumnPrefs,
  saveColumnPrefs,
  showColumn,
} from "./columnPrefs";

export interface ColumnPrefsControls {
  prefs: ColumnPrefs;
  move: (slug: string, direction: MoveDirection) => void;
  hide: (slug: string) => void;
  show: (slug: string) => void;
}

interface StoredPrefs {
  key: string;
  prefs: ColumnPrefs;
}

function browserStorage(): PrefsStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Reading the property itself throws when storage is blocked.
    return null;
  }
}

/**
 * Column order and hidden columns for one space + object type, backed by
 * localStorage. `slugs` is the current schema, so an attribute a bot just
 * added shows up at the end and a deleted one falls out.
 */
export function useColumnPrefs(
  spaceId: string,
  typeId: string,
  slugs: readonly string[],
): ColumnPrefsControls {
  const key = columnPrefsKey(spaceId, typeId);
  const [stored, setStored] = useState<StoredPrefs>(() => ({
    key,
    prefs: loadColumnPrefs(browserStorage(), key, slugs),
  }));
  // A different table: read its own preferences instead of reusing state.
  const base =
    stored.key === key
      ? stored.prefs
      : loadColumnPrefs(browserStorage(), key, slugs);
  const slugsKey = slugs.join(",");
  const prefs = useMemo(
    () =>
      reconcileColumnPrefs(base, slugsKey === "" ? [] : slugsKey.split(",")),
    [base, slugsKey],
  );

  const apply = useCallback(
    (change: (current: ColumnPrefs) => ColumnPrefs) => {
      const next = change(prefs);
      if (next === prefs) return;
      setStored({ key, prefs: next });
      saveColumnPrefs(browserStorage(), key, next);
    },
    [key, prefs],
  );

  return useMemo(
    () => ({
      prefs,
      move: (slug, direction) =>
        apply((current) => moveColumn(current, slug, direction)),
      hide: (slug) => apply((current) => hideColumn(current, slug)),
      show: (slug) => apply((current) => showColumn(current, slug)),
    }),
    [apply, prefs],
  );
}
