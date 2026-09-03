/**
 * Channel resolution across the three chat write surfaces.
 *
 * All three carried the same expression — `channel ?? routeChannel ??
 * "general"` — which is two bugs at once: `??` is NULLISH so an empty string
 * passed through, and the tail invented #general for a surface that has no
 * conversation home. Composer posts messages, MessageBubble posts reactions,
 * ThreadPanel posts replies, so each one was a silent write into the room the
 * one-room removal retires: the human sees their message appear locally and
 * never learns it went nowhere.
 *
 * MessageFeed's own resolution is covered in MessageFeed.test.tsx.
 */

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "../../api/client";
import { useAppStore } from "../../stores/app";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

const postMessage = vi.hoisted(() => vi.fn());
const toggleReaction = vi.hoisted(() => vi.fn());
const useChannelSlug = vi.hoisted(() => vi.fn());
const showNotice = vi.hoisted(() => vi.fn());

vi.mock("../../routes/useCurrentRoute", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../routes/useCurrentRoute")>();
  return { ...actual, useChannelSlug, useCurrentTaskId: () => null };
});

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    postMessage,
    toggleReaction,
    getMessages: vi.fn(() => Promise.resolve({ messages: [] })),
    getOfficeMembers: vi.fn(() => Promise.resolve({ members: [], meta: {} })),
    getMembers: vi.fn(() => Promise.resolve({ members: [] })),
    getConfig: vi.fn(() => Promise.resolve({})),
  };
});

vi.mock("../ui/Toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/Toast")>();
  return { ...actual, showNotice };
});

function Wrap({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const MESSAGE: Message = {
  id: "msg-1",
  from: "pm",
  channel: "eng",
  content: "hello",
  timestamp: "2026-08-23T12:00:00Z",
  reactions: [{ emoji: "👍", count: 1, reacted: false }],
} as Message;

describe("<Composer> channel resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChannelSlug.mockReturnValue(null);
    useAppStore.setState({ pendingComposerDraft: null });
  });

  it("refuses to mount a live composer with no channel", () => {
    render(
      <Wrap>
        <Composer />
      </Wrap>,
    );

    expect(screen.getByTestId("composer-no-channel")).toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("treats an EMPTY STRING channel as no channel", () => {
    // The nullish bug exactly: "" is not null, so it used to pass through and
    // the composer posted into #general.
    render(
      <Wrap>
        <Composer channel="" />
      </Wrap>,
    );

    expect(screen.getByTestId("composer-no-channel")).toBeInTheDocument();
  });

  it("treats a whitespace-only channel as no channel", () => {
    render(
      <Wrap>
        <Composer channel="   " />
      </Wrap>,
    );

    expect(screen.getByTestId("composer-no-channel")).toBeInTheDocument();
  });

  it("never names #general in the no-channel state", () => {
    render(
      <Wrap>
        <Composer />
      </Wrap>,
    );

    const panel = screen.getByTestId("composer-no-channel");
    expect(panel.textContent ?? "").not.toMatch(/general/i);
  });

  // The positive control — a real channel mounts the real composer — lives in
  // Composer.test.tsx, which already carries the mocks that heavy mount needs.
  // Mounting ChannelComposer from this file hangs the vitest worker, the same
  // polling/SSE teardown problem that had TaskDocument.test.tsx skipped.
});

describe("<MessageBubble> reaction channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChannelSlug.mockReturnValue(null);
    toggleReaction.mockResolvedValue(undefined);
  });

  it("reacts on the MESSAGE's own channel, not #general", () => {
    // No channel prop and no route channel — the old fallback sent the
    // reaction to #general. TaskChannelChat's doc comment records this
    // actually happening on the task-detail chat.
    render(
      <Wrap>
        <MessageBubble message={MESSAGE} />
      </Wrap>,
    );

    fireEvent.click(screen.getByText("👍"));

    expect(toggleReaction).toHaveBeenCalledWith("msg-1", "👍", "eng");
  });

  it("prefers an explicit channel prop over the message's own", () => {
    render(
      <Wrap>
        <MessageBubble message={MESSAGE} channel="design" />
      </Wrap>,
    );

    fireEvent.click(screen.getByText("👍"));

    expect(toggleReaction).toHaveBeenCalledWith("msg-1", "👍", "design");
  });

  it("refuses to react when there is no channel anywhere", () => {
    render(
      <Wrap>
        <MessageBubble message={{ ...MESSAGE, channel: "" }} />
      </Wrap>,
    );

    fireEvent.click(screen.getByText("👍"));

    expect(toggleReaction).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalled();
    expect(String(showNotice.mock.calls[0][0])).not.toMatch(/general/i);
  });
});

// ── MessageBubble card dispatch ────────────────────────────────────────
//
// teachflow's consult_relay marker is a sixth card early-return in
// MessageBubble, and it only works if it sits ABOVE the author/avatar
// rendering — otherwise a consult falls through to the normal bubble path and
// renders as an empty authorless bubble. Their own tests cover the marker
// component in isolation; nothing covered the dispatch, so a mis-placed hunk
// would have been invisible. This pins the placement.
describe("<MessageBubble> consult_relay dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChannelSlug.mockReturnValue(null);
  });

  // Payload shape per ConsultRelayMarker's own contract: {direction, bot,
  // channel}. The marker renders null without `bot`, so getting this wrong
  // looks identical to a mis-placed hunk — which is how this test earned its
  // keep on the first run.
  const CONSULT: Message = {
    id: "msg-consult-1",
    from: "ceo",
    channel: "eng",
    content: "",
    kind: "consult_relay",
    timestamp: "2026-08-23T12:00:00Z",
    payload: { direction: "sent", agent: "designer", channel: "ceo__designer" },
  } as unknown as Message;

  it("renders the marker, not a bubble", () => {
    render(
      <Wrap>
        <MessageBubble message={CONSULT} />
      </Wrap>,
    );

    expect(screen.getByTestId("consult-relay-marker")).toBeInTheDocument();
  });

  it("returns before any author or avatar is rendered", () => {
    // The placement requirement: above the isSyntheticSender path. "ceo" is
    // not on the stubbed roster, so a fall-through would render the synthetic
    // -sender bubble shell around it.
    const { container } = render(
      <Wrap>
        <MessageBubble message={CONSULT} />
      </Wrap>,
    );

    expect(container.querySelector(".message-row")).toBeNull();
    expect(container.querySelector(".message-author")).toBeNull();
  });
});
