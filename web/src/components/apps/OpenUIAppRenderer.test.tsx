import { afterEach, describe, expect, it, vi } from "vitest";

import * as client from "../../api/client";
import {
  createOpenUIAppToolProvider,
  openUIHumanActor,
  openUIRendererKey,
  readArrayEnvelope,
  validateOpenUIApp,
} from "./OpenUIAppRenderer";

afterEach(() => vi.restoreAllMocks());

it("remounts the runtime for different same-length OpenUI sources", () => {
  expect(openUIRendererKey("app_1", 'root = App("A", [])')).not.toBe(
    openUIRendererKey("app_1", 'root = App("B", [])'),
  );
});

describe("openUIHumanActor", () => {
  it("uses the host identity and namespaces invited humans", () => {
    expect(openUIHumanActor({ human: { slug: "human" } })).toBe("human");
    expect(openUIHumanActor({ human: { human_slug: "mira" } })).toBe(
      "human:mira",
    );
  });

  it("fails closed when the session has no usable identity", () => {
    expect(() => openUIHumanActor({ human: {} })).toThrow(
      "Could not resolve the signed-in human identity",
    );
  });
});

it("uses the signed-in human identity for task visibility", async () => {
  const getSpy = vi
    .spyOn(client, "get")
    .mockResolvedValueOnce({ human: { human_slug: "mira" } })
    .mockResolvedValueOnce({ tasks: [{ id: "OFFICE-1" }] });
  const provider = createOpenUIAppToolProvider("app_1");

  await expect(provider.wuphf_list_tasks()).resolves.toEqual([
    { id: "OFFICE-1" },
  ]);
  expect(getSpy).toHaveBeenNthCalledWith(2, "/tasks", {
    all_channels: true,
    include_done: true,
    viewer_slug: "human:mira",
  });
});

describe("readArrayEnvelope", () => {
  it("unwraps broker list responses and fails closed for malformed data", () => {
    const tasks = [{ id: "OFFICE-1" }];
    expect(readArrayEnvelope({ tasks }, "tasks")).toEqual(tasks);
    expect(readArrayEnvelope({ tasks: null }, "tasks")).toEqual([]);
    expect(readArrayEnvelope([], "tasks")).toEqual([]);
    expect(readArrayEnvelope(null, "tasks")).toEqual([]);
  });
});

describe("validateOpenUIApp", () => {
  it("accepts a static app from the executable library", () => {
    const result = validateOpenUIApp(`root = App("Task desk", [
  Heading("Today", "2"),
  Callout("Choose a task to get started.", "info")
])`);
    expect(result.ok).toBe(true);
  });

  it("accepts an allowed query and explicit mutation action", () => {
    const result = validateOpenUIApp(`root = App("Task desk", [
  Button("Create task", @Run(createTask), "info")
])
tasks = Query("wuphf_list_tasks", {}, [])
createTask = Mutation("wuphf_create_task", {"title": "Follow up"})`);
    expect(result.ok).toBe(true);
  });

  it("rejects dynamic or unapproved tools and host actions", () => {
    expect(
      validateOpenUIApp(`root = App("Bad", [Text("bad")])
name = "wuphf_list_tasks"
tasks = Query(name, {}, [])`).ok,
    ).toBe(false);
    expect(
      validateOpenUIApp(
        `root = App("Bad", [Button("Go", @OpenUrl("https://example.com"))])`,
      ).ok,
    ).toBe(false);
    expect(
      validateOpenUIApp(`root = App("Bad", [Text("bad")])
data = Query("read_local_files", {}, [])`).ok,
    ).toBe(false);
  });

  it("rejects mount-time and unbound mutations", () => {
    const result = validateOpenUIApp(`root = App("Bad", [Text("bad")])
danger = Mutation("wuphf_app_db_clear", {"table": "items"})`);
    expect(result).toEqual({ ok: false, code: "openui_unbound_mutation" });
  });

  it("rejects aggressive query refresh", () => {
    const result = validateOpenUIApp(`root = App("Bad", [Text("bad")])
tasks = Query("wuphf_list_tasks", {}, [], 1)`);
    expect(result).toEqual({ ok: false, code: "openui_refresh_budget" });
  });
});
