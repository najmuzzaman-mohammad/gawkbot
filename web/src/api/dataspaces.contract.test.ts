/**
 * The closed sets in `dataspaces.ts` are the TypeScript half of a contract
 * whose other half is `internal/dataspace/types.go`. Nothing in the build
 * links the two, so a value added on the Go side used to arrive at runtime as
 * a string no component had a branch for: a missing renderer, a blank label,
 * a delete kind the UI could not ask for.
 *
 * This reads the Go file and compares the lists. It is deliberately a dumb
 * regex over the source rather than anything generated: the point is that
 * adding a constant in Go without adding it here goes red, and a check that
 * needs a build step to stay honest is a check that quietly stops running.
 */

import { describe, expect, it } from "vitest";

import {
  ACCESS_LEVELS,
  ATTRIBUTE_TYPES,
  CALLER_LEVELS,
  CARDINALITIES,
  DELETE_KINDS,
  FILTER_OPERATORS,
  SPACE_SCOPES,
} from "./dataspaces";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const RELATIVE_PATH = "internal/dataspace/types.go";

/**
 * Walks up from the working directory rather than resolving against
 * `import.meta.url`: the test module's URL is not a file URL under the Vite
 * transform. A miss throws instead of returning nothing to compare against.
 */
function findTypesGo(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `${RELATIVE_PATH} not found above ${process.cwd()}; this test pins the TypeScript enums to it.`,
  );
}

const source = readFileSync(findTypesGo(), "utf8");

/**
 * Every `Name <GoType> = "value"` in the file, in declaration order. Each
 * const in these blocks names its own type, so no block parsing is needed.
 */
function goConstValues(goType: string): readonly string[] {
  const pattern = new RegExp(
    `^\\s*[A-Za-z0-9_]+\\s+${goType}\\s*=\\s*"([^"]*)"`,
    "gm",
  );
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

describe("data space enums match internal/dataspace/types.go", () => {
  // A regex that matched nothing would make every comparison below pass
  // against an empty list, which is the failure mode this file exists to
  // rule out elsewhere. Assert the reader found the file and can read it.
  it("reads the Go source it is pinned to", () => {
    expect(source).toContain("package dataspace");
    expect(goConstValues("AttributeType").length).toBeGreaterThan(0);
  });

  const cases: readonly [string, string, readonly string[]][] = [
    ["attribute type", "AttributeType", ATTRIBUTE_TYPES],
    ["cardinality", "Cardinality", CARDINALITIES],
    ["filter operator", "Operator", FILTER_OPERATORS],
    ["delete kind", "DeleteKind", DELETE_KINDS],
    ["scope", "Scope", SPACE_SCOPES],
    ["access level", "Level", CALLER_LEVELS],
  ];

  for (const [label, goType, tsValues] of cases) {
    it(`has every ${label} the store defines, and no others`, () => {
      expect([...tsValues].sort()).toEqual([...goConstValues(goType)].sort());
    });
  }

  /**
   * `ACCESS_LEVELS` is the subset a grant may name: the store rejects a grant
   * of `none`, and the owner's write access is implicit. It is derived from
   * the caller levels here so that adding a level in Go cannot leave this one
   * silently behind.
   */
  it("offers every caller level except none as a grant level", () => {
    expect([...ACCESS_LEVELS].sort()).toEqual(
      CALLER_LEVELS.filter((level) => level !== "none").sort(),
    );
  });
});
