import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "./client";
import * as api from "./tasks";

describe("tasks api client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getOfficeTasks calls the all-channel tasks contract", async () => {
    const response: api.TaskListResponse = { tasks: [] };
    const getSpy = vi.spyOn(client, "get").mockResolvedValue(response);

    await expect(api.getOfficeTasks({ includeDone: true })).resolves.toEqual(
      response,
    );
    expect(getSpy).toHaveBeenCalledWith("/tasks", {
      viewer_slug: "human",
      all_channels: "true",
      include_done: "true",
    });
  });

  it("createTasks posts to task-plan with the human default actor", async () => {
    const response: api.CreateTasksResponse = { tasks: [] };
    const postSpy = vi.spyOn(client, "post").mockResolvedValue(response);

    await expect(
      api.createTasks([{ title: "Write contract", assignee: "pm" }]),
    ).resolves.toEqual(response);
    // No `channel`: the plan names no room, so the broker routes each task to
    // its own assignee's DM. It used to send "general", which is retired.
    expect(postSpy).toHaveBeenCalledWith("/task-plan", {
      created_by: "human",
      tasks: [{ title: "Write contract", assignee: "pm" }],
    });
  });

  it("createTasks forwards an optional provider", async () => {
    const response: api.CreateTasksResponse = { tasks: [] };
    const postSpy = vi.spyOn(client, "post").mockResolvedValue(response);

    await expect(
      api.createTasks([
        { title: "Write contract", assignee: "pm", provider: "codex" },
      ]),
    ).resolves.toEqual(response);
    expect(postSpy).toHaveBeenCalledWith("/task-plan", {
      created_by: "human",
      tasks: [{ title: "Write contract", assignee: "pm", provider: "codex" }],
    });
  });

  it("updateTaskStatus includes memory workflow override evidence", async () => {
    const response: api.TaskResponse = {
      task: { id: "task-1", title: "Write contract", status: "done" },
    };
    const postSpy = vi.spyOn(client, "post").mockResolvedValue(response);

    await expect(
      api.updateTaskStatus("task-1", "complete", "general", "human", {
        memoryWorkflowOverride: true,
        memoryWorkflowOverrideReason: "manual review complete",
      }),
    ).resolves.toEqual(response);
    expect(postSpy).toHaveBeenCalledWith("/tasks", {
      action: "complete",
      id: "task-1",
      channel: "general",
      created_by: "human",
      memory_workflow_override: true,
      memory_workflow_override_actor: "human",
      memory_workflow_override_reason: "manual review complete",
      override_reason: "manual review complete",
    });
  });

  it("listBotLogTasks calls bot-logs with a limit query", async () => {
    const response = { tasks: [] satisfies api.TaskLogSummary[] };
    const getSpy = vi.spyOn(client, "get").mockResolvedValue(response);

    await expect(api.listBotLogTasks({ limit: 25 })).resolves.toEqual(response);
    expect(getSpy).toHaveBeenCalledWith("/agent-logs", { limit: "25" });
  });
});

// ── Channel laundering ─────────────────────────────────────────────────
//
// `channel || "general"` in a request builder is the same bug as the UI's
// `?? "general"`: a task with no conversation home is not a task in #general,
// and asserting otherwise files work into the room the one-room removal
// retires. These pin that the client never invents one.

describe("tasks api — never invents a channel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("createSubTask omits the channel when the parent has none", async () => {
    const postSpy = vi
      .spyOn(client, "post")
      .mockResolvedValue({ task: { id: "t-1" } } as never);

    await api.createSubTask({
      parentTaskId: "DUNDE-72",
      title: "Child",
      channel: "",
    });

    const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("channel");
  });

  it("createSubTask treats a whitespace-only parent channel as none", async () => {
    const postSpy = vi
      .spyOn(client, "post")
      .mockResolvedValue({ task: { id: "t-1" } } as never);

    await api.createSubTask({
      parentTaskId: "DUNDE-72",
      title: "Child",
      channel: "   ",
    });

    const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("channel");
  });

  it("createSubTask still sends a real parent channel", async () => {
    const postSpy = vi
      .spyOn(client, "post")
      .mockResolvedValue({ task: { id: "t-1" } } as never);

    await api.createSubTask({
      parentTaskId: "DUNDE-72",
      title: "Child",
      channel: "eng",
    });

    const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(body.channel).toBe("eng");
  });

  it("editTaskFields omits the channel when the task has none", async () => {
    const postSpy = vi
      .spyOn(client, "post")
      .mockResolvedValue({ task: { id: "t-1" } } as never);

    await api.editTaskFields("DUNDE-72", { title: "T", details: "D" }, "");

    const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("channel");
    // The edit itself must still be intact.
    expect(body.action).toBe("edit");
    expect(body.title).toBe("T");
  });

  it("editTaskFields still sends a real channel", async () => {
    const postSpy = vi
      .spyOn(client, "post")
      .mockResolvedValue({ task: { id: "t-1" } } as never);

    await api.editTaskFields("DUNDE-72", { title: "T", details: "D" }, "eng");

    const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(body.channel).toBe("eng");
  });
});
