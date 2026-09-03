import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestAppBuild, submitAppEdit } from "./apps";

// Mock the HTTP layer so we can assert the edit goes through the broker's
// explicit improve endpoint (which drives the task_followup wake) and NOT a new
// "Improve app" task.
const post = vi.fn();
vi.mock("./client", () => ({
  get: vi.fn(),
  del: vi.fn(),
  postMessage: vi.fn(),
  post: (path: string, body: unknown) => post(path, body),
}));

describe("submitAppEdit", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("posts the change to the app's improve endpoint and returns the edit channel", async () => {
    post.mockResolvedValue({ channel: "task-office-7" });

    const channel = await submitAppEdit("app_abc", "add a CSV export button");

    expect(post).toHaveBeenCalledWith("/apps/app_abc/improve", {
      change: "add a CSV export button",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(channel).toBe("task-office-7");
  });
});

describe("requestAppBuild", () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ task: { id: "office-1" } });
  });

  // Regression: this sent the literal "general". Once the shared room was
  // retired the broker's create path could not find that channel and the
  // whole Edit App flow died with "channel not found". The task must be
  // addressed to the bot that will do the work.
  it("addresses the build task to the Chief of Staff's DM, never a shared room", async () => {
    await requestAppBuild({ name: "Pipeline", description: "a board" });

    const body = post.mock.calls[0][1] as { channel: string; owner: string };
    expect(body.channel).toBe("ceo__human");
    expect(body.owner).toBe("ceo");
  });

  it("uses the same DM when improving an existing app", async () => {
    await requestAppBuild({
      name: "Pipeline",
      description: "add CSV export",
      appId: "app_abc",
    });

    const body = post.mock.calls[0][1] as { channel: string; title: string };
    expect(body.channel).toBe("ceo__human");
    expect(body.title).toBe("Improve app: Pipeline");
  });
});
