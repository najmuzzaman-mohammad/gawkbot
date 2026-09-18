import { describe, expect, it } from "vitest";

import type { FilterClause, RecordQuery } from "./dataspaces";
import { createTestKit, validationError } from "./dataspaces.mock.testkit";

type Row = readonly [
  name: string,
  stage: string | null,
  check: number | null,
  met: string | null,
  warm: boolean | null,
  email: string | null,
];

const ROWS: readonly Row[] = [
  ["Mirela", "Pitched", 250000, "2026-08-02", true, "mirela@tidewrack.example"],
  ["Tobias", "Intro", null, "2026-07-15", false, null],
  ["Anneke", "Committed", 50000, null, null, "anneke@halcyonspur.example"],
  ["Desmond", null, 100000, "2026-09-01", true, null],
  [
    "Priyanka",
    "Intro",
    100000,
    "2026-06-20",
    null,
    "priyanka@northlantern.example",
  ],
];

async function setup() {
  const kit = createTestKit();
  const firm = await kit.type("Firm");
  const investor = await kit.type("Investor");
  await kit.attr(investor.id, {
    name: "Stage",
    type: "status",
    options: ["Intro", "Pitched", "Committed"],
  });
  await kit.attr(investor.id, { name: "Check", type: "currency" });
  await kit.attr(investor.id, { name: "Met", type: "date" });
  await kit.attr(investor.id, { name: "Warm", type: "toggle" });
  await kit.attr(investor.id, { name: "Email", type: "email" });
  await kit.relate(investor.id, "Firm", firm.id, "many_to_one", "Investors");
  const tidewrack = await kit.client.createRecord(kit.spaceId, firm.id, {
    name: "Tidewrack Capital",
  });
  for (const [name, stage, check, met, warm, email] of ROWS) {
    await kit.client.createRecord(kit.spaceId, investor.id, {
      name,
      stage,
      check,
      met,
      warm,
      email,
    });
  }
  const run = async (query: Partial<RecordQuery>) => {
    const page = await kit.client.queryRecords(kit.spaceId, {
      typeId: investor.id,
      limit: 100,
      offset: 0,
      ...query,
    });
    return {
      names: page.records.map((record) => String(record.values.name)),
      total: page.total,
      page,
    };
  };
  const first = await run({ query: "mirela" });
  await kit.client.linkRecords(
    kit.spaceId,
    first.page.records[0].id,
    "firm",
    tidewrack.id,
  );
  return { kit, investor, run };
}

describe("queryRecords filters", () => {
  const cases: readonly (readonly [string, FilterClause, readonly string[]])[] =
    [
      [
        "status equals by option name, any case",
        { attribute: "stage", operator: "equals", value: " intro " },
        ["Tobias", "Priyanka"],
      ],
      [
        "status not_equals includes empties",
        { attribute: "stage", operator: "not_equals", value: "Intro" },
        ["Mirela", "Anneke", "Desmond"],
      ],
      [
        "status contains",
        { attribute: "stage", operator: "contains", value: "itch" },
        ["Mirela"],
      ],
      [
        "currency equals numerically",
        { attribute: "check", operator: "equals", value: "100000.0" },
        ["Desmond", "Priyanka"],
      ],
      [
        "currency greater is numeric, not lexical",
        { attribute: "check", operator: "greater", value: "90000" },
        ["Mirela", "Desmond", "Priyanka"],
      ],
      [
        "currency less skips empties",
        { attribute: "check", operator: "less", value: "100000" },
        ["Anneke"],
      ],
      [
        "date greater by string compare",
        { attribute: "met", operator: "greater", value: "2026-07-31" },
        ["Mirela", "Desmond"],
      ],
      [
        "date less",
        { attribute: "met", operator: "less", value: "2026-07-01" },
        ["Priyanka"],
      ],
      [
        "is_empty",
        { attribute: "email", operator: "is_empty" },
        ["Tobias", "Desmond"],
      ],
      [
        "is_not_empty",
        { attribute: "check", operator: "is_not_empty" },
        ["Mirela", "Anneke", "Desmond", "Priyanka"],
      ],
      [
        "toggle equals true",
        { attribute: "warm", operator: "equals", value: "true" },
        ["Mirela", "Desmond"],
      ],
      [
        "toggle equals false counts unset as false",
        { attribute: "warm", operator: "equals", value: "false" },
        ["Tobias", "Anneke", "Priyanka"],
      ],
      [
        "relationship contains by linked record name",
        { attribute: "firm", operator: "contains", value: "tidewrack" },
        ["Mirela"],
      ],
      [
        "relationship is_empty",
        { attribute: "firm", operator: "is_empty" },
        ["Tobias", "Anneke", "Desmond", "Priyanka"],
      ],
      [
        "system field _created_by",
        { attribute: "_created_by", operator: "equals", value: "human" },
        ["Mirela", "Tobias", "Anneke", "Desmond", "Priyanka"],
      ],
    ];

  it.each(cases)("%s", async (_label, clause, expected) => {
    const { run } = await setup();
    const out = await run({ filters: [clause] });
    expect(out.names).toEqual(expected);
    expect(out.total).toBe(expected.length);
  });

  it("ANDs multiple clauses", async () => {
    const { run } = await setup();
    const out = await run({
      filters: [
        { attribute: "stage", operator: "equals", value: "Intro" },
        { attribute: "check", operator: "is_not_empty" },
      ],
    });
    expect(out.names).toEqual(["Priyanka"]);
  });

  it("rejects an unknown attribute, a missing value, a bad operator, and a non-number", async () => {
    const { run } = await setup();
    const unknown = await validationError(
      run({ filters: [{ attribute: "nope", operator: "is_empty" }] }),
    );
    const noValue = await validationError(
      run({ filters: [{ attribute: "stage", operator: "equals" }] }),
    );
    const badOperator = await validationError(
      run({
        filters: [
          {
            attribute: "stage",
            operator: "like",
            value: "x",
          } as unknown as FilterClause,
        ],
      }),
    );
    const notNumber = await validationError(
      run({
        filters: [{ attribute: "check", operator: "greater", value: "lots" }],
      }),
    );
    expect(unknown.message).toContain("Valid attributes: name, stage");
    expect(noValue.message).toContain("needs a value");
    expect(badOperator.message).toContain("not a filter operator");
    expect(notNumber.message).toContain("needs a number");
  });
});

describe("queryRecords search", () => {
  it("matches the primary name and text-like values, case-insensitively", async () => {
    const { run } = await setup();
    expect((await run({ query: "ANN" })).names).toEqual(["Anneke"]);
    expect((await run({ query: "northlantern" })).names).toEqual(["Priyanka"]);
    expect((await run({ query: "committed" })).names).toEqual(["Anneke"]);
    // Numbers and dates are not text-like.
    expect((await run({ query: "250000" })).names).toEqual([]);
    expect((await run({ query: "   " })).total).toBe(5);
  });
});

describe("queryRecords sort", () => {
  const sorts: readonly (readonly [
    string,
    "asc" | "desc",
    readonly string[],
  ])[] = [
    ["name", "asc", ["Anneke", "Desmond", "Mirela", "Priyanka", "Tobias"]],
    ["name", "desc", ["Tobias", "Priyanka", "Mirela", "Desmond", "Anneke"]],
    // Option order (Intro, Pitched, Committed), not alphabetical; empties last.
    ["stage", "asc", ["Tobias", "Priyanka", "Mirela", "Anneke", "Desmond"]],
    ["stage", "desc", ["Anneke", "Mirela", "Tobias", "Priyanka", "Desmond"]],
    ["check", "asc", ["Anneke", "Desmond", "Priyanka", "Mirela", "Tobias"]],
    ["check", "desc", ["Mirela", "Desmond", "Priyanka", "Anneke", "Tobias"]],
    ["met", "asc", ["Priyanka", "Tobias", "Mirela", "Desmond", "Anneke"]],
    ["met", "desc", ["Desmond", "Mirela", "Tobias", "Priyanka", "Anneke"]],
    ["warm", "desc", ["Mirela", "Desmond", "Tobias", "Anneke", "Priyanka"]],
    [
      "_created_at",
      "desc",
      ["Priyanka", "Desmond", "Anneke", "Tobias", "Mirela"],
    ],
  ];

  it.each(
    sorts,
  )("by %s %s, empties last", async (attribute, direction, expected) => {
    const { run } = await setup();
    const out = await run({ sort: { attribute, direction } });
    expect(out.names).toEqual(expected);
  });

  it("refuses to sort by a relationship or an unknown attribute", async () => {
    const { run } = await setup();
    const rel = await validationError(
      run({ sort: { attribute: "firm", direction: "asc" } }),
    );
    const unknown = await validationError(
      run({ sort: { attribute: "nope", direction: "asc" } }),
    );
    expect(rel.message).toContain("cannot be sorted by the relationship");
    expect(unknown.message).toContain("not an attribute");
  });
});

describe("queryRecords pagination", () => {
  it("applies offset and limit after filtering; total is the filtered count", async () => {
    const { run } = await setup();
    const sort = { attribute: "name", direction: "asc" } as const;
    const filters: FilterClause[] = [
      { attribute: "check", operator: "is_not_empty" },
    ];
    const pageOne = await run({ sort, filters, limit: 3, offset: 0 });
    const pageTwo = await run({ sort, filters, limit: 3, offset: 3 });
    const beyond = await run({ sort, filters, limit: 3, offset: 30 });
    expect(pageOne.names).toEqual(["Anneke", "Desmond", "Mirela"]);
    expect(pageTwo.names).toEqual(["Priyanka"]);
    expect(beyond.names).toEqual([]);
    expect([pageOne.total, pageTwo.total, beyond.total]).toEqual([4, 4, 4]);
  });

  it.each([
    [{ limit: 0 }, /limit/],
    [{ limit: 2.5 }, /limit/],
    [{ limit: 5000 }, /cannot exceed/],
    [{ offset: -1 }, /offset/],
  ])("rejects %j", async (bad, pattern) => {
    const { run } = await setup();
    expect((await validationError(run(bad))).message).toMatch(pattern);
  });

  it("rejects an unknown object type", async () => {
    const { run } = await setup();
    const error = await validationError(run({ typeId: "type_nope" }));
    expect(error.message).toContain("Unknown object type");
  });
});
