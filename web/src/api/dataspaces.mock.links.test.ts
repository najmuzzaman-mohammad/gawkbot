import { describe, expect, it } from "vitest";

import type { Cardinality } from "./dataspaces";
import { createTestKit, validationError } from "./dataspaces.mock.testkit";

async function setup(cardinality: Cardinality) {
  const kit = createTestKit();
  const a = await kit.type("Candidate");
  const b = await kit.type("Role");
  await kit.attr(a.id, { name: "Email", type: "email" });
  await kit.relate(a.id, "Role", b.id, cardinality, "Candidates");
  const make = async (typeId: string, name: string) =>
    (await kit.client.createRecord(kit.spaceId, typeId, { name })).id;
  const a1 = await make(a.id, "Freya");
  const a2 = await make(a.id, "Kofi");
  const b1 = await make(b.id, "Designer");
  const b2 = await make(b.id, "Engineer");
  const link = (from: string, slug: string, to: string, replace?: boolean) =>
    kit.client.linkRecords(kit.spaceId, from, slug, to, replace);
  const names = async (recordId: string, slug: string) => {
    const record = await kit.client.getRecord(kit.spaceId, recordId);
    return record.links[slug].map((ref) => ref.name);
  };
  return { kit, a, b, a1, a2, b1, b2, link, names };
}

describe("linkRecords validation", () => {
  it("rejects a non-relationship attribute, an unknown slug, and a wrong target type", async () => {
    const s = await setup("many_to_one");
    const notRel = await validationError(s.link(s.a1, "email", s.b1));
    const unknown = await validationError(s.link(s.a1, "team", s.b1));
    const wrongType = await validationError(s.link(s.a1, "role", s.a2));
    const missing = await validationError(s.link(s.a1, "role", "rec_nope"));
    expect(notRel.message).toContain("not a relationship");
    expect(unknown.message).toContain("Relationship attributes: role");
    expect(wrongType.message).toContain("links to Role records");
    expect(missing.message).toContain("Unknown record");
  });

  it("exposes every relationship slug on a record, empty when unlinked", async () => {
    const s = await setup("many_to_one");
    const record = await s.kit.client.getRecord(s.kit.spaceId, s.a1);
    expect(record.links).toEqual({ role: [] });
  });
});

describe("many_to_one", () => {
  it("links, mirrors the inverse side, and lets many sources share a target", async () => {
    const s = await setup("many_to_one");
    const linked = await s.link(s.a1, "role", s.b1);
    await s.link(s.a2, "role", s.b1);
    expect(linked.links.role).toEqual([
      { id: s.b1, typeId: s.b.id, name: "Designer" },
    ]);
    expect(await s.names(s.b1, "candidates")).toEqual(["Freya", "Kofi"]);
  });

  it("fails on a second target unless replace is set, then swaps", async () => {
    const s = await setup("many_to_one");
    await s.link(s.a1, "role", s.b1);
    const error = await validationError(s.link(s.a1, "role", s.b2));
    expect(error.message).toContain("Freya is already linked to Designer");
    expect(error.message).toContain("Pass replace");
    expect(error.attribute).toBe("role");
    expect(await s.names(s.a1, "role")).toEqual(["Designer"]);

    const moved = await s.link(s.a1, "role", s.b2, true);
    expect(moved.links.role.map((ref) => ref.name)).toEqual(["Engineer"]);
    expect(await s.names(s.b1, "candidates")).toEqual([]);
    expect(await s.names(s.b2, "candidates")).toEqual(["Freya"]);
  });

  it("enforces the same rule when linking from the inverse (one_to_many) side", async () => {
    const s = await setup("many_to_one");
    await s.link(s.b1, "candidates", s.a1);
    await s.link(s.b1, "candidates", s.a2);
    expect(await s.names(s.a1, "role")).toEqual(["Designer"]);
    const error = await validationError(s.link(s.b2, "candidates", s.a1));
    expect(error.message).toContain("Freya is already linked to Designer");
    await s.link(s.b2, "candidates", s.a1, true);
    expect(await s.names(s.a1, "role")).toEqual(["Engineer"]);
    expect(await s.names(s.b1, "candidates")).toEqual(["Kofi"]);
  });
});

describe("one_to_many", () => {
  it("lets one owner hold many targets but each target only one owner", async () => {
    const s = await setup("one_to_many");
    await s.link(s.a1, "role", s.b1);
    await s.link(s.a1, "role", s.b2);
    expect(await s.names(s.a1, "role")).toEqual(["Designer", "Engineer"]);
    const error = await validationError(s.link(s.a2, "role", s.b1));
    expect(error.message).toContain("Designer is already linked to Freya");
    await s.link(s.a2, "role", s.b1, true);
    expect(await s.names(s.a1, "role")).toEqual(["Engineer"]);
    expect(await s.names(s.b1, "candidates")).toEqual(["Kofi"]);
  });
});

describe("one_to_one", () => {
  it("blocks a second link on either side and replace clears both conflicts", async () => {
    const s = await setup("one_to_one");
    await s.link(s.a1, "role", s.b1);
    await s.link(s.a2, "role", s.b2);
    await validationError(s.link(s.a1, "role", s.b2));
    await validationError(s.link(s.b1, "candidates", s.a2));
    await s.link(s.a1, "role", s.b2, true);
    expect(await s.names(s.a1, "role")).toEqual(["Engineer"]);
    expect(await s.names(s.a2, "role")).toEqual([]);
    expect(await s.names(s.b1, "candidates")).toEqual([]);
    expect(await s.names(s.b2, "candidates")).toEqual(["Freya"]);
  });
});

describe("many_to_many", () => {
  it("never conflicts", async () => {
    const s = await setup("many_to_many");
    await s.link(s.a1, "role", s.b1);
    await s.link(s.a1, "role", s.b2);
    await s.link(s.a2, "role", s.b1);
    expect(await s.names(s.a1, "role")).toEqual(["Designer", "Engineer"]);
    expect(await s.names(s.b1, "candidates")).toEqual(["Freya", "Kofi"]);
  });
});

describe("idempotency", () => {
  it("treats an existing link as a no-op, from either side", async () => {
    const s = await setup("many_to_one");
    const first = await s.link(s.a1, "role", s.b1);
    const again = await s.link(s.a1, "role", s.b1);
    const inverse = await s.link(s.b1, "candidates", s.a1);
    expect(again).toEqual(first);
    expect(again.updatedAt).toBe(first.updatedAt);
    expect(inverse.links.candidates).toHaveLength(1);
  });

  it("treats unlinking a missing link as a no-op and removes both sides otherwise", async () => {
    const s = await setup("many_to_one");
    const before = await s.kit.client.getRecord(s.kit.spaceId, s.a1);
    const noop = await s.kit.client.unlinkRecords(
      s.kit.spaceId,
      s.a1,
      "role",
      s.b1,
    );
    expect(noop).toEqual(before);

    await s.link(s.a1, "role", s.b1);
    const unlinked = await s.kit.client.unlinkRecords(
      s.kit.spaceId,
      s.b1,
      "candidates",
      s.a1,
    );
    expect(unlinked.links.candidates).toEqual([]);
    expect(await s.names(s.a1, "role")).toEqual([]);
  });
});

describe("RecordRef.name", () => {
  it("always reflects the target's current primary value", async () => {
    const s = await setup("many_to_one");
    await s.link(s.a1, "role", s.b1);
    await s.kit.client.updateRecord(s.kit.spaceId, s.b1, {
      name: "Staff Designer",
    });
    expect(await s.names(s.a1, "role")).toEqual(["Staff Designer"]);
    const page = await s.kit.client.queryRecords(s.kit.spaceId, {
      typeId: s.a.id,
      limit: 10,
      offset: 0,
    });
    expect(page.records[0].links.role[0].name).toBe("Staff Designer");
  });
});
