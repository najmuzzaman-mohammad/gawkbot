import { describe, expect, it } from "vitest";

import type { DataRecord, RecordPage } from "../api/dataspaces";
import {
  applyValuesPatch,
  patchRecord,
  patchRecordInPage,
  removeRecordsFromPage,
  replaceRecordInPage,
} from "./dataRecordCache";

function record(id: string, values: DataRecord["values"]): DataRecord {
  return {
    id,
    typeId: "type_1",
    values,
    links: { firm: [{ id: "rec_f", typeId: "type_2", name: "Tidewrack" }] },
    createdBy: "cos",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function page(): RecordPage {
  return {
    records: [
      record("rec_1", { name: "Mirela", stage: "opt_1", check_size: 250000 }),
      record("rec_2", { name: "Tobias" }),
    ],
    total: 12,
  };
}

describe("applyValuesPatch", () => {
  it.each([
    [
      "sets a new key",
      { name: "A" },
      { stage: "opt_2" },
      { name: "A", stage: "opt_2" },
    ],
    ["overwrites a key", { name: "A" }, { name: "B" }, { name: "B" }],
    [
      "null removes a key",
      { name: "A", stage: "x" },
      { stage: null },
      { name: "A" },
    ],
    [
      "null on a missing key is harmless",
      { name: "A" },
      { stage: null },
      { name: "A" },
    ],
    [
      "keeps false and 0",
      {},
      { done: false, count: 0 },
      { done: false, count: 0 },
    ],
    ["sets a list", {}, { skills: ["a", "b"] }, { skills: ["a", "b"] }],
    ["an empty patch changes nothing", { name: "A" }, {}, { name: "A" }],
  ])("%s", (_label, values, patch, expected) => {
    const frozen = Object.freeze({ ...values });
    expect(applyValuesPatch(frozen, patch)).toEqual(expected);
    expect(frozen).toEqual(values);
  });
});

describe("patchRecord", () => {
  it("returns a new record and leaves the input untouched", () => {
    const before = record("rec_1", { name: "Mirela", stage: "opt_1" });
    const snapshot = structuredClone(before);
    const after = patchRecord(
      before,
      { stage: null, check_size: 5 },
      "2026-09-17T00:00:00.000Z",
    );
    expect(after).not.toBe(before);
    expect(after.values).toEqual({ name: "Mirela", check_size: 5 });
    expect(after.updatedAt).toBe("2026-09-17T00:00:00.000Z");
    expect(after.links).toBe(before.links);
    expect(before).toEqual(snapshot);
  });

  it("keeps updatedAt when no stamp is given and short-circuits an empty patch", () => {
    const before = record("rec_1", { name: "Mirela" });
    expect(patchRecord(before, { name: "M" }).updatedAt).toBe(before.updatedAt);
    expect(patchRecord(before, {})).toBe(before);
  });
});

describe("patchRecordInPage", () => {
  it("patches only the matching record and keeps the others by reference", () => {
    const before = page();
    const snapshot = structuredClone(before);
    const after = patchRecordInPage(before, "rec_1", { stage: "opt_3" });
    expect(after).not.toBe(before);
    expect(after?.records[0].values.stage).toBe("opt_3");
    expect(after?.records[1]).toBe(before.records[1]);
    expect(after?.total).toBe(12);
    expect(before).toEqual(snapshot);
  });

  it("returns the same reference when the record is not on the page", () => {
    const before = page();
    expect(patchRecordInPage(before, "rec_404", { stage: "x" })).toBe(before);
  });

  it("passes undefined through, for a query with no data yet", () => {
    expect(
      patchRecordInPage(undefined, "rec_1", { stage: "x" }),
    ).toBeUndefined();
  });
});

describe("replaceRecordInPage", () => {
  it("swaps in the server record where the page already shows it", () => {
    const before = page();
    const next = record("rec_2", { name: "Tobias V." });
    const after = replaceRecordInPage(before, next);
    expect(after?.records[1]).toBe(next);
    expect(after?.records[0]).toBe(before.records[0]);
    expect(before.records[1].values.name).toBe("Tobias");
  });

  it("never inserts a record the page did not have", () => {
    const before = page();
    expect(replaceRecordInPage(before, record("rec_9", { name: "New" }))).toBe(
      before,
    );
    expect(
      replaceRecordInPage(undefined, record("rec_9", { name: "New" })),
    ).toBeUndefined();
  });
});

describe("removeRecordsFromPage", () => {
  it("removes records and lowers the total by the number removed", () => {
    const before = page();
    const after = removeRecordsFromPage(before, ["rec_1", "rec_404"]);
    expect(after?.records.map((item) => item.id)).toEqual(["rec_2"]);
    expect(after?.total).toBe(11);
    expect(before.records).toHaveLength(2);
  });

  it("returns the same reference when nothing matched, and never goes below zero", () => {
    const before = page();
    expect(removeRecordsFromPage(before, ["rec_404"])).toBe(before);
    expect(removeRecordsFromPage(undefined, ["rec_1"])).toBeUndefined();
    const tiny: RecordPage = { records: before.records, total: 1 };
    expect(removeRecordsFromPage(tiny, ["rec_1", "rec_2"])?.total).toBe(0);
  });
});
