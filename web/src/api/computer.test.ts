import { afterEach, describe, expect, it, vi } from "vitest";

import * as client from "./client";
import {
  computerAction,
  computerControl,
  computerExec,
  computerJoin,
  computerScreenshot,
  getComputer,
  getComputerRuntime,
  normalizeComputerStatus,
  parseComputerEvent,
  prepareComputerRuntime,
  updateMemberComputer,
} from "./computer";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computer api", () => {
  it("normalises the runtime wire shape to camelCase", async () => {
    vi.spyOn(client, "get").mockResolvedValue({
      available: true,
      runtime: "docker",
      daemon_up: true,
      image: false,
      image_ref: "gawkbot/computer:1",
      driver_version: "0.20.0",
      building: false,
      install_hint: "Install OrbStack and open it once.",
      runtime_start_hint: "",
      problem: "",
    });

    const runtime = await getComputerRuntime();

    expect(client.get).toHaveBeenCalledWith("/computer/runtime");
    expect(runtime).toEqual({
      available: true,
      runtime: "docker",
      daemonUp: true,
      image: false,
      imageRef: "gawkbot/computer:1",
      driverVersion: "0.20.0",
      building: false,
      installHint: "Install OrbStack and open it once.",
      runtimeStartHint: "",
      problem: "",
    });
  });

  it("posts an empty body to prepare the shared image", async () => {
    const postSpy = vi
      .spyOn(client, "post")
      .mockResolvedValue({ building: true });

    await expect(prepareComputerRuntime()).resolves.toEqual({ building: true });
    expect(postSpy).toHaveBeenCalledWith("/computer/runtime/prepare", {});
  });

  it("fetches and normalises a per-bot status", async () => {
    vi.spyOn(client, "get").mockResolvedValue({
      slug: "growth",
      destination: "sandbox",
      cloud_backend: "box",
      state: "ready",
      problem: null,
      busy: true,
      viewer_url: "/computer-view/growth/view/1/sig/vnc.html",
      control: { held: false, help_reason: "Xero wants a login" },
      last_frame: { data_url: "data:image/jpeg;base64,AAA", at: 1725 },
      container_name: "gawkbot-computer-abc",
      workspace_dir: "/home/you/.gawkbot/computers/abc",
      box: null,
    });

    const status = await getComputer("growth");

    expect(client.get).toHaveBeenCalledWith("/computer/growth");
    expect(status.state).toBe("ready");
    expect(status.viewerUrl).toBe("/computer-view/growth/view/1/sig/vnc.html");
    expect(status.control).toEqual({
      held: false,
      helpReason: "Xero wants a login",
    });
    expect(status.lastFrame).toEqual({
      dataUrl: "data:image/jpeg;base64,AAA",
      at: 1725,
    });
    expect(status.containerName).toBe("gawkbot-computer-abc");
    expect(status.box).toBeNull();
  });

  it("encodes the slug in the path", async () => {
    vi.spyOn(client, "get").mockResolvedValue({ state: "off" });
    await getComputer("chief of staff");
    expect(client.get).toHaveBeenCalledWith("/computer/chief%20of%20staff");
  });

  it("maps an unknown state to error instead of inventing one", () => {
    const status = normalizeComputerStatus({ slug: "x", state: "teleporting" });
    expect(status.state).toBe("error");
    expect(status.destination).toBe("off");
  });

  it("posts lifecycle actions to their own routes", async () => {
    const postSpy = vi
      .spyOn(client, "post")
      .mockResolvedValue({ slug: "growth", state: "asleep" });

    const status = await computerAction("growth", "sleep");

    expect(postSpy).toHaveBeenCalledWith("/computer/growth/sleep", {});
    expect(status.state).toBe("asleep");
  });

  it("returns the screenshot data URL", async () => {
    vi.spyOn(client, "post").mockResolvedValue({
      image: "data:image/png;base64,B",
    });
    await expect(computerScreenshot("growth")).resolves.toEqual({
      image: "data:image/png;base64,B",
    });
    expect(client.post).toHaveBeenCalledWith("/computer/growth/screenshot", {});
  });

  it("runs a console command and normalises the result", async () => {
    vi.spyOn(client, "post").mockResolvedValue({
      exit_code: 1,
      stdout: "",
      stderr: "ls: cannot access",
    });

    const result = await computerExec("growth", "ls /nope");

    expect(client.post).toHaveBeenCalledWith("/computer/growth/exec", {
      command: "ls /nope",
    });
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ls: cannot access",
    });
  });

  it("joins for the control-policy viewer", async () => {
    vi.spyOn(client, "post").mockResolvedValue({
      viewer_url: "/computer-view/growth/control/9/sig/vnc.html",
    });
    await expect(computerJoin("growth")).resolves.toEqual({
      viewerUrl: "/computer-view/growth/control/9/sig/vnc.html",
    });
    expect(client.post).toHaveBeenCalledWith("/computer/growth/join", {});
  });

  it("sends control actions and reads back the hold", async () => {
    vi.spyOn(client, "post").mockResolvedValue({
      held: true,
      help_reason: null,
    });
    await expect(computerControl("growth", "take")).resolves.toEqual({
      held: true,
      helpReason: null,
    });
    expect(client.post).toHaveBeenCalledWith("/computer/growth/control", {
      action: "take",
    });
  });

  it("updates where the bot's computer runs through office-members", async () => {
    vi.spyOn(client, "post").mockResolvedValue({});
    await updateMemberComputer("growth", "cloud");
    expect(client.post).toHaveBeenCalledWith("/office-members", {
      action: "update",
      slug: "growth",
      computer: "cloud",
    });
  });

  it("parses computer SSE payloads and rejects malformed ones", () => {
    expect(
      parseComputerEvent(
        JSON.stringify({ slug: "growth", state: "ready", frame: "data:x" }),
      ),
    ).toEqual({ slug: "growth", state: "ready", frame: "data:x" });
    expect(parseComputerEvent("{not-json")).toBeNull();
    expect(parseComputerEvent(JSON.stringify({ state: "ready" }))).toBeNull();
    expect(
      parseComputerEvent(JSON.stringify({ slug: "", state: "building" })),
    ).toEqual({ slug: "", state: "building" });
  });
});
