import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DataClient,
  type DataRecord,
  type DataSpace,
  DataValidationError,
  type RecordPage,
  type RecordQuery,
  type SpaceSchema,
} from "../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../api/dataspaces.fixtures";
import { createMockDataClient } from "../api/dataspaces.mock";
import {
  dataKeys,
  useCreateRecord,
  useDataRecord,
  useDataSpaces,
  useExecuteDelete,
  useLinkRecords,
  usePreviewDelete,
  useRecordPage,
  useSpaceSchema,
  useUpdateRecordValues,
  useUpdateSpaceAccess,
} from "./useDataSpaces";

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../api/dataspacesClient", () => ({
  get dataClient() {
    return holder.client;
  },
}));

const SPACE = SEED_RAISE_SPACE_ID;

function setup() {
  const client: DataClient = createMockDataClient(undefined, { delayMs: 0 });
  holder.client = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { client, queryClient, wrapper };
}

async function investorSetup() {
  const ctx = setup();
  const schema = await ctx.client.getSchema(SPACE);
  const investor = schema.objectTypes.find((type) => type.name === "Investor");
  const firm = schema.objectTypes.find((type) => type.name === "Firm");
  if (!(investor && firm)) throw new Error("fixture types missing");
  const query: RecordQuery = { typeId: investor.id, limit: 10, offset: 0 };
  const otherQuery: RecordQuery = {
    typeId: investor.id,
    limit: 50,
    offset: 0,
    sort: { attribute: "name", direction: "asc" },
  };
  const firmQuery: RecordQuery = { typeId: firm.id, limit: 50, offset: 0 };
  return { ...ctx, schema, investor, firm, query, otherQuery, firmQuery };
}

beforeEach(() => {
  holder.client = null;
});

describe("dataKeys", () => {
  it("makes recordPages a prefix of every recordPage for the type", () => {
    const query: RecordQuery = { typeId: "type_1", limit: 30, offset: 0 };
    const prefix = dataKeys.recordPages("s", "type_1");
    expect(dataKeys.recordPage("s", query).slice(0, prefix.length)).toEqual([
      ...prefix,
    ]);
    expect(dataKeys.spaces()).toEqual(["data", "spaces"]);
    expect(dataKeys.schema("s")).toEqual(["data", "schema", "s"]);
    expect(dataKeys.record("s", "r")).toEqual(["data", "record", "s", "r"]);
  });
});

describe("queries", () => {
  it("loads spaces, a schema, a record page, and a record", async () => {
    const { wrapper, investor, query } = await investorSetup();
    const spaces = renderHook(() => useDataSpaces(), { wrapper });
    const schema = renderHook(() => useSpaceSchema(SPACE), { wrapper });
    const page = renderHook(() => useRecordPage(SPACE, query), { wrapper });
    await waitFor(() => expect(page.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(spaces.result.current.data).toHaveLength(4));
    await waitFor(() =>
      expect(schema.result.current.data?.objectTypes).toHaveLength(3),
    );
    expect(page.result.current.data?.total).toBe(investor.recordCount);
    const firstId = page.result.current.data?.records[0].id ?? null;
    const record = renderHook(() => useDataRecord(SPACE, firstId), { wrapper });
    await waitFor(() => expect(record.result.current.data?.id).toBe(firstId));
  });

  it("stays idle while the record id is null", async () => {
    const { wrapper } = setup();
    const record = renderHook(() => useDataRecord(SPACE, null), { wrapper });
    expect(record.result.current.fetchStatus).toBe("idle");
    expect(record.result.current.data).toBeUndefined();
  });

  it("keeps the previous page as placeholder data while the next loads", async () => {
    const { wrapper, query } = await investorSetup();
    const page = renderHook(
      ({ q }: { q: RecordQuery }) => useRecordPage(SPACE, q),
      {
        wrapper,
        initialProps: { q: query },
      },
    );
    await waitFor(() => expect(page.result.current.isSuccess).toBe(true));
    const firstIds = page.result.current.data?.records.map(
      (record) => record.id,
    );
    page.rerender({ q: { ...query, offset: 10 } });
    expect(page.result.current.isPlaceholderData).toBe(true);
    expect(
      page.result.current.data?.records.map((record) => record.id),
    ).toEqual(firstIds);
    await waitFor(() =>
      expect(page.result.current.isPlaceholderData).toBe(false),
    );
  });
});

describe("useUpdateRecordValues", () => {
  it("patches every cached page and the record before the server answers", async () => {
    const { client, queryClient, wrapper, query, otherQuery } =
      await investorSetup();
    const page = await client.queryRecords(SPACE, query);
    const other = await client.queryRecords(SPACE, otherQuery);
    const target = page.records[0];
    queryClient.setQueryData(dataKeys.recordPage(SPACE, query), page);
    queryClient.setQueryData(dataKeys.recordPage(SPACE, otherQuery), other);
    queryClient.setQueryData(dataKeys.record(SPACE, target.id), target);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realUpdate = client.updateRecord.bind(client);
    client.updateRecord = async (...args) => {
      await gate;
      return realUpdate(...args);
    };

    const hook = renderHook(() => useUpdateRecordValues(SPACE), { wrapper });
    act(() => {
      hook.result.current.mutate({
        recordId: target.id,
        typeId: target.typeId,
        values: { notes: "optimistic", check_size: null },
      });
    });
    await waitFor(() => {
      const cached = queryClient.getQueryData<DataRecord>(
        dataKeys.record(SPACE, target.id),
      );
      expect(cached?.values.notes).toBe("optimistic");
    });
    for (const q of [query, otherQuery]) {
      const cached = queryClient.getQueryData<RecordPage>(
        dataKeys.recordPage(SPACE, q),
      );
      const row = cached?.records.find((record) => record.id === target.id);
      expect(row?.values.notes).toBe("optimistic");
      expect(row?.values.check_size).toBeUndefined();
    }
    // The snapshot objects were not mutated.
    expect(page.records[0].values.notes).toBe(target.values.notes);

    release();
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    const saved = await client.getRecord(SPACE, target.id);
    expect(saved.values.notes).toBe("optimistic");
  });

  it("restores every snapshot on error and surfaces the error to the caller", async () => {
    const { client, queryClient, wrapper, query, otherQuery } =
      await investorSetup();
    const page = await client.queryRecords(SPACE, query);
    const other = await client.queryRecords(SPACE, otherQuery);
    const target = page.records[0];
    queryClient.setQueryData(dataKeys.recordPage(SPACE, query), page);
    queryClient.setQueryData(dataKeys.recordPage(SPACE, otherQuery), other);
    queryClient.setQueryData(dataKeys.record(SPACE, target.id), target);
    // Keep the refetch from masking the restore.
    client.queryRecords = () => new Promise<RecordPage>(() => undefined);
    client.getRecord = () => new Promise<DataRecord>(() => undefined);

    const hook = renderHook(() => useUpdateRecordValues(SPACE), { wrapper });
    let caught: unknown = null;
    await act(async () => {
      try {
        await hook.result.current.mutateAsync({
          recordId: target.id,
          typeId: target.typeId,
          values: { notes: "will roll back", stage: "Not a stage" },
        });
      } catch (error: unknown) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(DataValidationError);
    expect((caught as DataValidationError).message).toContain(
      "Valid options: Intro",
    );
    expect(queryClient.getQueryData(dataKeys.recordPage(SPACE, query))).toEqual(
      page,
    );
    expect(
      queryClient.getQueryData(dataKeys.recordPage(SPACE, otherQuery)),
    ).toEqual(other);
    expect(queryClient.getQueryData(dataKeys.record(SPACE, target.id))).toEqual(
      target,
    );
    const state = queryClient.getQueryState(dataKeys.recordPage(SPACE, query));
    expect(state?.isInvalidated).toBe(true);
  });

  it("invalidates other types' pages when the primary name changes", async () => {
    const { client, queryClient, wrapper, schema, query, firmQuery } =
      await investorSetup();
    queryClient.setQueryData<SpaceSchema>(dataKeys.schema(SPACE), schema);
    const firms = await client.queryRecords(SPACE, firmQuery);
    const investors = await client.queryRecords(SPACE, query);
    queryClient.setQueryData(dataKeys.recordPage(SPACE, firmQuery), firms);
    queryClient.setQueryData(dataKeys.recordPage(SPACE, query), investors);
    const firm = firms.records[0];

    const hook = renderHook(() => useUpdateRecordValues(SPACE), { wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync({
        recordId: firm.id,
        typeId: firm.typeId,
        values: { name: "Tidewrack Capital Partners" },
      });
    });
    expect(
      queryClient.getQueryState(dataKeys.recordPage(SPACE, query))
        ?.isInvalidated,
    ).toBe(true);
  });
});

describe("useUpdateSpaceAccess", () => {
  it("writes the returned space into the list and schema caches, then invalidates both", async () => {
    const { client, queryClient, wrapper, schema } = await investorSetup();
    const spaces = await client.listSpaces();
    queryClient.setQueryData(dataKeys.spaces(), spaces);
    queryClient.setQueryData(dataKeys.schema(SPACE), schema);
    // Keep the refetch from masking what onSuccess wrote.
    client.listSpaces = () =>
      new Promise<readonly DataSpace[]>(() => undefined);
    client.getSchema = () => new Promise<SpaceSchema>(() => undefined);

    const hook = renderHook(() => useUpdateSpaceAccess(), { wrapper });
    let returned: DataSpace | null = null;
    await act(async () => {
      returned = await hook.result.current.mutateAsync({
        spaceId: SPACE,
        access: {
          scope: "shared",
          grants: [
            { bot: "Recruiter", level: "read" },
            { bot: "cos", level: "write" },
          ],
        },
      });
    });
    const expected = {
      scope: "shared",
      grants: [{ bot: "recruiter", level: "read" }],
    };
    expect((returned as DataSpace | null)?.access).toEqual(expected);

    const list = queryClient.getQueryData<readonly DataSpace[]>(
      dataKeys.spaces(),
    );
    expect(list?.map((space) => space.id)).toEqual(
      spaces.map((space) => space.id),
    );
    expect(list?.[0]).toEqual(returned);
    expect(list?.[1]).toBe(spaces[1]);
    const cachedSchema = queryClient.getQueryData<SpaceSchema>(
      dataKeys.schema(SPACE),
    );
    expect(cachedSchema?.space).toEqual(returned);
    expect(cachedSchema?.objectTypes).toBe(schema.objectTypes);
    // The snapshots handed to the cache were not mutated.
    expect(spaces[0].access).toEqual({ scope: "private", grants: [] });
    expect(schema.space.access).toEqual({ scope: "private", grants: [] });
    for (const key of [dataKeys.spaces(), dataKeys.schema(SPACE)]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("leaves the caches alone and surfaces the error when the grant is invalid", async () => {
    const { client, queryClient, wrapper } = await investorSetup();
    const spaces = await client.listSpaces();
    queryClient.setQueryData(dataKeys.spaces(), spaces);
    const hook = renderHook(() => useUpdateSpaceAccess(), { wrapper });
    let caught: unknown = null;
    await act(async () => {
      try {
        await hook.result.current.mutateAsync({
          spaceId: SPACE,
          access: {
            scope: "shared",
            grants: [{ bot: "Not A Slug", level: "read" }],
          },
        });
      } catch (error: unknown) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(DataValidationError);
    expect(queryClient.getQueryData(dataKeys.spaces())).toBe(spaces);
    expect(queryClient.getQueryState(dataKeys.spaces())?.isInvalidated).toBe(
      false,
    );
  });
});

describe("record and delete mutations", () => {
  it("createRecord seeds the record cache and invalidates the table, schema, and spaces", async () => {
    const { queryClient, wrapper, schema, investor, query } =
      await investorSetup();
    queryClient.setQueryData(dataKeys.schema(SPACE), schema);
    queryClient.setQueryData(dataKeys.spaces(), []);
    queryClient.setQueryData(dataKeys.recordPage(SPACE, query), {
      records: [],
      total: 0,
    });
    const hook = renderHook(() => useCreateRecord(SPACE), { wrapper });
    let created: DataRecord | null = null;
    await act(async () => {
      created = await hook.result.current.mutateAsync({
        typeId: investor.id,
        values: { name: "New Angel", email: "angel@newangel.example" },
      });
    });
    const id = (created as DataRecord | null)?.id ?? "";
    expect(queryClient.getQueryData(dataKeys.record(SPACE, id))).toEqual(
      created,
    );
    for (const key of [
      dataKeys.schema(SPACE),
      dataKeys.spaces(),
      dataKeys.recordPage(SPACE, query),
    ]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("linkRecords writes the returned record and invalidates both sides", async () => {
    const { client, queryClient, wrapper, schema, query, firmQuery } =
      await investorSetup();
    queryClient.setQueryData(dataKeys.schema(SPACE), schema);
    const investors = await client.queryRecords(SPACE, {
      ...query,
      limit: 100,
    });
    const firms = await client.queryRecords(SPACE, firmQuery);
    const angel = investors.records.find(
      (record) => record.links.firm.length === 0,
    );
    if (!angel) throw new Error("fixture has no unlinked investor");
    queryClient.setQueryData(dataKeys.recordPage(SPACE, query), investors);
    queryClient.setQueryData(dataKeys.recordPage(SPACE, firmQuery), firms);
    queryClient.setQueryData(
      dataKeys.record(SPACE, firms.records[0].id),
      firms.records[0],
    );

    const hook = renderHook(() => useLinkRecords(SPACE), { wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync({
        recordId: angel.id,
        typeId: angel.typeId,
        attributeSlug: "firm",
        targetId: firms.records[0].id,
      });
    });
    const cached = queryClient.getQueryData<DataRecord>(
      dataKeys.record(SPACE, angel.id),
    );
    expect(cached?.links.firm.map((ref) => ref.id)).toEqual([
      firms.records[0].id,
    ]);
    expect(
      queryClient.getQueryState(dataKeys.record(SPACE, angel.id))
        ?.isInvalidated,
    ).toBe(false);
    for (const key of [
      dataKeys.recordPage(SPACE, query),
      dataKeys.recordPage(SPACE, firmQuery),
      dataKeys.record(SPACE, firms.records[0].id),
    ]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("preview reads only; execute invalidates everything cached for the space", async () => {
    const { queryClient, wrapper, schema, investor, query } =
      await investorSetup();
    queryClient.setQueryData(dataKeys.schema(SPACE), schema);
    queryClient.setQueryData(dataKeys.recordPage(SPACE, query), {
      records: [],
      total: 0,
    });
    const preview = renderHook(() => usePreviewDelete(SPACE), { wrapper });
    const execute = renderHook(() => useExecuteDelete(SPACE), { wrapper });
    let token = "";
    await act(async () => {
      const out = await preview.result.current.mutateAsync({
        kind: "object_type",
        ids: [investor.id],
      });
      token = out.token;
      expect(out.impact.records).toBe(investor.recordCount);
    });
    expect(
      queryClient.getQueryState(dataKeys.schema(SPACE))?.isInvalidated,
    ).toBe(false);
    await act(async () => {
      await execute.result.current.mutateAsync(token);
    });
    expect(
      queryClient.getQueryState(dataKeys.schema(SPACE))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(dataKeys.recordPage(SPACE, query))
        ?.isInvalidated,
    ).toBe(true);
  });
});
