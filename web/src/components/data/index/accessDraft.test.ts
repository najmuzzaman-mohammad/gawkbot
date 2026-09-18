import { describe, expect, it } from "vitest";

import type { SpaceAccess } from "../../../api/dataspaces";
import { PRIVATE_ACCESS } from "../../../api/dataspacesAccess";
import {
  type AccessDraft,
  draftFromAccess,
  draftLevel,
  draftToAccess,
  filterBotRows,
  isAccessDirty,
  isBecomingGlobal,
  isSharedWithNobody,
  mergeRoster,
  scopeExplanation,
  setDraftLevel,
} from "./accessDraft";

const OWNER = "cos";
const GLOBAL: SpaceAccess = { scope: "global", grants: [] };
const SHARED: SpaceAccess = {
  scope: "shared",
  grants: [
    { bot: "ops", level: "read" },
    { bot: "recruiter", level: "write" },
  ],
};

describe("draft to and from access", () => {
  it.each([
    ["private", PRIVATE_ACCESS],
    ["shared", SHARED],
    ["global", GLOBAL],
  ])("round-trips %s", (_name, access) => {
    expect(draftToAccess(OWNER, draftFromAccess(access))).toEqual(access);
  });

  it("reads a missing bot as no access", () => {
    const draft = draftFromAccess(SHARED);
    expect(draftLevel(draft, "ops")).toBe("read");
    expect(draftLevel(draft, "designer")).toBe("none");
  });

  it("sets a level without mutating the draft", () => {
    const draft = draftFromAccess(SHARED);
    const next = setDraftLevel(draft, "designer", "write");
    expect(draftLevel(next, "designer")).toBe("write");
    expect(draftLevel(draft, "designer")).toBe("none");
  });

  it("drops no-access bots and sorts the grants", () => {
    const draft: AccessDraft = {
      scope: "shared",
      levels: { recruiter: "none", ops: "write", designer: "read" },
    };
    expect(draftToAccess(OWNER, draft)).toEqual({
      scope: "shared",
      grants: [
        { bot: "designer", level: "read" },
        { bot: "ops", level: "write" },
      ],
    });
  });

  it("stores shared with nobody as private", () => {
    const draft: AccessDraft = { scope: "shared", levels: { ops: "none" } };
    expect(draftToAccess(OWNER, draft)).toEqual(PRIVATE_ACCESS);
    expect(isSharedWithNobody(OWNER, draft)).toBe(true);
    expect(isSharedWithNobody(OWNER, draftFromAccess(SHARED))).toBe(false);
    expect(isSharedWithNobody(OWNER, draftFromAccess(PRIVATE_ACCESS))).toBe(
      false,
    );
  });

  it("keeps levels out of a global or private result", () => {
    const draft: AccessDraft = { scope: "global", levels: { ops: "write" } };
    expect(draftToAccess(OWNER, draft)).toEqual(GLOBAL);
  });
});

describe("isAccessDirty", () => {
  it.each<[string, SpaceAccess, AccessDraft, boolean]>([
    [
      "untouched private",
      PRIVATE_ACCESS,
      draftFromAccess(PRIVATE_ACCESS),
      false,
    ],
    ["untouched shared", SHARED, draftFromAccess(SHARED), false],
    [
      "shared with nobody over private",
      PRIVATE_ACCESS,
      { scope: "shared", levels: {} },
      false,
    ],
    [
      "a level changed",
      SHARED,
      setDraftLevel(draftFromAccess(SHARED), "ops", "write"),
      true,
    ],
    [
      "a level changed and changed back",
      SHARED,
      setDraftLevel(
        setDraftLevel(draftFromAccess(SHARED), "ops", "write"),
        "ops",
        "read",
      ),
      false,
    ],
    [
      "private to global",
      PRIVATE_ACCESS,
      { scope: "global", levels: {} },
      true,
    ],
    [
      "shared to private",
      SHARED,
      { ...draftFromAccess(SHARED), scope: "private" },
      true,
    ],
  ])("%s", (_name, stored, draft, expected) => {
    expect(isAccessDirty(OWNER, stored, draft)).toBe(expected);
  });
});

describe("isBecomingGlobal", () => {
  it("is true only when the stored access is not already global", () => {
    const toGlobal: AccessDraft = { scope: "global", levels: {} };
    expect(isBecomingGlobal(PRIVATE_ACCESS, toGlobal)).toBe(true);
    expect(isBecomingGlobal(SHARED, toGlobal)).toBe(true);
    expect(isBecomingGlobal(GLOBAL, toGlobal)).toBe(false);
    expect(isBecomingGlobal(GLOBAL, { scope: "private", levels: {} })).toBe(
      false,
    );
  });
});

describe("mergeRoster", () => {
  it("drops the owner and the operator and keeps roster order", () => {
    expect(
      mergeRoster(OWNER, ["cos", "recruiter", "human", "ops"], PRIVATE_ACCESS),
    ).toEqual([
      { bot: "recruiter", isInOffice: true },
      { bot: "ops", isInOffice: true },
    ]);
  });

  it("appends bots that hold a grant but left the office", () => {
    expect(
      mergeRoster(OWNER, ["cos", "ops"], {
        scope: "shared",
        grants: [
          { bot: "ops", level: "read" },
          { bot: "zed", level: "read" },
          { bot: "intern", level: "write" },
        ],
      }),
    ).toEqual([
      { bot: "ops", isInOffice: true },
      { bot: "intern", isInOffice: false },
      { bot: "zed", isInOffice: false },
    ]);
  });

  it("normalizes and de-duplicates roster slugs", () => {
    expect(mergeRoster(OWNER, [" Ops ", "ops", ""], PRIVATE_ACCESS)).toEqual([
      { bot: "ops", isInOffice: true },
    ]);
  });
});

describe("filterBotRows", () => {
  const rows = mergeRoster(
    OWNER,
    ["ops", "recruiter", "designer"],
    PRIVATE_ACCESS,
  );
  it.each([
    ["", 3],
    ["  ", 3],
    ["re", 1],
    ["@OPS", 1],
    ["zzz", 0],
  ])("%j keeps %i", (query, count) => {
    expect(filterBotRows(rows, query)).toHaveLength(count);
  });
});

describe("scopeExplanation", () => {
  it("names the real owner", () => {
    expect(scopeExplanation("private", "ops")).toBe(
      "Only @ops and you can use this data space.",
    );
    expect(scopeExplanation("shared", "ops")).toBe(
      "@ops, you, and the bots you pick.",
    );
    expect(scopeExplanation("global", "ops")).toBe(
      "Every bot in the office can read and write, including bots you add later.",
    );
  });
});
