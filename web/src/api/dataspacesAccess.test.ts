import { describe, expect, it } from "vitest";

import {
  DataValidationError,
  type SpaceAccess,
  type SpaceGrant,
} from "./dataspaces";
import {
  botAccessLevel,
  canBotRead,
  canBotWrite,
  describeAccess,
  normalizeAccess,
  normalizeBotSlug,
  PRIVATE_ACCESS,
} from "./dataspacesAccess";

const OWNER = "cos";

function shared(...grants: SpaceGrant[]): SpaceAccess {
  return { scope: "shared", grants };
}

describe("normalizeAccess", () => {
  const cases: readonly (readonly [string, SpaceAccess, SpaceAccess])[] = [
    ["private stays private", PRIVATE_ACCESS, { scope: "private", grants: [] }],
    [
      "global stays global",
      { scope: "global", grants: [] },
      { scope: "global", grants: [] },
    ],
    [
      "private drops grants",
      { scope: "private", grants: [{ bot: "ops", level: "write" }] },
      { scope: "private", grants: [] },
    ],
    [
      "global drops grants",
      { scope: "global", grants: [{ bot: "ops", level: "read" }] },
      { scope: "global", grants: [] },
    ],
    [
      "shared keeps a grant",
      shared({ bot: "ops", level: "read" }),
      shared({ bot: "ops", level: "read" }),
    ],
    [
      "shared with no grants becomes private",
      shared(),
      { scope: "private", grants: [] },
    ],
    [
      "a grant naming the owner is dropped",
      shared({ bot: "cos", level: "read" }, { bot: "ops", level: "write" }),
      shared({ bot: "ops", level: "write" }),
    ],
    [
      "shared with only the owner becomes private",
      shared({ bot: " COS ", level: "write" }),
      { scope: "private", grants: [] },
    ],
    [
      "slugs are trimmed and lowercased",
      shared({ bot: "  Ops ", level: "read" }),
      shared({ bot: "ops", level: "read" }),
    ],
    [
      "a bot named twice keeps the last level",
      shared(
        { bot: "ops", level: "write" },
        { bot: "recruiter", level: "read" },
        { bot: "OPS", level: "read" },
      ),
      shared(
        { bot: "ops", level: "read" },
        { bot: "recruiter", level: "read" },
      ),
    ],
    [
      "grants are sorted by bot slug",
      shared(
        { bot: "recruiter", level: "read" },
        { bot: "analyst-2", level: "write" },
        { bot: "ops", level: "read" },
        { bot: "7up", level: "read" },
      ),
      shared(
        { bot: "7up", level: "read" },
        { bot: "analyst-2", level: "write" },
        { bot: "ops", level: "read" },
        { bot: "recruiter", level: "read" },
      ),
    ],
  ];

  it.each(cases)("%s", (_label, input, expected) => {
    const frozen = structuredClone(input);
    expect(normalizeAccess(OWNER, input)).toEqual(expected);
    expect(input).toEqual(frozen);
  });

  it("compares the owner case-insensitively", () => {
    expect(
      normalizeAccess(" Cos ", shared({ bot: "cos", level: "read" })),
    ).toEqual(PRIVATE_ACCESS);
  });

  it("always returns a new object, never the input or the shared constant", () => {
    const input = shared({ bot: "ops", level: "read" });
    const out = normalizeAccess(OWNER, input);
    expect(out).not.toBe(input);
    expect(out.grants).not.toBe(input.grants);
    expect(out.grants[0]).not.toBe(input.grants[0]);
    expect(normalizeAccess(OWNER, PRIVATE_ACCESS)).not.toBe(PRIVATE_ACCESS);
  });

  it("is idempotent", () => {
    const once = normalizeAccess(
      OWNER,
      shared(
        { bot: "Recruiter", level: "read" },
        { bot: "cos", level: "read" },
      ),
    );
    expect(normalizeAccess(OWNER, once)).toEqual(once);
  });

  it.each([
    ["team"],
    ["Private"],
    [""],
    [undefined],
    [null],
    [3],
  ])("rejects the scope %j and lists the valid ones", (scope) => {
    const bad = { scope, grants: [] } as unknown as SpaceAccess;
    expect(() => normalizeAccess(OWNER, bad)).toThrow(DataValidationError);
    expect(() => normalizeAccess(OWNER, bad)).toThrow(
      "Valid scopes: private, shared, global.",
    );
  });

  it.each([
    [""],
    ["   "],
    ["-ops"],
    ["ops bot"],
    ["ops_bot"],
    ["@ops"],
    ["öps"],
    ["ops."],
  ])("rejects the bot slug %j and names it", (bot) => {
    const bad = shared(
      { bot: "recruiter", level: "read" },
      { bot, level: "read" },
    );
    expect(() => normalizeAccess(OWNER, bad)).toThrow(DataValidationError);
    expect(() => normalizeAccess(OWNER, bad)).toThrow(
      `"${bot}" is not a valid bot slug`,
    );
  });

  it.each([
    ["ops"],
    ["a"],
    ["7"],
    ["chief-of-staff"],
    ["bot-2-b"],
    ["a-"],
  ])("accepts the bot slug %j", (bot) => {
    expect(
      normalizeAccess(OWNER, shared({ bot, level: "read" })).grants,
    ).toEqual([{ bot, level: "read" }]);
  });

  it("rejects a non-string bot and a missing grants list", () => {
    const numeric = shared({ bot: 7, level: "read" } as unknown as SpaceGrant);
    const noList = { scope: "shared" } as unknown as SpaceAccess;
    expect(() => normalizeAccess(OWNER, numeric)).toThrow(
      '"7" is not a valid bot slug',
    );
    expect(() => normalizeAccess(OWNER, noList)).toThrow(
      "needs a list of grants",
    );
  });

  it.each([
    ["admin"],
    ["Read"],
    [""],
    [undefined],
  ])("rejects the level %j, naming the bot and the valid levels", (level) => {
    const bad = shared({ bot: "ops", level } as unknown as SpaceGrant);
    expect(() => normalizeAccess(OWNER, bad)).toThrow(DataValidationError);
    expect(() => normalizeAccess(OWNER, bad)).toThrow(
      `is not an access level for @ops. Valid levels: read, write.`,
    );
  });

  it("validates the owner's own grant too, before dropping it", () => {
    const bad = shared({ bot: "cos", level: "owner" } as unknown as SpaceGrant);
    expect(() => normalizeAccess(OWNER, bad)).toThrow("is not an access level");
  });

  it("ignores grants without validating them when the scope is not shared", () => {
    const junk = { bot: "NOT A SLUG", level: "nope" } as unknown as SpaceGrant;
    expect(normalizeAccess(OWNER, { scope: "global", grants: [junk] })).toEqual(
      {
        scope: "global",
        grants: [],
      },
    );
    expect(
      normalizeAccess(OWNER, { scope: "private", grants: [junk] }),
    ).toEqual(PRIVATE_ACCESS);
  });
});

describe("botAccessLevel", () => {
  const grants: SpaceGrant[] = [
    { bot: "ops", level: "read" },
    { bot: "recruiter", level: "write" },
  ];
  const spaces = {
    private: { owner: OWNER, access: PRIVATE_ACCESS },
    shared: { owner: OWNER, access: shared(...grants) },
    global: {
      owner: OWNER,
      access: { scope: "global", grants: [] } as SpaceAccess,
    },
    // Not a normalized shape, but a store could hand it over.
    globalWithGrants: {
      owner: OWNER,
      access: { scope: "global", grants } as SpaceAccess,
    },
    privateWithGrants: {
      owner: OWNER,
      access: { scope: "private", grants } as SpaceAccess,
    },
  };

  const cases: readonly (readonly [keyof typeof spaces, string, string])[] = [
    ["private", "cos", "write"],
    ["private", "ops", "none"],
    ["private", "stranger", "none"],
    ["shared", "cos", "write"],
    ["shared", "ops", "read"],
    ["shared", "recruiter", "write"],
    ["shared", "stranger", "none"],
    ["shared", " OPS ", "read"],
    ["shared", "", "none"],
    ["global", "cos", "write"],
    ["global", "ops", "write"],
    ["global", "stranger", "write"],
    ["global", "", "none"],
    ["globalWithGrants", "ops", "write"],
    ["privateWithGrants", "recruiter", "none"],
    ["privateWithGrants", "COS", "write"],
  ];

  it.each(cases)("%s space, bot %j -> %s", (key, bot, expected) => {
    const space = spaces[key];
    expect(botAccessLevel(space, bot)).toBe(expected);
    expect(canBotRead(space, bot)).toBe(expected !== "none");
    expect(canBotWrite(space, bot)).toBe(expected === "write");
  });
});

describe("describeAccess", () => {
  it.each([
    [PRIVATE_ACCESS, "Private"],
    [{ scope: "global", grants: [] }, "Global"],
    [shared(), "Private"],
    [shared({ bot: "ops", level: "read" }), "Shared with @ops"],
    [
      shared(
        { bot: "ops", level: "read" },
        { bot: "recruiter", level: "write" },
      ),
      "Shared with @ops and @recruiter",
    ],
    [
      shared(
        { bot: "analyst", level: "read" },
        { bot: "ops", level: "read" },
        { bot: "recruiter", level: "write" },
      ),
      "Shared with 3 bots",
    ],
    [{ scope: "private", grants: [{ bot: "ops", level: "read" }] }, "Private"],
  ] as const)("%j -> %s", (access, text) => {
    expect(describeAccess(access)).toBe(text);
  });
});

describe("normalizeBotSlug", () => {
  it("trims and lowercases", () => {
    expect(normalizeBotSlug("  Chief-Of-Staff ")).toBe("chief-of-staff");
  });
});
