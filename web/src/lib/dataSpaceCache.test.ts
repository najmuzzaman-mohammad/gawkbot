import { describe, expect, it } from "vitest";

import type { DataSpace, SpaceSchema } from "../api/dataspaces";
import { replaceSpaceInList, replaceSpaceInSchema } from "./dataSpaceCache";

function space(id: string, overrides: Partial<DataSpace> = {}): DataSpace {
  return {
    id,
    name: `Space ${id}`,
    description: "",
    owner: "cos",
    objectTypeCount: 0,
    recordCount: 0,
    attachedAppIds: [],
    access: { scope: "private", grants: [] },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const GLOBAL = { scope: "global", grants: [] } as const;

describe("replaceSpaceInList", () => {
  it("swaps the matching space and keeps the others by reference and in order", () => {
    const before = [space("a"), space("b"), space("c")];
    const snapshot = structuredClone(before);
    const next = space("b", { access: GLOBAL });
    const after = replaceSpaceInList(before, next);
    expect(after).not.toBe(before);
    expect(after?.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(after?.[1]).toBe(next);
    expect(after?.[0]).toBe(before[0]);
    expect(after?.[2]).toBe(before[2]);
    expect(before).toEqual(snapshot);
  });

  it("never inserts a space the list did not have", () => {
    const before = [space("a")];
    expect(replaceSpaceInList(before, space("z"))).toBe(before);
    const empty: readonly DataSpace[] = [];
    expect(replaceSpaceInList(empty, space("z"))).toBe(empty);
  });

  it("passes undefined through, for a list that has not loaded", () => {
    expect(replaceSpaceInList(undefined, space("a"))).toBeUndefined();
  });
});

describe("replaceSpaceInSchema", () => {
  const schema: SpaceSchema = { space: space("a"), objectTypes: [] };

  it("swaps the space and keeps the object types by reference", () => {
    const next = space("a", {
      access: GLOBAL,
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
    const after = replaceSpaceInSchema(schema, next);
    expect(after).not.toBe(schema);
    expect(after?.space).toBe(next);
    expect(after?.objectTypes).toBe(schema.objectTypes);
    expect(schema.space.access.scope).toBe("private");
  });

  it("ignores a space with a different id, and undefined", () => {
    expect(replaceSpaceInSchema(schema, space("b"))).toBe(schema);
    expect(replaceSpaceInSchema(undefined, space("a"))).toBeUndefined();
  });
});
