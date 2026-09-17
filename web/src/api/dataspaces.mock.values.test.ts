import { describe, expect, it } from "vitest";

import type { AttributeInput, AttributeValue } from "./dataspaces";
import { createTestKit, validationError } from "./dataspaces.mock.testkit";

describe("value coercion", () => {
  async function setup() {
    const kit = createTestKit();
    const type = await kit.type("Sample");
    const inputs: readonly AttributeInput[] = [
      { name: "Memo", type: "text" },
      { name: "Count", type: "number" },
      { name: "Amount", type: "currency" },
      { name: "Score", type: "rating" },
      { name: "Due", type: "date" },
      { name: "Done", type: "toggle" },
      { name: "Email", type: "email" },
      { name: "Site", type: "url" },
      { name: "Phone", type: "phone" },
      { name: "Priority", type: "select", options: ["low", "medium", "high"] },
      { name: "Stage", type: "status", options: ["Intro", "Pitched"] },
      {
        name: "Skills",
        type: "select",
        isMultivalue: true,
        options: ["Go", "SQL"],
      },
      { name: "Aliases", type: "email", isMultivalue: true },
    ];
    for (const input of inputs) await kit.attr(type.id, input);
    const schemaType = await kit.readType(type.id);
    const optionId = (slug: string, name: string) =>
      schemaType.attributes
        .find((attribute) => attribute.slug === slug)
        ?.options.find((option) => option.name === name)?.id ?? "missing";
    const store = async (slug: string, raw: unknown) => {
      const record = await kit.client.createRecord(kit.spaceId, type.id, {
        name: "row",
        [slug]: raw as AttributeValue,
      });
      return record.values[slug];
    };
    return { kit, type, optionId, store };
  }

  const accepted: readonly (readonly [string, unknown, unknown])[] = [
    ["memo", "  padded  ", "  padded  "],
    ["count", 12.5, 12.5],
    ["count", " 42 ", 42],
    ["count", "-3e2", -300],
    ["amount", "250000", 250000],
    ["score", 5, 5],
    ["score", "1", 1],
    ["due", "2026-10-01", "2026-10-01"],
    ["due", "2026-10-01T23:30:00-07:00", "2026-10-01"],
    ["due", "2026-02-28T00:00:00.123Z", "2026-02-28"],
    ["done", true, true],
    ["done", "FALSE", false],
    ["done", " true ", true],
    ["email", " mira@tidewrack.example ", "mira@tidewrack.example"],
    [
      "site",
      "https://tidewrack.example/team",
      "https://tidewrack.example/team",
    ],
    ["phone", " +1 415 555 0112 ", "+1 415 555 0112"],
    ["aliases", "a@x.example", ["a@x.example"]],
    [
      "aliases",
      ["a@x.example", "A@X.example", "b@x.example"],
      ["a@x.example", "b@x.example"],
    ],
  ];

  it.each(accepted)("%s accepts %j", async (slug, raw, stored) => {
    const { store } = await setup();
    expect(await store(slug, raw)).toEqual(stored);
  });

  const refused: readonly (readonly [string, unknown, RegExp])[] = [
    ["memo", 12, /must be text/],
    ["count", "twelve", /must be a number/],
    ["count", Number.NaN, /must be a number/],
    ["amount", true, /must be a number/],
    ["score", 7, /whole number from 1 to 5; got 7/],
    ["score", 0, /whole number from 1 to 5/],
    ["score", 2.5, /whole number from 1 to 5/],
    ["due", "10/01/2026", /YYYY-MM-DD/],
    ["due", "2026-02-30", /YYYY-MM-DD/],
    ["due", 20261001, /YYYY-MM-DD/],
    ["done", "yes", /true or false/],
    ["done", 1, /true or false/],
    ["email", "not-an-email", /email address/],
    ["site", "tidewrack.example", /http:\/\/ or https:\/\//],
    ["site", "ftp://tidewrack.example", /http:\/\/ or https:\/\//],
    ["priority", ["low"], /single value/],
    ["stage", "Closed", /Valid options: Intro, Pitched\./],
  ];

  it.each(refused)("%s refuses %j", async (slug, raw, pattern) => {
    const { kit, store } = await setup();
    const error = await validationError(store(slug, raw));
    expect(error.message).toMatch(pattern);
    expect(error.attribute).toBe(slug);
    const [space] = await kit.client.listSpaces();
    expect(space.recordCount).toBe(0);
  });

  it("matches options by id, then by trimmed case-insensitive name", async () => {
    const { store, optionId } = await setup();
    const high = optionId("priority", "high");
    expect(await store("priority", high)).toBe(high);
    expect(await store("priority", "  HIGH ")).toBe(high);
  });

  it("lists the valid options when one misses", async () => {
    const { store } = await setup();
    const error = await validationError(store("priority", "urgent"));
    expect(error.message).toBe(
      '"urgent" is not a valid option for Priority. Valid options: low, medium, high.',
    );
  });

  it("caps the option list in the error at 25", async () => {
    const kit = createTestKit();
    const type = await kit.type("Thing");
    const options = Array.from({ length: 30 }, (_, index) => `opt${index + 1}`);
    await kit.attr(type.id, { name: "Pick", type: "select", options });
    const error = await validationError(
      kit.client.createRecord(kit.spaceId, type.id, { name: "x", pick: "zzz" }),
    );
    expect(error.message).toContain("opt25, and 5 more.");
    expect(error.message).not.toContain("opt26");
  });

  it("accepts a bare scalar or a list for multivalue and de-duplicates", async () => {
    const { store, optionId } = await setup();
    const go = optionId("skills", "Go");
    const sql = optionId("skills", "SQL");
    expect(await store("skills", "go")).toEqual([go]);
    expect(await store("skills", ["Go", go, "sql", "SQL "])).toEqual([go, sql]);
    expect(await store("skills", [])).toBeUndefined();
  });
});

describe("record validation", () => {
  async function setup() {
    const kit = createTestKit();
    const firm = await kit.type("Firm");
    const investor = await kit.type("Investor");
    await kit.attr(investor.id, {
      name: "Email",
      type: "email",
      isUnique: true,
    });
    await kit.attr(investor.id, { name: "Notes", type: "text" });
    await kit.relate(investor.id, "Firm", firm.id, "many_to_one", "Investors");
    return { kit, firm, investor };
  }

  it("requires the primary name on create and refuses to clear it", async () => {
    const { kit, investor } = await setup();
    const missing = await validationError(
      kit.client.createRecord(kit.spaceId, investor.id, { notes: "hi" }),
    );
    expect(missing.message).toBe("Name is required.");
    expect(missing.attribute).toBe("name");
    const record = await kit.client.createRecord(kit.spaceId, investor.id, {
      name: "Mirela",
    });
    for (const cleared of [null, "", "   "]) {
      const error = await validationError(
        kit.client.updateRecord(kit.spaceId, record.id, { name: cleared }),
      );
      expect(error.message).toBe("Name is required and cannot be cleared.");
    }
  });

  it("clears an optional value with null and leaves other values alone", async () => {
    const { kit, investor } = await setup();
    const record = await kit.client.createRecord(kit.spaceId, investor.id, {
      name: "Mirela",
      notes: "warm intro",
      email: "mirela@tidewrack.example",
    });
    const next = await kit.client.updateRecord(kit.spaceId, record.id, {
      notes: null,
    });
    expect(next.values).toEqual({
      name: "Mirela",
      email: "mirela@tidewrack.example",
    });
    expect(next.updatedAt > record.updatedAt).toBe(true);
  });

  it("enforces unique case-insensitively and names the existing record", async () => {
    const { kit, investor } = await setup();
    const first = await kit.client.createRecord(kit.spaceId, investor.id, {
      name: "Mirela",
      email: "mirela@tidewrack.example",
    });
    const second = await kit.client.createRecord(kit.spaceId, investor.id, {
      name: "Tobias",
    });
    const onCreate = await validationError(
      kit.client.createRecord(kit.spaceId, investor.id, {
        name: "Copy",
        email: "MIRELA@Tidewrack.example",
      }),
    );
    const onUpdate = await validationError(
      kit.client.updateRecord(kit.spaceId, second.id, {
        email: "mirela@tidewrack.example",
      }),
    );
    expect(onCreate.message).toContain(first.id);
    expect(onCreate.attribute).toBe("email");
    expect(onUpdate.message).toContain(first.id);
    // Re-saving a record's own value is not a conflict.
    await expect(
      kit.client.updateRecord(kit.spaceId, first.id, {
        email: "mirela@tidewrack.example",
      }),
    ).resolves.toBeDefined();
  });

  it("names the valid slugs for an unknown attribute", async () => {
    const { kit, investor } = await setup();
    const error = await validationError(
      kit.client.createRecord(kit.spaceId, investor.id, {
        name: "x",
        stage: "y",
      }),
    );
    expect(error.message).toBe(
      '"stage" is not an attribute of Investor. Valid attributes: name, email, notes.',
    );
  });

  it("points a relationship slug in a values patch at linkRecords", async () => {
    const { kit, investor } = await setup();
    const error = await validationError(
      kit.client.createRecord(kit.spaceId, investor.id, {
        name: "x",
        firm: "rec_1",
      }),
    );
    expect(error.message).toContain("linkRecords");
    expect(error.attribute).toBe("firm");
  });

  it("writes nothing when one value in a patch is invalid", async () => {
    const { kit, investor } = await setup();
    const record = await kit.client.createRecord(kit.spaceId, investor.id, {
      name: "Mirela",
    });
    await validationError(
      kit.client.updateRecord(kit.spaceId, record.id, {
        notes: "saved?",
        email: "broken",
      }),
    );
    const reread = await kit.client.getRecord(kit.spaceId, record.id);
    expect(reread.values).toEqual({ name: "Mirela" });
  });

  it("keeps recordCount correct on the type and the space", async () => {
    const { kit, investor, firm } = await setup();
    await kit.client.createRecord(kit.spaceId, investor.id, { name: "A" });
    await kit.client.createRecord(kit.spaceId, investor.id, { name: "B" });
    await kit.client.createRecord(kit.spaceId, firm.id, { name: "F" });
    expect((await kit.readType(investor.id)).recordCount).toBe(2);
    expect((await kit.readType(firm.id)).recordCount).toBe(1);
    expect((await kit.client.listSpaces())[0].recordCount).toBe(3);
  });
});
