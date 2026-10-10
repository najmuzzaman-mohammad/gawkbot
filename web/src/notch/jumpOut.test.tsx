import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUSY_OFFICE, QUIET_OFFICE } from "./fixtures";
import { NotchApp } from "./NotchApp";
import { STAGE_ARRIVE, STAGE_CHAT, STAGE_PEEK } from "./NotchStrip";
import { resetNudges } from "./nudge";
import type { NotchState } from "./types";

// The whole notch, fed by a broker whose answer the test controls, talking to
// a stand-in for the Mac app. Every way a bot leaves the notch to get noticed
// ends in a message to the Mac app: "attention" opens the notch by itself,
// and "stage" asks for room below it for a peek, a fly-in, or chatter. So
// each case is proven twice: it happens when the setting is on (or was never
// chosen), and it does not happen when the setting is off.

let served: NotchState = QUIET_OFFICE;

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  getNotchState: () => Promise.resolve(served),
}));

type Native = { type: string; height?: number };
type NotchHost = { webkit?: unknown };

let posted: Native[] = [];
const heights = () =>
  posted.filter((m) => m.type === "stage").map((m) => m.height);
const opened = () => posted.filter((m) => m.type === "attention").length;

const POLL = 2_100;
// Asks that have waited a long time: the notch trusts the broker's time to
// within a minute of when it first saw them, so the gang is bored (75
// seconds) a quarter of a minute after the notch opens.
const LONG_WAITING: NotchState = {
  ...BUSY_OFFICE,
  attention: BUSY_OFFICE.attention.map((a) => ({
    ...a,
    created_at: "2020-01-01T00:00:00Z",
  })),
};
const BORED_MS = 25_000;
// One second at a time: React only tells the Mac app about the stage when a
// step ends, so a peek that came and went inside one long step would be
// invisible here though a person would have seen it.
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, left));
    });
  }
}

async function mount(first: NotchState, search = "") {
  served = first;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NotchApp search={search} />
    </QueryClientProvider>,
  );
  await advance(POLL);
  // Start each case with nothing out and the five minute ration unspent, so
  // what the case sees is the setting and nothing else.
  await advance(4_000);
  resetNudges();
  posted = [];
}

const withSetting = (state: NotchState, jumpOut: boolean | undefined) =>
  jumpOut === undefined ? state : { ...state, jump_out: jumpOut };

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

describe.each([
  ["never chosen", undefined],
  ["on", true],
] as const)("bots jumping out of the notch, setting %s", (_name, setting) => {
  it("opens the notch by itself and flies the asker in on a new question", async () => {
    await mount(withSetting(QUIET_OFFICE, setting));
    served = withSetting(BUSY_OFFICE, setting);
    await advance(POLL);
    expect(opened()).toBe(1);
    expect(heights()).toContain(STAGE_ARRIVE);
  });

  it("lets waiting bots chat once they are bored", async () => {
    await mount(withSetting(LONG_WAITING, setting));
    await advance(BORED_MS);
    expect(heights()).toContain(STAGE_CHAT);
  });

  it("lets a bot peek out now and then", async () => {
    await mount(withSetting(QUIET_OFFICE, setting), "?peek=1");
    await advance(5_000);
    expect(heights()).toContain(STAGE_PEEK);
  });
});

describe("bots jumping out of the notch, setting off", () => {
  it("does not open the notch or fly anyone in on a new question", async () => {
    await mount(withSetting(QUIET_OFFICE, false));
    served = withSetting(BUSY_OFFICE, false);
    await advance(POLL);
    expect(opened()).toBe(0);
    expect(heights()).not.toContain(STAGE_ARRIVE);
  });

  it("keeps bored bots from chatting", async () => {
    await mount(withSetting(LONG_WAITING, false));
    await advance(BORED_MS);
    expect(heights()).not.toContain(STAGE_CHAT);
  });

  it("keeps bots from peeking", async () => {
    await mount(withSetting(QUIET_OFFICE, false), "?peek=1");
    await advance(30_000);
    expect(heights()).not.toContain(STAGE_PEEK);
  });

  it("stops within one poll of being turned off, and resumes when turned on", async () => {
    await mount(QUIET_OFFICE, "?peek=1");
    await advance(5_000);
    expect(heights()).toContain(STAGE_PEEK);

    served = withSetting(QUIET_OFFICE, false);
    await advance(POLL + 4_000); // the poll, then any peek already out goes in
    posted = [];
    resetNudges(); // the five minute ration is not what keeps them in
    await advance(20_000);
    expect(heights()).not.toContain(STAGE_PEEK);

    served = withSetting(QUIET_OFFICE, true);
    resetNudges();
    await advance(POLL + 5_000);
    expect(heights()).toContain(STAGE_PEEK);
  });
});
