import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QUIET_OFFICE } from "./fixtures";
import { NotchApp } from "./NotchApp";
import { resetNudges } from "./nudge";
import type { NotchState, OverlayScene } from "./types";

let served: NotchState = QUIET_OFFICE;

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  getNotchState: () => Promise.resolve(served),
}));

type Native = { type: string; scene?: OverlayScene | null };
type NotchHost = { webkit?: unknown };

let posted: Native[] = [];
const POLL = 2_100;

async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, left));
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetNudges();
  posted = [];
  (window as unknown as NotchHost).webkit = {
    messageHandlers: {
      gawkNotch: { postMessage: (m: Native) => posted.push(m) },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as NotchHost).webkit;
});

describe("drawings left for the screen", () => {
  it("are handed to the app once per sequence, and a null scene clears", async () => {
    served = QUIET_OFFICE;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <NotchApp search="" />
      </QueryClientProvider>,
    );
    await advance(POLL);
    expect(posted.filter((m) => m.type === "overlay")).toHaveLength(0);
    const scene: OverlayScene = {
      id: "point",
      ttl_ms: 4000,
      items: [{ kind: "pointer", x: 735, y: 478, label: "here" }],
    };
    served = { ...QUIET_OFFICE, overlay: { seq: 1, scene } };
    await advance(POLL);
    await advance(POLL);
    const drawn = posted.filter((m) => m.type === "overlay");
    expect(drawn).toHaveLength(1);
    expect(drawn[0].scene).toEqual(scene);
    served = { ...QUIET_OFFICE, overlay: { seq: 2, scene: null } };
    await advance(POLL);
    expect(posted.filter((m) => m.type === "overlay").at(-1)?.scene).toBeNull();
  });
});
