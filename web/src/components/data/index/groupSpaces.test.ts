import { describe, expect, it } from "vitest";

import type { DataSpace, SpaceAccess } from "../../../api/dataspaces";
import { PRIVATE_ACCESS } from "../../../api/dataspacesAccess";
import { groupSpaces, sharedWithLine } from "./groupSpaces";

function space(id: string, owner: string, access: SpaceAccess): DataSpace {
  return {
    id,
    name: id,
    description: "",
    owner,
    objectTypeCount: 0,
    recordCount: 0,
    attachedAppIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    access,
    callerLevel: "write",
  };
}

const GLOBAL: SpaceAccess = { scope: "global", grants: [] };
const SPACES: readonly DataSpace[] = [
  space("seed", "cos", PRIVATE_ACCESS),
  space("delivery", "ops", {
    scope: "shared",
    grants: [{ bot: "cos", level: "read" }],
  }),
  space("recruiting", "recruiter", {
    scope: "shared",
    grants: [
      { bot: "cos", level: "write" },
      { bot: "ops", level: "read" },
    ],
  }),
  space("directory", "cos", GLOBAL),
  space("handbook", "designer", GLOBAL),
];

describe("groupSpaces", () => {
  const groups = groupSpaces(SPACES);

  it("collects every global space, whoever owns it", () => {
    expect(groups.global.map((item) => item.id)).toEqual([
      "directory",
      "handbook",
    ]);
  });

  it("groups the rest by owner in first-seen order, never repeating a space", () => {
    expect(
      groups.bots.map((group) => [
        group.owner,
        group.spaces.map((item) => item.id),
      ]),
    ).toEqual([
      ["cos", ["seed"]],
      ["ops", ["delivery"]],
      ["recruiter", ["recruiting"]],
    ]);
    const placed = [
      ...groups.global,
      ...groups.bots.flatMap((group) => group.spaces),
    ];
    expect(placed).toHaveLength(SPACES.length);
  });

  it("gives no group to a bot that owns only global spaces", () => {
    expect(groups.bots.some((group) => group.owner === "designer")).toBe(false);
  });

  it.each([
    ["cos", 2],
    ["ops", 1],
    ["recruiter", 0],
  ])("counts spaces shared with @%s, without global ones: %i", (owner, count) => {
    expect(
      groups.bots.find((group) => group.owner === owner)?.sharedWithCount,
    ).toBe(count);
  });

  it("handles no spaces", () => {
    expect(groupSpaces([])).toEqual({ global: [], bots: [] });
  });
});

describe("sharedWithLine", () => {
  it.each([
    [0, null],
    [1, "Also has access to 1 shared space"],
    [2, "Also has access to 2 shared spaces"],
  ])("%i reads as %s", (count, line) => {
    expect(sharedWithLine(count)).toBe(line);
  });
});
