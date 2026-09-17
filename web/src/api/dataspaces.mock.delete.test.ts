import { describe, expect, it } from "vitest";

import { DELETE_TOKEN_TTL_MS } from "./dataspaces.mock.delete";
import { createTestKit, validationError } from "./dataspaces.mock.testkit";

async function setup() {
  const kit = createTestKit();
  const firm = await kit.type("Firm");
  const investor = await kit.type("Investor");
  const meeting = await kit.type("Meeting");
  const email = await kit.attr(investor.id, { name: "Email", type: "email" });
  const firmRel = await kit.relate(
    investor.id,
    "Firm",
    firm.id,
    "many_to_one",
    "Investors",
  );
  await kit.relate(
    meeting.id,
    "Investor",
    investor.id,
    "many_to_one",
    "Meetings",
  );
  const make = async (typeId: string, values: Record<string, string>) =>
    (await kit.client.createRecord(kit.spaceId, typeId, values)).id;
  const f1 = await make(firm.id, { name: "Tidewrack" });
  const i1 = await make(investor.id, {
    name: "Mirela",
    email: "m@tidewrack.example",
  });
  const i2 = await make(investor.id, { name: "Tobias" });
  const m1 = await make(meeting.id, { name: "Intro call" });
  const m2 = await make(meeting.id, { name: "Pitch" });
  await kit.client.linkRecords(kit.spaceId, i1, "firm", f1);
  await kit.client.linkRecords(kit.spaceId, i2, "firm", f1);
  await kit.client.linkRecords(kit.spaceId, m1, "investor", i1);
  await kit.client.linkRecords(kit.spaceId, m2, "investor", i1);
  return { kit, firm, investor, meeting, email, firmRel, f1, i1, i2, m1, m2 };
}

describe("previewDelete", () => {
  it("counts the impact of deleting records without changing anything", async () => {
    const s = await setup();
    const preview = await s.kit.client.previewDelete(s.kit.spaceId, "records", [
      s.i1,
    ]);
    expect(preview.kind).toBe("records");
    expect(preview.impact).toEqual({
      records: 1,
      links: 3,
      attributes: 0,
      objectTypes: 0,
    });
    expect((await s.kit.client.listSpaces())[0].recordCount).toBe(5);
  });

  it("counts the impact of deleting a value attribute and a relationship attribute", async () => {
    const s = await setup();
    const value = await s.kit.client.previewDelete(s.kit.spaceId, "attribute", [
      s.email.id,
    ]);
    const rel = await s.kit.client.previewDelete(s.kit.spaceId, "attribute", [
      s.firmRel.id,
    ]);
    expect(value.impact).toEqual({
      records: 1,
      links: 0,
      attributes: 1,
      objectTypes: 0,
    });
    expect(rel.impact).toEqual({
      records: 0,
      links: 2,
      attributes: 2,
      objectTypes: 0,
    });
  });

  it("counts the impact of deleting an object type", async () => {
    const s = await setup();
    const preview = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "object_type",
      [s.investor.id],
    );
    // Investor's own 4 attributes, plus Firm.investors and Meeting.investor.
    expect(preview.impact).toEqual({
      records: 2,
      links: 4,
      attributes: 6,
      objectTypes: 1,
    });
  });

  it("refuses the primary attribute, unknown ids, an empty list, and a wrong space id", async () => {
    const s = await setup();
    const preview = (
      kind: "attribute" | "records" | "object_type" | "space",
      ids: string[],
    ) => validationError(s.kit.client.previewDelete(s.kit.spaceId, kind, ids));
    expect(
      (await preview("attribute", [s.firm.attributes[0].id])).message,
    ).toContain("primary attribute");
    expect((await preview("records", ["rec_nope"])).message).toContain(
      "rec_nope",
    );
    expect((await preview("object_type", ["type_nope"])).message).toContain(
      "type_nope",
    );
    expect((await preview("attribute", ["attr_nope"])).message).toContain(
      "attr_nope",
    );
    expect((await preview("records", [])).message).toContain("empty");
    expect((await preview("space", ["other"])).message).toContain(
      "exactly the space id",
    );
  });
});

describe("executeDelete", () => {
  it("throws on an unknown token, a token from another space, and a reused token", async () => {
    const s = await setup();
    const unknown = await validationError(
      s.kit.client.executeDelete(s.kit.spaceId, "del_x"),
    );
    expect(unknown.message).toContain("Unknown delete token");
    const { token } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "records",
      [s.m2],
    );
    await validationError(s.kit.client.executeDelete("space_other", token));
    await s.kit.client.executeDelete(s.kit.spaceId, token);
    await validationError(s.kit.client.executeDelete(s.kit.spaceId, token));
  });

  it("throws once the 15 minute window has passed", async () => {
    const s = await setup();
    const { token } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "records",
      [s.m2],
    );
    s.kit.advance(DELETE_TOKEN_TTL_MS + 1);
    const error = await validationError(
      s.kit.client.executeDelete(s.kit.spaceId, token),
    );
    expect(error.message).toContain("expired");
    expect((await s.kit.readType(s.meeting.id)).recordCount).toBe(2);
  });

  it("still works just inside the window", async () => {
    const s = await setup();
    const { token } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "records",
      [s.m2],
    );
    s.kit.advance(DELETE_TOKEN_TTL_MS - 5000);
    await expect(
      s.kit.client.executeDelete(s.kit.spaceId, token),
    ).resolves.toBeUndefined();
  });

  it("binds the token to the id set regardless of order or duplicates", async () => {
    const s = await setup();
    const { token, impact } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "records",
      [s.m2, s.m1, s.m2],
    );
    expect(impact.records).toBe(2);
    await s.kit.client.executeDelete(s.kit.spaceId, token);
    expect((await s.kit.readType(s.meeting.id)).recordCount).toBe(0);
  });

  it("deleting records removes their links from the other side", async () => {
    const s = await setup();
    const { token } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "records",
      [s.i1],
    );
    await s.kit.client.executeDelete(s.kit.spaceId, token);
    const firm = await s.kit.client.getRecord(s.kit.spaceId, s.f1);
    const meeting = await s.kit.client.getRecord(s.kit.spaceId, s.m1);
    expect(firm.links.investors.map((ref) => ref.name)).toEqual(["Tobias"]);
    expect(meeting.links.investor).toEqual([]);
    expect((await s.kit.readType(s.investor.id)).recordCount).toBe(1);
    expect((await s.kit.client.listSpaces())[0].recordCount).toBe(4);
    await validationError(s.kit.client.getRecord(s.kit.spaceId, s.i1));
  });

  it("deleting a value attribute removes its values", async () => {
    const s = await setup();
    const { token } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "attribute",
      [s.email.id],
    );
    await s.kit.client.executeDelete(s.kit.spaceId, token);
    const record = await s.kit.client.getRecord(s.kit.spaceId, s.i1);
    expect(record.values).toEqual({ name: "Mirela" });
    const slugs = (await s.kit.readType(s.investor.id)).attributes.map(
      (a) => a.slug,
    );
    expect(slugs).toEqual(["name", "firm", "meetings"]);
  });

  it("deleting a relationship attribute removes the mirror and every link, from either side", async () => {
    const s = await setup();
    const mirror = (await s.kit.readType(s.firm.id)).attributes.find(
      (attribute) => attribute.slug === "investors",
    );
    const { token } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "attribute",
      [mirror?.id ?? ""],
    );
    await s.kit.client.executeDelete(s.kit.spaceId, token);
    expect(
      (await s.kit.readType(s.firm.id)).attributes.map((a) => a.slug),
    ).toEqual(["name"]);
    expect(
      (await s.kit.readType(s.investor.id)).attributes.map((a) => a.slug),
    ).toEqual(["name", "email", "meetings"]);
    const record = await s.kit.client.getRecord(s.kit.spaceId, s.i1);
    expect(Object.keys(record.links)).toEqual(["meetings"]);
    expect(record.links.meetings).toHaveLength(2);
  });

  it("deleting an object type cascades to records, links, and foreign relationship attributes", async () => {
    const s = await setup();
    const { token } = await s.kit.client.previewDelete(
      s.kit.spaceId,
      "object_type",
      [s.investor.id],
    );
    await s.kit.client.executeDelete(s.kit.spaceId, token);
    const schema = await s.kit.client.getSchema(s.kit.spaceId);
    expect(schema.objectTypes.map((type) => type.name)).toEqual([
      "Firm",
      "Meeting",
    ]);
    expect(schema.space).toMatchObject({ objectTypeCount: 2, recordCount: 3 });
    for (const type of schema.objectTypes) {
      expect(
        type.attributes.every((attribute) => attribute.relationship === null),
      ).toBe(true);
    }
    const meeting = await s.kit.client.getRecord(s.kit.spaceId, s.m1);
    expect(meeting.links).toEqual({});
  });

  it("fails loudly when the id set went stale between preview and execute", async () => {
    const s = await setup();
    const stale = await s.kit.client.previewDelete(s.kit.spaceId, "records", [
      s.m1,
    ]);
    const first = await s.kit.client.previewDelete(s.kit.spaceId, "records", [
      s.m1,
    ]);
    await s.kit.client.executeDelete(s.kit.spaceId, first.token);
    const error = await validationError(
      s.kit.client.executeDelete(s.kit.spaceId, stale.token),
    );
    expect(error.message).toContain("Unknown record ids");
  });

  it("deleting the space removes it", async () => {
    const s = await setup();
    const preview = await s.kit.client.previewDelete(s.kit.spaceId, "space", [
      s.kit.spaceId,
    ]);
    expect(preview.impact).toEqual({
      records: 5,
      links: 4,
      attributes: 8,
      objectTypes: 3,
    });
    await s.kit.client.executeDelete(s.kit.spaceId, preview.token);
    expect(await s.kit.client.listSpaces()).toEqual([]);
    await validationError(s.kit.client.getSchema(s.kit.spaceId));
  });
});
