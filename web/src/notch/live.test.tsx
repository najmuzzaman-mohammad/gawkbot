import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOTCH_QUERY_KEY } from "./api";
import {
  LIVE_DEBOUNCE_MS,
  POLL_LIVE_MS,
  POLL_MS,
  pollInterval,
  useNotchLive,
} from "./live";
import { THREAD_QUERY_PREFIX } from "./NotchThread";

// A stand-in EventSource the test drives by hand.
class FakeSource extends EventTarget {
  static last: FakeSource | null = null;
  readyState = 0;
  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;
  url: string;
  closed = false;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSource.last = this;
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  says(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

let liveNow = false;
function Probe({ client }: { client: QueryClient }) {
  liveNow = useNotchLive(client);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
  FakeSource.last = null;
  liveNow = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  (globalThis as { EventSource?: unknown }).EventSource = undefined;
});

describe("the live notch", () => {
  it("refetches once for a burst of events, and knows when it is connected", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(<Probe client={client} />);
    const source = FakeSource.last;
    expect(source).not.toBeNull();
    expect(liveNow).toBe(false);
    await act(async () => {
      source?.says("ready");
    });
    expect(liveNow).toBe(true);
    await act(async () => {
      source?.says("message");
      source?.says("action");
      source?.says("activity");
      await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS + 5);
    });
    // One refetch of the state and one of the open thread, not one per event.
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: NOTCH_QUERY_KEY });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [THREAD_QUERY_PREFIX],
    });
    await act(async () => {
      source?.says("wiki:write");
      await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS + 5);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    await act(async () => {
      source?.says("error");
    });
    expect(liveNow).toBe(false);
  });

  it("leaves the stream when it unmounts", () => {
    const view = render(<Probe client={new QueryClient()} />);
    view.unmount();
    expect(FakeSource.last?.closed).toBe(true);
  });

  it("polls fast while open or offline, rarely while closed and live", () => {
    expect(pollInterval(true, true)).toBe(POLL_MS);
    expect(pollInterval(false, false)).toBe(POLL_MS);
    expect(pollInterval(false, true)).toBe(POLL_LIVE_MS);
  });
});
