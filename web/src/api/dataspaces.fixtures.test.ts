import { describe, expect, it } from "vitest";

import type { DataRecord, ObjectType, SpaceSchema } from "./dataspaces";
import {
  CLIENT_DELIVERY_SPACE_ID,
  COMPANY_DIRECTORY_SPACE_ID,
  defaultFixtureSpaces,
  EMPTY_SPACE_ID,
  emptyFixtureSpace,
  RECRUITING_SPACE_ID,
  resolveFixtureSeed,
  SEED_RAISE_SPACE_ID,
} from "./dataspaces.fixtures";
import { buildSeedRaiseSpace } from "./dataspaces.fixtures.seedRaise";
import { createMockDataClient } from "./dataspaces.mock";
import { normalizeAccess } from "./dataspacesAccess";

const client = createMockDataClient(undefined, { delayMs: 0 });

async function allRecords(
  spaceId: string,
  typeId: string,
): Promise<readonly DataRecord[]> {
  const page = await client.queryRecords(spaceId, {
    typeId,
    limit: 1000,
    offset: 0,
  });
  return page.records;
}

function typeNamed(schema: SpaceSchema, name: string): ObjectType {
  const found = schema.objectTypes.find((type) => type.name === name);
  if (!found) throw new Error(`no type ${name}`);
  return found;
}

describe("fixture spaces", () => {
  it("has three ICP spaces owned by three bots, then the global directory", async () => {
    const spaces = await client.listSpaces();
    expect(spaces.map((space) => [space.id, space.name, space.owner])).toEqual([
      [SEED_RAISE_SPACE_ID, "Seed raise", "cos"],
      [CLIENT_DELIVERY_SPACE_ID, "Client delivery", "ops"],
      [RECRUITING_SPACE_ID, "Recruiting", "recruiter"],
      [COMPANY_DIRECTORY_SPACE_ID, "Company directory", "cos"],
    ]);
    for (const space of spaces.slice(0, 3)) {
      expect(space.objectTypeCount).toBe(3);
      expect(space.recordCount).toBeGreaterThan(40);
    }
    expect(spaces[3]).toMatchObject({ objectTypeCount: 2, recordCount: 13 });
    expect(spaces[0].attachedAppIds[0]).toMatch(/^app_[0-9a-f]{16}$/);
  });

  it("shows every sharing state: private, shared at read, shared mixed, global", async () => {
    const spaces = await client.listSpaces();
    expect(spaces.map((space) => [space.name, space.access])).toEqual([
      ["Seed raise", { scope: "private", grants: [] }],
      [
        "Client delivery",
        { scope: "shared", grants: [{ bot: "cos", level: "read" }] },
      ],
      [
        "Recruiting",
        {
          scope: "shared",
          grants: [
            { bot: "cos", level: "write" },
            { bot: "ops", level: "read" },
          ],
        },
      ],
      ["Company directory", { scope: "global", grants: [] }],
    ]);
    for (const space of spaces) {
      // Stored access is already in canonical form.
      expect(normalizeAccess(space.owner, space.access)).toEqual(space.access);
    }
    expect(emptyFixtureSpace().space.access).toEqual({
      scope: "private",
      grants: [],
    });
  });

  it("matches the company directory shape", async () => {
    const schema = await client.getSchema(COMPANY_DIRECTORY_SPACE_ID);
    const person = typeNamed(schema, "Person");
    expect(person.namePlural).toBe("People");
    const bySlug = new Map(person.attributes.map((a) => [a.slug, a]));
    expect(bySlug.get("email")).toMatchObject({
      type: "email",
      isUnique: true,
    });
    expect(bySlug.get("role")?.type).toBe("text");
    expect(bySlug.get("start_date")?.type).toBe("date");
    expect(bySlug.get("department")?.options.map((o) => o.name)).toEqual([
      "Founders",
      "Engineering",
      "Operations",
      "Sales",
    ]);
    expect(bySlug.get("team")?.relationship?.cardinality).toBe("many_to_one");
    const team = typeNamed(schema, "Team");
    expect(team.attributes.map((a) => a.slug)).toEqual([
      "name",
      "charter",
      "people",
    ]);

    const teams = await allRecords(COMPANY_DIRECTORY_SPACE_ID, team.id);
    expect(teams.map((record) => record.values.name)).toEqual([
      "Founders",
      "Engineering",
      "Operations",
      "Sales",
    ]);
    expect(teams.map((record) => record.links.people.length)).toEqual([
      2, 3, 2, 1,
    ]);
  });

  it("is deterministic across builds", () => {
    expect(buildSeedRaiseSpace()).toEqual(buildSeedRaiseSpace());
    expect(defaultFixtureSpaces()).toBe(defaultFixtureSpaces());
  });

  it("resolves seeds into independent copies, with an optional empty space", () => {
    const a = resolveFixtureSeed();
    const b = resolveFixtureSeed();
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(b[0]);
    expect(
      resolveFixtureSeed({ emptySpace: true }).map((s) => s.space.id),
    ).toEqual([EMPTY_SPACE_ID]);
    expect(
      resolveFixtureSeed({ spaces: [a[0]], emptySpace: true }).map(
        (s) => s.space.id,
      ),
    ).toEqual([SEED_RAISE_SPACE_ID, EMPTY_SPACE_ID]);
  });

  it.each([
    [SEED_RAISE_SPACE_ID, { Firm: 12, Investor: 22, Meeting: 30 }],
    [CLIENT_DELIVERY_SPACE_ID, { Client: 8, Project: 12, Deliverable: 28 }],
    [RECRUITING_SPACE_ID, { Role: 3, Candidate: 24, Interview: 30 }],
    [COMPANY_DIRECTORY_SPACE_ID, { Team: 4, Person: 9 }],
  ])("%s has the expected record counts", async (spaceId, counts) => {
    const schema = await client.getSchema(spaceId);
    const actual = Object.fromEntries(
      schema.objectTypes.map((type) => [type.name, type.recordCount]),
    );
    expect(actual).toEqual(counts);
  });

  it("puts a required primary `name` text attribute first on every type", async () => {
    for (const space of await client.listSpaces()) {
      const schema = await client.getSchema(space.id);
      for (const type of schema.objectTypes) {
        expect(type.attributes[0]).toMatchObject({
          slug: "name",
          type: "text",
          isPrimary: true,
          isRequired: true,
        });
        expect(
          type.attributes.filter((attribute) => attribute.isPrimary),
        ).toHaveLength(1);
      }
    }
  });

  it("cross-references every relationship with a flipped inverse on the target", async () => {
    let checked = 0;
    for (const space of await client.listSpaces()) {
      const schema = await client.getSchema(space.id);
      for (const type of schema.objectTypes) {
        for (const attribute of type.attributes) {
          const rel = attribute.relationship;
          if (!rel) continue;
          const target = schema.objectTypes.find(
            (item) => item.id === rel.targetTypeId,
          );
          const inverse = target?.attributes.find(
            (item) => item.id === rel.inverseAttributeId,
          );
          expect(inverse?.relationship).toMatchObject({
            relationshipId: rel.relationshipId,
            targetTypeId: type.id,
            inverseAttributeId: attribute.id,
          });
          const pair = [
            rel.cardinality,
            inverse?.relationship?.cardinality,
          ].sort();
          expect(pair).toEqual(["many_to_one", "one_to_many"]);
          checked += 1;
        }
      }
    }
    // Two relationships in each ICP space and one in the directory, two
    // attributes per relationship.
    expect(checked).toBe(14);
  });

  it("matches the seed raise shape from the spec", async () => {
    const schema = await client.getSchema(SEED_RAISE_SPACE_ID);
    const investor = typeNamed(schema, "Investor");
    const bySlug = new Map(investor.attributes.map((a) => [a.slug, a]));
    expect(bySlug.get("email")).toMatchObject({
      type: "email",
      isUnique: true,
    });
    expect(bySlug.get("check_size")).toMatchObject({
      type: "currency",
      currencyCode: "USD",
    });
    expect(bySlug.get("stage")?.options.map((option) => option.name)).toEqual([
      "Intro",
      "Pitched",
      "Diligence",
      "Committed",
      "Passed",
    ]);
    expect(bySlug.get("firm")?.relationship?.cardinality).toBe("many_to_one");
    expect(bySlug.get("meetings")?.relationship?.cardinality).toBe(
      "one_to_many",
    );
    // A renamed primary keeps its slug.
    expect(typeNamed(schema, "Meeting").attributes[0]).toMatchObject({
      name: "Title",
      slug: "name",
    });

    const records = await allRecords(SEED_RAISE_SPACE_ID, investor.id);
    const stageIds = new Set(records.map((record) => record.values.stage));
    expect(stageIds.size).toBe(5);
    for (const record of records) {
      expect(String(record.values.email)).toMatch(/^[a-z]+@[a-z]+\.example$/);
    }
  });

  it("matches the client delivery and recruiting shapes from the spec", async () => {
    const delivery = await client.getSchema(CLIENT_DELIVERY_SPACE_ID);
    const deliverable = new Map(
      typeNamed(delivery, "Deliverable").attributes.map((a) => [a.slug, a]),
    );
    expect(deliverable.get("due_date")?.type).toBe("date");
    expect(deliverable.get("done")?.type).toBe("toggle");
    expect(deliverable.get("priority")?.options.map((o) => o.name)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    const project = new Map(
      typeNamed(delivery, "Project").attributes.map((a) => [a.slug, a]),
    );
    expect(project.get("status")?.type).toBe("status");
    expect(project.get("budget")?.type).toBe("currency");
    expect(project.get("health")?.type).toBe("rating");

    const recruiting = await client.getSchema(RECRUITING_SPACE_ID);
    const candidate = new Map(
      typeNamed(recruiting, "Candidate").attributes.map((a) => [a.slug, a]),
    );
    expect(candidate.get("email")).toMatchObject({ isUnique: true });
    expect(candidate.get("skills")).toMatchObject({
      type: "select",
      isMultivalue: true,
    });
    expect(candidate.get("linkedin")?.type).toBe("url");
    expect(candidate.get("phone")?.type).toBe("phone");
    const interview = new Map(
      typeNamed(recruiting, "Interview").attributes.map((a) => [a.slug, a]),
    );
    expect(interview.get("rating")?.type).toBe("rating");
    expect(interview.get("interviewer")?.type).toBe("text");
  });

  it("leaves some optional values and links empty, and mixes createdBy", async () => {
    for (const space of await client.listSpaces()) {
      const schema = await client.getSchema(space.id);
      const records = (
        await Promise.all(
          schema.objectTypes.map((type) => allRecords(space.id, type.id)),
        )
      ).flat();
      const authors = new Set(records.map((record) => record.createdBy));
      expect(authors).toEqual(new Set([space.owner, "human"]));

      let emptyValues = 0;
      let emptyLinks = 0;
      for (const record of records) {
        const type = schema.objectTypes.find(
          (item) => item.id === record.typeId,
        );
        for (const attribute of type?.attributes ?? []) {
          if (attribute.relationship) {
            if (record.links[attribute.slug].length === 0) emptyLinks += 1;
          } else if (record.values[attribute.slug] === undefined) {
            emptyValues += 1;
          }
        }
      }
      expect(emptyValues).toBeGreaterThan(0);
      expect(emptyLinks).toBeGreaterThan(0);
    }
  });

  it("keeps links symmetric between the two sides", async () => {
    const schema = await client.getSchema(SEED_RAISE_SPACE_ID);
    const investors = await allRecords(
      SEED_RAISE_SPACE_ID,
      typeNamed(schema, "Investor").id,
    );
    const firms = await allRecords(
      SEED_RAISE_SPACE_ID,
      typeNamed(schema, "Firm").id,
    );
    for (const investor of investors) {
      for (const ref of investor.links.firm) {
        const firm = firms.find((item) => item.id === ref.id);
        expect(firm?.links.investors.map((item) => item.id)).toContain(
          investor.id,
        );
        expect(ref.name).toBe(firm?.values.name);
      }
      expect(investor.links.firm.length).toBeLessThanOrEqual(1);
    }
  });
});
