import { beforeEach, describe, expect, it, vi } from "vitest";

import { get, patch, post, put } from "../../api/client";
import {
  type DataCallArgs,
  dispatchDataCall,
  parseDataArgs,
  resolveAppDataSpace,
} from "./appDataBridge";

vi.mock("../../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
}));

describe("parseDataArgs", () => {
  it("accepts every op in the allowlist with its own fields", () => {
    expect(parseDataArgs({ op: "schema" })).toEqual({ op: "schema" });
    expect(parseDataArgs({ op: "query", objectType: "investor" })).toEqual({
      op: "query",
      objectType: "investor",
      filters: [],
      sort: null,
      search: "",
      limit: 0,
      offset: 0,
    });
    expect(
      parseDataArgs({
        op: "create",
        objectType: "investor",
        values: { name: "Ada" },
      }),
    ).toEqual({
      op: "create",
      objectType: "investor",
      values: { name: "Ada" },
    });
    expect(
      parseDataArgs({
        op: "upsert",
        objectType: "investor",
        matchingAttribute: "email",
        rows: [{ email: "a@b.com" }],
      }),
    ).toEqual({
      op: "upsert",
      objectType: "investor",
      matchingAttribute: "email",
      rows: [{ email: "a@b.com" }],
    });
    expect(
      parseDataArgs({
        op: "update",
        recordId: "rec_1",
        values: { stage: "x" },
      }),
    ).toEqual({ op: "update", recordId: "rec_1", values: { stage: "x" } });
    expect(
      parseDataArgs({
        op: "link",
        recordId: "rec_1",
        attribute: "firm",
        targetId: "rec_2",
        replace: true,
      }),
    ).toEqual({
      op: "link",
      recordId: "rec_1",
      attribute: "firm",
      targetId: "rec_2",
      replace: true,
    });
    expect(
      parseDataArgs({
        op: "unlink",
        recordId: "rec_1",
        attribute: "firm",
        targetId: "rec_2",
      }),
    ).toEqual({
      op: "unlink",
      recordId: "rec_1",
      attribute: "firm",
      targetId: "rec_2",
    });
  });

  // THE SCOPING RULE. A space id has no field to arrive in, so an app naming
  // one is not merely refused — the value is structurally unable to travel.
  it("drops any space the app names, on every op", () => {
    for (const op of ["schema", "query", "create", "update"] as const) {
      const args = parseDataArgs({
        op,
        space: "space_other",
        space_id: "space_other",
        spaceId: "space_other",
        objectType: "investor",
        recordId: "rec_1",
        values: { name: "Ada" },
      });
      expect(args).not.toBeNull();
      expect(JSON.stringify(args)).not.toContain("space_other");
    }
  });

  it("rejects an unknown or missing op", () => {
    expect(parseDataArgs({ op: "delete" })).toBeNull();
    expect(parseDataArgs({ op: "" })).toBeNull();
    expect(parseDataArgs({})).toBeNull();
    expect(parseDataArgs(null)).toBeNull();
    expect(parseDataArgs("schema")).toBeNull();
  });

  it("rejects a call missing the fields its own op needs", () => {
    expect(parseDataArgs({ op: "query" })).toBeNull();
    expect(parseDataArgs({ op: "create", objectType: "investor" })).toBeNull();
    expect(parseDataArgs({ op: "create", values: { a: 1 } })).toBeNull();
    expect(
      parseDataArgs({ op: "upsert", objectType: "investor", rows: [] }),
    ).toBeNull();
    expect(parseDataArgs({ op: "update", values: {} })).toBeNull();
    expect(
      parseDataArgs({ op: "link", recordId: "rec_1", attribute: "firm" }),
    ).toBeNull();
  });

  // Reject-don't-truncate: a sliced record id addresses the WRONG record.
  it("rejects an oversized reference instead of slicing it", () => {
    const huge = "r".repeat(201);
    expect(parseDataArgs({ op: "query", objectType: huge })).toBeNull();
    expect(
      parseDataArgs({ op: "update", recordId: huge, values: {} }),
    ).toBeNull();
    expect(
      parseDataArgs({
        op: "link",
        recordId: "rec_1",
        attribute: huge,
        targetId: "rec_2",
      }),
    ).toBeNull();
  });

  // Silently writing 1 of 2 rows is data loss the app never learns about.
  it("rejects the whole upsert when any row is malformed", () => {
    expect(
      parseDataArgs({
        op: "upsert",
        objectType: "investor",
        matchingAttribute: "email",
        rows: [{ email: "a@b.com" }, null],
      }),
    ).toBeNull();
    expect(
      parseDataArgs({
        op: "upsert",
        objectType: "investor",
        matchingAttribute: "email",
        rows: [["not", "a", "row"]],
      }),
    ).toBeNull();
  });

  it("normalizes query options and rejects unusable ones", () => {
    expect(
      parseDataArgs({
        op: "query",
        objectType: "investor",
        filters: [{ attribute: "stage", operator: "equals", value: "Pitched" }],
        sort: { attribute: "stage", desc: true },
        search: "  ada  ",
        limit: 30,
        offset: 60,
      }),
    ).toEqual({
      op: "query",
      objectType: "investor",
      filters: [{ attribute: "stage", operator: "equals", value: "Pitched" }],
      sort: { attribute: "stage", desc: true },
      search: "ada",
      limit: 30,
      offset: 60,
    });
    // A filter missing its attribute would silently widen the result set.
    expect(
      parseDataArgs({
        op: "query",
        objectType: "investor",
        filters: [{ operator: "equals", value: "x" }],
      }),
    ).toBeNull();
    expect(
      parseDataArgs({ op: "query", objectType: "investor", limit: -1 }),
    ).toBeNull();
    expect(
      parseDataArgs({ op: "query", objectType: "investor", limit: 5000 }),
    ).toBeNull();
    expect(
      parseDataArgs({ op: "query", objectType: "investor", sort: "stage" }),
    ).toBeNull();
  });
});

describe("dispatchDataCall", () => {
  beforeEach(() => {
    vi.mocked(get).mockReset().mockResolvedValue({});
    vi.mocked(post).mockReset().mockResolvedValue({});
    vi.mocked(put).mockReset().mockResolvedValue({});
    vi.mocked(patch).mockReset().mockResolvedValue({});
  });

  it("maps each op onto its documented route under the given space", async () => {
    await dispatchDataCall("space_1", { op: "schema" });
    expect(get).toHaveBeenCalledWith("/data/spaces/space_1");

    await dispatchDataCall("space_1", {
      op: "query",
      objectType: "investor",
      filters: [],
      sort: null,
      search: "",
      limit: 0,
      offset: 0,
    });
    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/records/query", {
      object_type: "investor",
    });

    await dispatchDataCall("space_1", {
      op: "create",
      objectType: "investor",
      values: { name: "Ada" },
    });
    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/records", {
      object_type: "investor",
      items: [{ values: { name: "Ada" } }],
    });

    await dispatchDataCall("space_1", {
      op: "upsert",
      objectType: "investor",
      matchingAttribute: "email",
      rows: [{ email: "a@b.com" }],
    });
    expect(put).toHaveBeenCalledWith("/data/spaces/space_1/records", {
      object_type: "investor",
      matching_attribute: "email",
      items: [{ values: { email: "a@b.com" } }],
    });

    await dispatchDataCall("space_1", {
      op: "update",
      recordId: "rec_1",
      values: { stage: "Pitched" },
    });
    expect(patch).toHaveBeenCalledWith("/data/spaces/space_1/records/rec_1", {
      values: { stage: "Pitched" },
    });

    await dispatchDataCall("space_1", {
      op: "link",
      recordId: "rec_1",
      attribute: "firm",
      targetId: "rec_2",
      replace: true,
    });
    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/links", {
      items: [
        {
          record: "rec_1",
          attribute: "firm",
          target: "rec_2",
          replace: true,
        },
      ],
    });

    await dispatchDataCall("space_1", {
      op: "unlink",
      recordId: "rec_1",
      attribute: "firm",
      targetId: "rec_2",
    });
    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/unlinks", {
      items: [{ record: "rec_1", attribute: "firm", target: "rec_2" }],
    });
  });

  it("includes query options only when they were given", async () => {
    const args: DataCallArgs = {
      op: "query",
      objectType: "investor",
      filters: [{ attribute: "stage", operator: "equals", value: "Pitched" }],
      sort: { attribute: "stage", desc: true },
      search: "ada",
      limit: 30,
      offset: 60,
    };
    await dispatchDataCall("space_1", args);
    expect(post).toHaveBeenCalledWith("/data/spaces/space_1/records/query", {
      object_type: "investor",
      filters: [{ attribute: "stage", operator: "equals", value: "Pitched" }],
      sort: { attribute: "stage", desc: true },
      query: "ada",
      limit: 30,
      offset: 60,
    });
  });
});

describe("resolveAppDataSpace", () => {
  beforeEach(() => {
    vi.mocked(get).mockReset();
  });

  it("reads the binding off the app's own manifest", async () => {
    vi.mocked(get).mockResolvedValue({ space_id: " space_1 " });
    await expect(resolveAppDataSpace("app_abc")).resolves.toBe("space_1");
    expect(get).toHaveBeenCalledWith("/apps/app_abc/data-space");
  });

  it("resolves to empty when nothing is attached", async () => {
    vi.mocked(get).mockResolvedValue({});
    await expect(resolveAppDataSpace("app_abc")).resolves.toBe("");
  });

  // One GET for a burst, but nothing cached ACROSS calls: an attach or detach
  // takes effect on the next call, not after a page reload.
  it("dedupes concurrent lookups and then forgets them", async () => {
    vi.mocked(get).mockResolvedValue({ space_id: "space_1" });
    await Promise.all([
      resolveAppDataSpace("app_abc"),
      resolveAppDataSpace("app_abc"),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    await resolveAppDataSpace("app_abc");
    expect(get).toHaveBeenCalledTimes(2);
  });
});
