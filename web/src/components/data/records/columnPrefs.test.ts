import { describe, expect, it } from "vitest";

import {
  canMoveColumn,
  columnPrefsKey,
  EMPTY_COLUMN_PREFS,
  hideColumn,
  loadColumnPrefs,
  moveColumn,
  type PrefsStorage,
  parseColumnPrefs,
  reconcileColumnPrefs,
  saveColumnPrefs,
  showColumn,
} from "./columnPrefs";

const SLUGS = ["email", "stage", "check_size", "notes"];

function fakeStorage(initial: Record<string, string> = {}): PrefsStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("columnPrefsKey", () => {
  it("is versioned and scoped to space and type", () => {
    expect(columnPrefsKey("space_a", "type_1")).toBe(
      "wuphf.data.columns.v1:space_a:type_1",
    );
    expect(columnPrefsKey("space_a", "type_1")).not.toBe(
      columnPrefsKey("space_b", "type_1"),
    );
  });
});

describe("parseColumnPrefs tolerates garbage", () => {
  it.each([
    ["null", null],
    ["empty string", ""],
    ["not JSON", "{order:"],
    ["a JSON string", '"hello"'],
    ["a JSON array", "[1,2]"],
    ["a JSON null", "null"],
    ["a JSON number", "42"],
  ])("%s reads as empty preferences", (_label, raw) => {
    expect(parseColumnPrefs(raw)).toEqual(EMPTY_COLUMN_PREFS);
  });

  it("keeps only non-empty strings and drops duplicates", () => {
    const raw = JSON.stringify({
      order: ["stage", 7, "", "stage", null, "email"],
      hidden: { nope: true },
    });
    expect(parseColumnPrefs(raw)).toEqual({
      order: ["stage", "email"],
      hidden: [],
    });
  });
});

describe("reconcileColumnPrefs", () => {
  it("drops slugs that no longer exist and appends new ones in schema order", () => {
    const prefs = {
      order: ["notes", "gone", "email"],
      hidden: ["gone", "notes"],
    };
    expect(reconcileColumnPrefs(prefs, SLUGS)).toEqual({
      order: ["notes", "email", "stage", "check_size"],
      hidden: ["notes"],
    });
  });

  it("falls back to schema order with nothing stored", () => {
    expect(reconcileColumnPrefs(EMPTY_COLUMN_PREFS, SLUGS)).toEqual({
      order: SLUGS,
      hidden: [],
    });
  });
});

describe("load and save", () => {
  it("round-trips through storage", () => {
    const storage = fakeStorage();
    const prefs = {
      order: ["stage", "email", "check_size", "notes"],
      hidden: ["notes"],
    };
    expect(saveColumnPrefs(storage, "k", prefs)).toBe(true);
    expect(loadColumnPrefs(storage, "k", SLUGS)).toEqual(prefs);
  });

  it("survives storage that throws", () => {
    const broken: PrefsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadColumnPrefs(broken, "k", SLUGS).order).toEqual(SLUGS);
    expect(saveColumnPrefs(broken, "k", EMPTY_COLUMN_PREFS)).toBe(false);
    expect(saveColumnPrefs(null, "k", EMPTY_COLUMN_PREFS)).toBe(false);
    expect(loadColumnPrefs(null, "k", SLUGS).order).toEqual(SLUGS);
  });

  it("reads garbage in storage as no preferences", () => {
    const storage = fakeStorage({ k: "<<<not json>>>" });
    expect(loadColumnPrefs(storage, "k", SLUGS)).toEqual({
      order: SLUGS,
      hidden: [],
    });
  });
});

describe("moving, hiding, showing", () => {
  const prefs = { order: SLUGS, hidden: [] as string[] };

  it("moves a column one step and refuses at the ends", () => {
    expect(moveColumn(prefs, "stage", "left").order).toEqual([
      "stage",
      "email",
      "check_size",
      "notes",
    ]);
    expect(moveColumn(prefs, "stage", "right").order).toEqual([
      "email",
      "check_size",
      "stage",
      "notes",
    ]);
    expect(moveColumn(prefs, "email", "left")).toBe(prefs);
    expect(moveColumn(prefs, "notes", "right")).toBe(prefs);
    expect(moveColumn(prefs, "missing", "left")).toBe(prefs);
  });

  it("steps over hidden columns instead of spending a move on them", () => {
    const withHidden = { order: SLUGS, hidden: ["stage"] };
    expect(moveColumn(withHidden, "check_size", "left").order).toEqual([
      "check_size",
      "stage",
      "email",
      "notes",
    ]);
    expect(canMoveColumn(withHidden, "email", "left")).toBe(false);
    expect(canMoveColumn(withHidden, "stage", "left")).toBe(false);
  });

  it("hides and shows without mutating, and is idempotent", () => {
    const hidden = hideColumn(prefs, "notes");
    expect(hidden.hidden).toEqual(["notes"]);
    expect(prefs.hidden).toEqual([]);
    expect(hideColumn(hidden, "notes")).toBe(hidden);
    expect(hideColumn(prefs, "missing")).toBe(prefs);
    expect(showColumn(hidden, "notes").hidden).toEqual([]);
    expect(showColumn(prefs, "notes")).toBe(prefs);
  });
});
