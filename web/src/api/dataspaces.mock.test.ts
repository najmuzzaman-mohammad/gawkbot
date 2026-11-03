import { describe, expect, it } from "vitest";

import {
  type AttributeInput,
  type AttributePatch,
  OPTION_COLORS,
} from "./dataspaces";
import { createMockDataClient } from "./dataspaces.mock";
import { slugify } from "./dataspaces.mock.store";
import { createTestKit, validationError } from "./dataspaces.mock.testkit";

describe("slugify", () => {
  it.each([
    ["Check size", "check_size"],
    ["  E-mail (work)  ", "e_mail_work"],
    ["__Due__date__", "due_date"],
    ["ARR 2026", "arr_2026"],
    ["!!!", "field"],
    ["", "field"],
  ])("%j -> %j", (name, slug) => {
    expect(slugify(name, "field")).toBe(slug);
    expect(slug.startsWith("_")).toBe(false);
  });
});

describe("store isolation", () => {
  it("gives each client its own deep copy of the fixtures", async () => {
    const a = createMockDataClient(undefined, { delayMs: 0 });
    const b = createMockDataClient(undefined, { delayMs: 0 });
    const [space] = await a.listSpaces();
    await a.createObjectType(space.id, { name: "Scratch" });
    const after = await b.listSpaces();
    expect(after[0].objectTypeCount).toBe(space.objectTypeCount);
    expect((await a.listSpaces())[0].objectTypeCount).toBe(
      space.objectTypeCount + 1,
    );
  });

  it("returns fresh objects, so mutating a result cannot reach the store", async () => {
    const kit = createTestKit();
    const type = await kit.type("Investor");
    (type.attributes as unknown[]).length = 0;
    expect((await kit.readType(type.id)).attributes).toHaveLength(1);
  });

  it("names the known spaces when the space id is wrong", async () => {
    const kit = createTestKit();
    const error = await validationError(kit.client.getSchema("nope"));
    expect(error.message).toContain("space_empty");
  });
});

describe("createObjectType", () => {
  it("adds the primary name attribute first and defaults the plural", async () => {
    const kit = createTestKit();
    const type = await kit.type("Investor");
    expect(type).toMatchObject({
      slug: "investor",
      namePlural: "Investors",
      recordCount: 0,
      createdBy: "human",
    });
    expect(type.attributes).toHaveLength(1);
    expect(type.attributes[0]).toMatchObject({
      slug: "name",
      type: "text",
      isPrimary: true,
      isRequired: true,
    });
  });

  it("keeps an explicit plural and uniquifies the slug", async () => {
    const kit = createTestKit();
    const a = await kit.client.createObjectType(kit.spaceId, {
      name: "Company",
      namePlural: "Companies",
    });
    const b = await kit.type("Company!");
    expect(a.namePlural).toBe("Companies");
    expect([a.slug, b.slug]).toEqual(["company", "company_2"]);
  });

  it("rejects an empty name and a duplicate name", async () => {
    const kit = createTestKit();
    await kit.type("Deliverable");
    expect((await validationError(kit.type("  "))).message).toMatch(/name/);
    const dup = await validationError(kit.type("deliverable"));
    expect(dup.message).toContain("already exists");
  });

  it("keeps the slug when the type is renamed", async () => {
    const kit = createTestKit();
    const type = await kit.type("Investor");
    const renamed = await kit.client.updateObjectType(kit.spaceId, type.id, {
      name: "Backer",
      namePlural: "Backers",
    });
    expect(renamed).toMatchObject({ name: "Backer", slug: "investor" });
  });

  it("keeps objectTypeCount on the space correct", async () => {
    const kit = createTestKit();
    await kit.type("A");
    await kit.type("B");
    const [space] = await kit.client.listSpaces();
    expect(space.objectTypeCount).toBe(2);
  });
});

describe("addAttribute", () => {
  it("uniquifies slugs per type with _2, _3", async () => {
    const kit = createTestKit();
    const type = await kit.type("Investor");
    const slugs: string[] = [];
    for (const name of ["Check size", "Check-size", "check.size"]) {
      slugs.push((await kit.attr(type.id, { name, type: "text" })).slug);
    }
    expect(slugs).toEqual(["check_size", "check_size_2", "check_size_3"]);
  });

  it("assigns option ids and round-robin colors", async () => {
    const kit = createTestKit();
    const type = await kit.type("Task");
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const attr = await kit.attr(type.id, {
      name: "Label",
      type: "select",
      options: names,
    });
    expect(attr.options.map((option) => option.name)).toEqual(names);
    expect(new Set(attr.options.map((option) => option.id)).size).toBe(7);
    expect(attr.options.map((option) => option.color)).toEqual([
      ...OPTION_COLORS,
      OPTION_COLORS[0],
    ]);
  });

  it("gives a status with no options the defaults", async () => {
    const kit = createTestKit();
    const type = await kit.type("Task");
    const attr = await kit.attr(type.id, { name: "State", type: "status" });
    expect(attr.options.map((option) => option.name)).toEqual([
      "To do",
      "In progress",
      "Done",
    ]);
  });

  it("defaults currency to USD and leaves currencyCode null elsewhere", async () => {
    const kit = createTestKit();
    const type = await kit.type("Deal");
    const usd = await kit.attr(type.id, { name: "Amount", type: "currency" });
    const eur = await kit.attr(type.id, {
      name: "Fee",
      type: "currency",
      currencyCode: "eur",
    });
    const text = await kit.attr(type.id, { name: "Memo", type: "text" });
    expect([usd.currencyCode, eur.currencyCode, text.currencyCode]).toEqual([
      "USD",
      "EUR",
      null,
    ]);
  });

  const rejected: readonly (readonly [string, AttributeInput, RegExp])[] = [
    [
      "select without options",
      { name: "Tier", type: "select" },
      /at least one option/,
    ],
    [
      "multivalue status",
      { name: "State", type: "status", isMultivalue: true },
      /exactly one value/,
    ],
    [
      "multivalue text",
      { name: "Tags", type: "text", isMultivalue: true },
      /only select, email, url/,
    ],
    [
      "multivalue phone",
      { name: "Phones", type: "phone", isMultivalue: true },
      /only select, email, url/,
    ],
    [
      "unique and multivalue",
      { name: "Emails", type: "email", isMultivalue: true, isUnique: true },
      /unique attribute cannot hold multiple/,
    ],
    [
      "duplicate option names",
      { name: "Tier", type: "select", options: ["Gold", " gold "] },
      /listed twice/,
    ],
    [
      "options on a text",
      { name: "Memo", type: "text", options: ["x"] },
      /only valid for select/,
    ],
    [
      "bad currency code",
      { name: "Fee", type: "currency", currencyCode: "EURO" },
      /currency code/,
    ],
    ["empty name", { name: " ", type: "text" }, /needs a name/],
    [
      "duplicate name",
      { name: "NAME", type: "text" },
      /already has an attribute/,
    ],
    [
      "relationship without target",
      { name: "Firm", type: "relationship" },
      /needs a target/,
    ],
  ];

  it.each(rejected)("rejects %s", async (_label, input, pattern) => {
    const kit = createTestKit();
    const type = await kit.type("Thing");
    const error = await validationError(kit.attr(type.id, input));
    expect(error.message).toMatch(pattern);
    expect((await kit.readType(type.id)).attributes).toHaveLength(1);
  });

  it.each([
    "select",
    "email",
    "url",
  ] as const)("allows multivalue %s", async (type) => {
    const kit = createTestKit();
    const thing = await kit.type("Thing");
    const attr = await kit.attr(thing.id, {
      name: "Many",
      type,
      isMultivalue: true,
      options: type === "select" ? ["x"] : undefined,
    });
    expect(attr.isMultivalue).toBe(true);
  });
});

describe("relationship attributes", () => {
  it("creates the owning and mirrored attribute as one pair", async () => {
    const kit = createTestKit();
    const firm = await kit.type("Firm");
    const investor = await kit.type("Investor");
    const owning = await kit.relate(
      investor.id,
      "Firm",
      firm.id,
      "many_to_one",
      "Investors",
    );
    const mirrored = (await kit.readType(firm.id)).attributes.find(
      (attribute) => attribute.slug === "investors",
    );
    expect(owning.relationship).toMatchObject({
      targetTypeId: firm.id,
      cardinality: "many_to_one",
      inverseAttributeId: mirrored?.id,
    });
    expect(mirrored?.relationship).toEqual({
      relationshipId: owning.relationship?.relationshipId,
      targetTypeId: investor.id,
      cardinality: "one_to_many",
      inverseAttributeId: owning.id,
    });
  });

  it.each([
    ["one_to_one", "one_to_one"],
    ["many_to_one", "one_to_many"],
    ["one_to_many", "many_to_one"],
    ["many_to_many", "many_to_many"],
  ] as const)("mirrors %s as %s", async (cardinality, flipped) => {
    const kit = createTestKit();
    const a = await kit.type("A");
    const b = await kit.type("B");
    await kit.relate(a.id, "Bs", b.id, cardinality, "As");
    const mirrored = (await kit.readType(b.id)).attributes[1];
    expect(mirrored.relationship?.cardinality).toBe(flipped);
  });

  it("skips the mirrored attribute when inverseName is empty", async () => {
    const kit = createTestKit();
    const a = await kit.type("A");
    const b = await kit.type("B");
    const owning = await kit.relate(a.id, "B", b.id, "many_to_one", "  ");
    expect(owning.relationship?.inverseAttributeId).toBeNull();
    expect((await kit.readType(b.id)).attributes).toHaveLength(1);
  });

  it("rejects a self relationship", async () => {
    const kit = createTestKit();
    const a = await kit.type("A");
    const error = await validationError(
      kit.relate(a.id, "Parent", a.id, "many_to_one", "Children"),
    );
    expect(error.message).toContain("itself");
  });

  it("rejects a duplicate in either orientation, case-insensitively", async () => {
    const kit = createTestKit();
    const a = await kit.type("A");
    const b = await kit.type("B");
    await kit.relate(a.id, "Partner", b.id, "many_to_many", "");
    const same = await validationError(
      kit.relate(a.id, "partner", b.id, "many_to_one", ""),
    );
    const flipped = await validationError(
      kit.relate(b.id, "PARTNER", a.id, "many_to_one", ""),
    );
    expect(same.message).toMatch(/already/);
    expect(flipped.message).toContain("already related");
    // A second relationship under a different name is fine.
    await expect(
      kit.relate(a.id, "Backup partner", b.id, "many_to_one", ""),
    ).resolves.toBeDefined();
  });

  it("writes nothing when the inverse name collides on the target", async () => {
    const kit = createTestKit();
    const a = await kit.type("A");
    const b = await kit.type("B");
    await kit.attr(b.id, { name: "Owners", type: "text" });
    await validationError(kit.relate(a.id, "B", b.id, "many_to_one", "owners"));
    expect((await kit.readType(a.id)).attributes).toHaveLength(1);
    expect((await kit.readType(b.id)).attributes).toHaveLength(2);
  });
});

describe("updateAttribute", () => {
  it("renames without changing the slug, including the primary", async () => {
    const kit = createTestKit();
    const type = await kit.type("Meeting");
    const date = await kit.attr(type.id, { name: "Date", type: "date" });
    const renamed = await kit.client.updateAttribute(
      kit.spaceId,
      type.id,
      date.id,
      {
        name: "Held on",
        description: "When it happened",
        isRequired: true,
      },
    );
    expect(renamed).toMatchObject({
      name: "Held on",
      slug: "date",
      description: "When it happened",
      isRequired: true,
    });
    const primary = await kit.client.updateAttribute(
      kit.spaceId,
      type.id,
      type.attributes[0].id,
      { name: "Title" },
    );
    expect(primary).toMatchObject({
      name: "Title",
      slug: "name",
      isPrimary: true,
    });
  });

  it.each([
    "type",
    "isUnique",
    "isMultivalue",
    "slug",
  ])("refuses to change %s", async (key) => {
    const kit = createTestKit();
    const type = await kit.type("Thing");
    const attr = await kit.attr(type.id, { name: "Memo", type: "text" });
    const patch = { [key]: "number" } as unknown as AttributePatch;
    const error = await validationError(
      kit.client.updateAttribute(kit.spaceId, type.id, attr.id, patch),
    );
    expect(error.message).toContain("cannot be changed");
  });

  it("appends options, treats an existing name as a no-op, and keeps ids on rename", async () => {
    const kit = createTestKit();
    const type = await kit.type("Deliverable");
    const attr = await kit.attr(type.id, {
      name: "Priority",
      type: "select",
      options: ["low", "medium"],
    });
    const added = await kit.client.updateAttribute(
      kit.spaceId,
      type.id,
      attr.id,
      {
        addOptions: ["MEDIUM", "high", "High"],
      },
    );
    expect(added.options.map((option) => option.name)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(added.options[2].color).toBe(OPTION_COLORS[2]);
    expect(added.options.slice(0, 2)).toEqual(attr.options);

    const record = await kit.client.createRecord(kit.spaceId, type.id, {
      name: "Copy deck",
      priority: "high",
    });
    const renamed = await kit.client.updateAttribute(
      kit.spaceId,
      type.id,
      attr.id,
      {
        renameOption: { id: added.options[2].id, name: "urgent" },
      },
    );
    expect(renamed.options[2]).toEqual({ ...added.options[2], name: "urgent" });
    const reread = await kit.client.getRecord(kit.spaceId, record.id);
    expect(reread.values.priority).toBe(added.options[2].id);
  });

  it("rejects an option rename that collides or names an unknown id", async () => {
    const kit = createTestKit();
    const type = await kit.type("Deliverable");
    const attr = await kit.attr(type.id, {
      name: "Priority",
      type: "select",
      options: ["low", "high"],
    });
    const update = (patch: AttributePatch) =>
      kit.client.updateAttribute(kit.spaceId, type.id, attr.id, patch);
    const clash = await validationError(
      update({ renameOption: { id: attr.options[0].id, name: "HIGH" } }),
    );
    const unknown = await validationError(
      update({ renameOption: { id: "opt_nope", name: "x" } }),
    );
    expect(clash.message).toContain("already has an option");
    expect(unknown.message).toContain("no option with id");
  });

  it("keeps the primary attribute required", async () => {
    const kit = createTestKit();
    const type = await kit.type("Thing");
    const error = await validationError(
      kit.client.updateAttribute(kit.spaceId, type.id, type.attributes[0].id, {
        isRequired: false,
      }),
    );
    expect(error.message).toContain("always required");
  });
});

/**
 * The mock is the oracle the Go store is written against, so anything the
 * store puts on the wire has to come back from here too. These two fields
 * were both emitted by the store and dropped on the floor by the client.
 */
describe("schema reads carry what the store states", () => {
  it("returns one relationship row per pair, oriented from the owning side", async () => {
    const kit = createTestKit();
    const firm = await kit.type("Firm");
    const investor = await kit.type("Investor");
    const attribute = await kit.relate(
      investor.id,
      "Firm",
      firm.id,
      "many_to_one",
      "Investors",
    );

    const schema = await kit.client.getSchema(kit.spaceId);

    expect(schema.relationships).toEqual([
      {
        id: attribute.relationship?.relationshipId,
        sourceTypeId: investor.id,
        sourceAttributeId: attribute.id,
        targetTypeId: firm.id,
        inverseAttributeId: attribute.relationship?.inverseAttributeId,
        cardinality: "many_to_one",
      },
    ]);
  });

  it("returns an empty list, not a missing one, for a space with no relationships", async () => {
    const kit = createTestKit();
    await kit.type("Firm");

    expect((await kit.client.getSchema(kit.spaceId)).relationships).toEqual([]);
  });

  it("states what the caller may do on every space it hands back", async () => {
    const kit = createTestKit();

    expect((await kit.client.getSchema(kit.spaceId)).space.callerLevel).toBe(
      "write",
    );
    for (const space of await kit.client.listSpaces()) {
      expect(space.callerLevel).toBe("write");
    }
  });
});
