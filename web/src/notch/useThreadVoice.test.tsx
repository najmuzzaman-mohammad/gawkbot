import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Message } from "../api/client";
import type { NativeMessage } from "./bridge";
import { useThreadVoice } from "./useThreadVoice";

type NotchHost = { webkit?: unknown };
let posted: NativeMessage[] = [];
const said = () =>
  posted
    .filter((m) => m.type === "say")
    .map((m) => (m as { text: string }).text);

const line = (id: string, from: string, content: string): Message =>
  ({
    id,
    from,
    channel: "ops__human",
    content,
    timestamp: "2026-10-15T09:00:00Z",
    tagged: [],
  }) as unknown as Message;

function Probe({
  lines,
  enabled,
  held,
}: {
  lines: Message[];
  enabled: boolean;
  held: boolean;
}) {
  useThreadVoice(lines, enabled, held);
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

describe("a bot talking back in its thread", () => {
  it("reads new lines of the bot's, not the backlog, not yours, not while you talk, not when off", () => {
    const first = [
      line("m1", "human", "move them"),
      line("m2", "ops", "On it."),
    ];
    const view = render(<Probe lines={[]} enabled={true} held={false} />);
    view.rerender(<Probe lines={first} enabled={true} held={false} />);
    expect(said()).toEqual([]);
    view.rerender(
      <Probe
        lines={[...first, line("m3", "ops", "Done: 14 files moved.")]}
        enabled={true}
        held={false}
      />,
    );
    expect(said()).toEqual(["Done: 14 files moved."]);
    view.rerender(
      <Probe
        lines={[
          ...first,
          line("m3", "ops", "Done: 14 files moved."),
          line("m4", "human", "thanks"),
        ]}
        enabled={true}
        held={false}
      />,
    );
    expect(said().length).toBe(1);
    const more = [
      ...first,
      line("m3", "ops", "Done: 14 files moved."),
      line("m4", "human", "thanks"),
      line("m5", "ops", "Any time."),
    ];
    view.rerender(<Probe lines={more} enabled={true} held={true} />);
    expect(said().length).toBe(1);
    view.rerender(
      <Probe
        lines={[...more, line("m6", "ops", "One more.")]}
        enabled={false}
        held={false}
      />,
    );
    expect(said().length).toBe(1);
  });
});
