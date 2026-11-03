import { describe, expect, it } from "vitest";

import type { ObjectType } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { createMockDataClient } from "../../../api/dataspaces.mock";
import {
  clausesToRows,
  type FilterRow,
  filterFields,
  findFilterField,
  isCompleteRow,
  newFilterRow,
  rowsToClauses,
  sameClauses,
  withField,
  withOperator,
} from "./filterRows";

async function investorType(): Promise<ObjectType> {
  const client = createMockDataClient(undefined, { delayMs: 0 });
  const schema = await client.getSchema(SEED_RAISE_SPACE_ID);
  const type = schema.objectTypes.find((item) => item.slug === "investor");
  if (!type) throw new Error("fixture changed: no investor type");
  return type;
}

const row = (patch: Partial<FilterRow>): FilterRow => ({
  key: "k",
  field: "name",
  operator: "contains",
  value: "",
  ...patch,
});

describe("filterFields", () => {
  it("lists attributes in schema order, then the system fields", async () => {
    const fields = filterFields(await investorType());
    expect(fields.map((field) => field.slug)).toEqual([
      "name",
      "email",
      "stage",
      "check_size",
      "notes",
      "firm",
      "meetings",
      "_created_at",
      "_updated_at",
      "_created_by",
    ]);
  });

  it("offers option NAMES for status, and numeric operators for currency", async () => {
    const fields = filterFields(await investorType());
    const stage = findFilterField(fields, "stage");
    expect(stage?.valueInput).toBe("options");
    expect(stage?.optionNames).toEqual([
      "Intro",
      "Pitched",
      "Diligence",
      "Committed",
      "Passed",
    ]);
    expect(stage?.operators).not.toContain("contains");
    const check = findFilterField(fields, "check_size");
    expect(check?.valueInput).toBe("number");
    expect(check?.operators).toContain("greater");
  });
});

describe("row editing", () => {
  it("starts a new row on the first field with its first operator", async () => {
    const fields = filterFields(await investorType());
    expect(newFilterRow(fields, "k1")).toEqual({
      key: "k1",
      field: "name",
      operator: "contains",
      value: "",
    });
    expect(newFilterRow([], "k1")).toBeNull();
  });

  it("changing the field clears the value and fixes an operator that no longer applies", async () => {
    const fields = filterFields(await investorType());
    const next = withField(row({ value: "abc" }), fields, "stage");
    expect(next).toMatchObject({
      field: "stage",
      operator: "equals",
      value: "",
    });
    expect(withField(next, fields, "unknown")).toBe(next);
    expect(withField(next, fields, "stage")).toBe(next);
  });

  it("a valueless operator drops the value", () => {
    expect(withOperator(row({ value: "abc" }), "is_empty").value).toBe("");
    expect(withOperator(row({ value: "abc" }), "equals").value).toBe("abc");
  });
});

describe("rows and clauses", () => {
  it("only complete rows become clauses", () => {
    const rows = [
      row({ key: "a", value: "  okonjo " }),
      row({ key: "b", value: "   " }),
      row({ key: "c", field: "email", operator: "is_empty", value: "stale" }),
    ];
    expect(rows.map(isCompleteRow)).toEqual([true, false, true]);
    expect(rowsToClauses(rows)).toEqual([
      { attribute: "name", operator: "contains", value: "okonjo" },
      { attribute: "email", operator: "is_empty" },
    ]);
  });

  it("drops clauses for fields the type no longer has", async () => {
    const fields = filterFields(await investorType());
    let counter = 0;
    const rows = clausesToRows(
      [
        { attribute: "stage", operator: "equals", value: "Pitched" },
        { attribute: "deleted_attr", operator: "is_empty" },
      ],
      fields,
      () => {
        counter += 1;
        return `k${counter}`;
      },
    );
    expect(rows).toEqual([
      { key: "k1", field: "stage", operator: "equals", value: "Pitched" },
    ]);
  });

  it("compares clause lists by content", () => {
    const left = [{ attribute: "a", operator: "is_empty" as const }];
    expect(sameClauses(left, [{ attribute: "a", operator: "is_empty" }])).toBe(
      true,
    );
    expect(sameClauses(left, [])).toBe(false);
    expect(
      sameClauses(left, [{ attribute: "a", operator: "equals", value: "" }]),
    ).toBe(false);
  });
});
