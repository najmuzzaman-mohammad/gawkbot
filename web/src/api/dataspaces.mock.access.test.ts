import { describe, expect, it } from "vitest";

import type { SpaceAccess, SpaceGrant } from "./dataspaces";
import { createTestKit, validationError } from "./dataspaces.mock.testkit";
import { botAccessLevel } from "./dataspacesAccess";

// The empty test space is owned by `cos`.

describe("space access defaults", () => {
  it("starts every new space private with no grants", async () => {
    const kit = createTestKit();
    const [space] = await kit.client.listSpaces();
    expect(space.access).toEqual({ scope: "private", grants: [] });
    expect((await kit.client.getSchema(kit.spaceId)).space.access).toEqual(
      space.access,
    );
  });
});

describe("updateSpaceAccess", () => {
  it("stores normalized grants, returns the space, and bumps updatedAt", async () => {
    const kit = createTestKit();
    const [before] = await kit.client.listSpaces();
    const updated = await kit.client.updateSpaceAccess(kit.spaceId, {
      scope: "shared",
      grants: [
        { bot: " Recruiter ", level: "read" },
        { bot: "cos", level: "read" },
        { bot: "ops", level: "write" },
        { bot: "RECRUITER", level: "write" },
      ],
    });
    expect(updated.access).toEqual({
      scope: "shared",
      grants: [
        { bot: "ops", level: "write" },
        { bot: "recruiter", level: "write" },
      ],
    });
    expect(updated.id).toBe(kit.spaceId);
    expect(updated.updatedAt > before.updatedAt).toBe(true);
    const [listed] = await kit.client.listSpaces();
    expect(listed).toEqual(updated);
    expect((await kit.client.getSchema(kit.spaceId)).space).toEqual(updated);
  });

  it.each([
    [
      "global drops grants",
      { scope: "global", grants: [{ bot: "ops", level: "read" }] },
      "global",
    ],
    [
      "private drops grants",
      { scope: "private", grants: [{ bot: "ops", level: "read" }] },
      "private",
    ],
    [
      "shared with nobody is private",
      { scope: "shared", grants: [] },
      "private",
    ],
    [
      "shared with only the owner is private",
      { scope: "shared", grants: [{ bot: "cos", level: "write" }] },
      "private",
    ],
  ] as const)("%s", async (_label, access, scope) => {
    const kit = createTestKit();
    const updated = await kit.client.updateSpaceAccess(kit.spaceId, access);
    expect(updated.access).toEqual({ scope, grants: [] });
  });

  it.each([
    [
      "an unknown scope",
      { scope: "team", grants: [] },
      /Valid scopes: private, shared, global/,
    ],
    [
      "an invalid bot slug",
      { scope: "shared", grants: [{ bot: "Ops Bot", level: "read" }] },
      /"Ops Bot" is not a valid bot slug/,
    ],
    [
      "an unknown level",
      { scope: "shared", grants: [{ bot: "ops", level: "admin" }] },
      /Valid levels: read, write/,
    ],
  ])("rejects %s and leaves the space untouched", async (_label, access, pattern) => {
    const kit = createTestKit();
    await kit.client.updateSpaceAccess(kit.spaceId, {
      scope: "shared",
      grants: [{ bot: "ops", level: "read" }],
    });
    const [before] = await kit.client.listSpaces();
    const error = await validationError(
      kit.client.updateSpaceAccess(
        kit.spaceId,
        access as unknown as SpaceAccess,
      ),
    );
    expect(error.message).toMatch(pattern);
    expect((await kit.client.listSpaces())[0]).toEqual(before);
  });

  it("rejects an unknown space", async () => {
    const kit = createTestKit();
    const error = await validationError(
      kit.client.updateSpaceAccess("space_nope", {
        scope: "global",
        grants: [],
      }),
    );
    expect(error.message).toContain("Unknown data space");
  });

  it("hands back fresh copies and never keeps the caller's objects", async () => {
    const kit = createTestKit();
    const grants: SpaceGrant[] = [{ bot: "ops", level: "read" }];
    const updated = await kit.client.updateSpaceAccess(kit.spaceId, {
      scope: "shared",
      grants,
    });
    grants[0] = { bot: "intruder", level: "write" };
    (updated.access.grants as SpaceGrant[]).push({
      bot: "sneaky",
      level: "write",
    });
    const [listed] = await kit.client.listSpaces();
    expect(listed.access.grants).toEqual([{ bot: "ops", level: "read" }]);
  });

  it("leaves schema, records, and counts alone", async () => {
    const kit = createTestKit();
    const type = await kit.type("Note");
    await kit.client.createRecord(kit.spaceId, type.id, { name: "Hello" });
    const updated = await kit.client.updateSpaceAccess(kit.spaceId, {
      scope: "global",
      grants: [],
    });
    expect(updated).toMatchObject({ objectTypeCount: 1, recordCount: 1 });
    expect((await kit.readType(type.id)).recordCount).toBe(1);
  });
});

describe("sharing walkthrough: private, then shared, then global, then private", () => {
  it("answers botAccessLevel correctly at each step", async () => {
    const kit = createTestKit();
    const { client, spaceId } = kit;
    const levels = async () => {
      const [space] = await client.listSpaces();
      return ["cos", "ops", "recruiter"].map((bot) =>
        botAccessLevel(space, bot),
      );
    };

    // A bot-owned space starts private: only the owner gets in.
    expect(await levels()).toEqual(["write", "none", "none"]);

    // Shared with one other bot at read; a third bot still sees nothing.
    const sharedSpace = await client.updateSpaceAccess(spaceId, {
      scope: "shared",
      grants: [{ bot: "ops", level: "read" }],
    });
    expect(sharedSpace.access.scope).toBe("shared");
    expect(await levels()).toEqual(["write", "read", "none"]);

    // Made global: every bot, present and future, reads and writes.
    const globalSpace = await client.updateSpaceAccess(spaceId, {
      scope: "global",
      grants: [],
    });
    expect(globalSpace.access).toEqual({ scope: "global", grants: [] });
    expect(await levels()).toEqual(["write", "write", "write"]);
    expect(botAccessLevel(globalSpace, "hired-next-year")).toBe("write");

    // Back to private: the earlier grants are gone, not remembered.
    const privateSpace = await client.updateSpaceAccess(spaceId, {
      scope: "private",
      grants: [{ bot: "ops", level: "read" }],
    });
    expect(privateSpace.access).toEqual({ scope: "private", grants: [] });
    expect(await levels()).toEqual(["write", "none", "none"]);
  });
});
