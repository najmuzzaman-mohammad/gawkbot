import { describe, expect, it } from "vitest";

import { validateOpenUIApp } from "./OpenUIAppRenderer";

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
