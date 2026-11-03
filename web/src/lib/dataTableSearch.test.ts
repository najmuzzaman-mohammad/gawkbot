import { describe, expect, it } from "vitest";

import { DEFAULT_PAGE_SIZE, type FilterClause } from "../api/dataspaces";
import {
  decodeFilters,
  encodeFilters,
  parseDataTableSearch,
  toRecordQuery,
} from "./dataTableSearch";

describe("encodeFilters / decodeFilters", () => {
  const roundTrips: readonly (readonly [string, readonly FilterClause[]])[] = [
    ["nothing", []],
    [
      "one clause",
      [{ attribute: "stage", operator: "equals", value: "Pitched" }],
    ],
    [
      "value-less operators",
      [
        { attribute: "email", operator: "is_empty" },
        { attribute: "check_size", operator: "is_not_empty" },
      ],
    ],
    [
      "separators, percent signs, and unicode inside a value",
      [
        {
          attribute: "name",
          operator: "contains",
          value: "Quillon, Vane & Co. 100% née",
        },
        {
          attribute: "site",
          operator: "equals",
          value: "https://a.example/x?y=1,2",
        },
      ],
    ],
    ["an empty value", [{ attribute: "notes", operator: "equals", value: "" }]],
    [
      "a system field",
      [{ attribute: "_created_by", operator: "equals", value: "cos" }],
    ],
    [
      "every comparison operator",
      [
        { attribute: "a", operator: "not_equals", value: "1" },
        { attribute: "a_2", operator: "greater", value: "-2.5" },
        { attribute: "a_3", operator: "less", value: "2026-01-01" },
      ],
    ],
  ];

  it.each(roundTrips)("round-trips %s", (_label, filters) => {
    expect(decodeFilters(encodeFilters(filters))).toEqual(filters);
  });

  it("produces a compact readable string", () => {
    expect(
      encodeFilters([
        { attribute: "stage", operator: "equals", value: "Pitched" },
        { attribute: "check_size", operator: "greater", value: "50000" },
        { attribute: "email", operator: "is_empty" },
      ]),
    ).toBe("stage.equals.Pitched,check_size.greater.50000,email.is_empty");
  });

  it("drops a stray value on a value-less operator when encoding", () => {
    expect(
      encodeFilters([{ attribute: "email", operator: "is_empty", value: "x" }]),
    ).toBe("email.is_empty");
  });

  it.each([
    [undefined],
    [null],
    [42],
    [["stage.equals.x"]],
    [""],
    ["stage"],
    ["stage.equals"],
    ["stage.like.x"],
    ["Stage.equals.x"],
    ["sta ge.equals.x"],
    [".equals.x"],
    ["email.is_empty.extra"],
    ["stage.equals.%E0%A4%A"],
    ["stage.equals.ok,,"],
    ["stage.equals.ok,garbage"],
  ])("returns [] for garbage %j", (input) => {
    expect(decodeFilters(input)).toEqual([]);
  });
});

describe("parseDataTableSearch", () => {
  it("returns an empty object for an empty or junk search", () => {
    expect(parseDataTableSearch({})).toEqual({});
    expect(
      parseDataTableSearch({
        sort: "Not A Slug",
        dir: "sideways",
        q: "   ",
        page: "abc",
        size: 7,
        peek: "",
        filter: "garbage",
        other: "ignored",
      }),
    ).toEqual({});
  });

  it("keeps valid values and normalizes numeric strings", () => {
    expect(
      parseDataTableSearch({
        sort: "check_size",
        dir: "desc",
        q: "  tide ",
        page: "3",
        size: "50",
        peek: "rec_seed_4",
        filter: "stage.equals.Pitched",
      }),
    ).toEqual({
      sort: "check_size",
      dir: "desc",
      q: "tide",
      page: 3,
      size: 50,
      peek: "rec_seed_4",
      filter: "stage.equals.Pitched",
    });
  });

  it.each([
    [0],
    [-2],
    [1.5],
    ["1e3"],
    [Number.NaN],
    [null],
    [1],
  ])("falls back to page 1 for %j", (page) => {
    expect(parseDataTableSearch({ page }).page).toBeUndefined();
    expect(toRecordQuery("t", parseDataTableSearch({ page })).offset).toBe(0);
  });

  it.each([
    [0],
    [7],
    [31],
    ["big"],
    [1000],
    [DEFAULT_PAGE_SIZE],
  ])("falls back to the default size for %j", (size) => {
    expect(parseDataTableSearch({ size }).size).toBeUndefined();
    expect(toRecordQuery("t", parseDataTableSearch({ size })).limit).toBe(
      DEFAULT_PAGE_SIZE,
    );
  });

  it.each([[10], [50], [100], ["100"]])("accepts size %j", (size) => {
    expect(parseDataTableSearch({ size }).size).toBe(Number(size));
  });

  it("drops dir when there is no valid sort", () => {
    expect(parseDataTableSearch({ dir: "desc" })).toEqual({});
    expect(parseDataTableSearch({ sort: "_updated_at", dir: "asc" })).toEqual({
      sort: "_updated_at",
      dir: "asc",
    });
  });

  it("is idempotent", () => {
    const once = parseDataTableSearch({
      sort: "name",
      page: 2,
      filter: "a.is_empty",
    });
    expect(parseDataTableSearch({ ...once })).toEqual(once);
  });
});

describe("toRecordQuery", () => {
  it("applies defaults for an empty search", () => {
    expect(toRecordQuery("type_1", {})).toEqual({
      typeId: "type_1",
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
    });
  });

  it("maps every field and computes the offset from page and size", () => {
    expect(
      toRecordQuery("type_1", {
        sort: "stage",
        dir: "desc",
        q: "tide",
        page: 3,
        size: 50,
        peek: "rec_1",
        filter: "stage.equals.Pitched,email.is_empty",
      }),
    ).toEqual({
      typeId: "type_1",
      filters: [
        { attribute: "stage", operator: "equals", value: "Pitched" },
        { attribute: "email", operator: "is_empty" },
      ],
      sort: { attribute: "stage", direction: "desc" },
      query: "tide",
      limit: 50,
      offset: 100,
    });
  });

  it("defaults the direction to asc and re-validates a hand-built search", () => {
    expect(toRecordQuery("t", { sort: "name" }).sort).toEqual({
      attribute: "name",
      direction: "asc",
    });
    expect(toRecordQuery("t", { page: -4, size: 7, filter: "junk" })).toEqual({
      typeId: "t",
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
    });
  });
});
