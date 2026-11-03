import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NativeMessage } from "./bridge";
import { BUSY_OFFICE, QUIET_OFFICE } from "./fixtures";
import type { NotchState } from "./types";
import { useAnnounce } from "./useAnnounce";

type NotchHost = { webkit?: unknown };
let posted: NativeMessage[] = [];
const said = () => posted.filter((m) => m.type === "say");

function Probe({ state, held }: { state: NotchState | null; held: boolean }) {
  useAnnounce(state, held);
  return null;
}

beforeEach(() => {
  posted = [];
  (window as unknown as NotchHost).webkit = {
    messageHandlers: {
      gawkNotch: { postMessage: (m: NativeMessage) => posted.push(m) },
    },
  };
});
afterEach(() => {
  cleanup();
  (window as unknown as NotchHost).webkit = undefined;
});

describe("speaking up as the office changes", () => {
  it("says new cards once, not the backlog, not while the talk key is held, not when off", () => {
    const view = render(<Probe state={QUIET_OFFICE} held={false} />);
    expect(said()).toEqual([]);
    view.rerender(<Probe state={BUSY_OFFICE} held={false} />);
    expect(said().length).toBe(1);
    view.rerender(<Probe state={{ ...BUSY_OFFICE }} held={false} />);
    expect(said().length).toBe(1);
    // Back to quiet, then busy again while the key is down: nothing, and
    // nothing afterwards either, because the cards are known by then.
    view.rerender(<Probe state={QUIET_OFFICE} held={true} />);
    view.rerender(<Probe state={BUSY_OFFICE} held={true} />);
    expect(said().length).toBe(1);
    view.rerender(<Probe state={BUSY_OFFICE} held={false} />);
    expect(said().length).toBe(1);
    // Off: silence for a new card.
    view.rerender(
      <Probe state={{ ...QUIET_OFFICE, announce: false }} held={false} />,
    );
    view.rerender(
      <Probe state={{ ...BUSY_OFFICE, announce: false }} held={false} />,
    );
    expect(said().length).toBe(1);
  });
});
