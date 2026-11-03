import { describe, expect, it, vi } from "vitest";

import * as client from "../api/client";
import { answerRequest, notchStatePath, requestPermission } from "./api";
import * as bridge from "./bridge";

vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({})),
}));

describe("the state poll says when the panel is open", () => {
  it("adds open=1 only while expanded", () => {
    expect(notchStatePath(false)).toBe("/notch/state");
    expect(notchStatePath(true)).toBe("/notch/state?open=1");
  });
});

describe("asking for a macOS grant", () => {
  it("goes to the app itself inside the Mac app, whichever process serves the office", async () => {
    vi.spyOn(bridge, "isInMacApp").mockReturnValue(true);
    const native = vi
      .spyOn(bridge, "postNative")
      .mockImplementation(() => undefined);
    await requestPermission("accessibility");
    expect(native).toHaveBeenCalledWith({
      type: "permission",
      kind: "accessibility",
    });
    expect(client.post).not.toHaveBeenCalled();
  });
  it("asks the broker outside the app", async () => {
    vi.spyOn(bridge, "isInMacApp").mockReturnValue(false);
    await requestPermission("screen_recording");
    expect(client.post).toHaveBeenCalledWith("/notch/permissions/request", {
      kind: "screen_recording",
    });
  });
});

describe("answering a bot that wants this Mac", () => {
  it("goes to the computer's control, not the inbox", async () => {
    await answerRequest("consent:ops", "allow");
    expect(client.post).toHaveBeenCalledWith("/computer/ops/control", {
      action: "allow",
    });
    await answerRequest("req-1", "yes");
    expect(client.post).toHaveBeenCalledWith("/requests/answer", {
      id: "req-1",
      choice_id: "yes",
    });
  });
});
