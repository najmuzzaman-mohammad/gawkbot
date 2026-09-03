import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  directChannelSlug,
  MAX_AGENT_HISTORY,
  MAX_COMPUTER_BUILD_LINES,
  selectBotPeek,
  selectPillState,
  useAppStore,
} from "./app";

afterEach(() => {
  useAppStore.setState({
    activeThread: null,
    lastMessageId: null,
    clearedMessageIdsByChannel: {},
    unreadByChannel: {},
    activeBotSlug: null,
    lastConversationalChannel: null,
    searchOpen: false,
    composerSearchInitialQuery: "",
    pendingComposerDraft: null,
    composerHelpOpen: false,
    onboardingComplete: false,
    botActivitySnapshots: {},
    botActivityHistory: {},
    isReconnecting: false,
    computerStates: {},
    computerRuntimeBuild: { building: false, problem: null, lines: [] },
  });
});

describe("DM channel helpers", () => {
  it("uses the broker canonical direct slug for both ordering directions", () => {
    // Lower lexicographic side comes first; this is what the broker
    // expects on /dm endpoints and what useBrokerEvents matches against
    // when suppressing unread for the active DM.
    expect(directChannelSlug("ceo")).toBe("ceo__human");
    expect(directChannelSlug("pm")).toBe("human__pm");
  });

  it("resets non-route session state for a shred flow", () => {
    useAppStore.setState({
      activeThread: { id: "thread-1", channelSlug: "engineering" },
      lastMessageId: "msg-1",
      clearedMessageIdsByChannel: { general: "msg-0" },
      activeBotSlug: "ceo",
      lastConversationalChannel: "engineering",
      searchOpen: true,
      composerSearchInitialQuery: "stuck task",
      composerHelpOpen: true,
      onboardingComplete: true,
    });

    useAppStore.getState().resetForOnboarding();

    expect(useAppStore.getState()).toMatchObject({
      activeThread: null,
      lastMessageId: null,
      clearedMessageIdsByChannel: {},
      activeBotSlug: null,
      lastConversationalChannel: null,
      searchOpen: false,
      composerSearchInitialQuery: "",
      composerHelpOpen: false,
      onboardingComplete: false,
    });
  });
});

describe("channel unread state", () => {
  it("increments and clears unread counts by channel", () => {
    useAppStore.getState().incrementUnread("launch");
    useAppStore.getState().incrementUnread("launch");
    useAppStore.getState().incrementUnread("general");

    expect(useAppStore.getState().unreadByChannel).toMatchObject({
      launch: 2,
      general: 1,
    });

    useAppStore.getState().clearUnread("launch");

    expect(useAppStore.getState().unreadByChannel.launch).toBe(0);
    expect(useAppStore.getState().unreadByChannel.general).toBe(1);
  });
});

describe("channel clear markers", () => {
  it("stores and removes clear markers by normalized channel", () => {
    useAppStore.getState().setChannelClearMarker(" launch ", " msg-2 ");

    expect(useAppStore.getState().clearedMessageIdsByChannel).toMatchObject({
      launch: "msg-2",
    });

    useAppStore.getState().setChannelClearMarker("launch", null);

    expect(useAppStore.getState().clearedMessageIdsByChannel.launch).toBe(
      undefined,
    );
  });

  it("ignores an empty channel instead of filing it under #general", () => {
    // This map is keyed BY channel. An empty slug has no channel to key on,
    // and the old fallback filed it under "general" -- silently attributing a
    // clear marker to a room the message never came from, and once #general is
    // retired, to a room that does not exist.
    useAppStore.getState().setChannelClearMarker("", "msg-orphan");
    useAppStore.getState().setChannelClearMarker("   ", "msg-orphan-2");

    expect(useAppStore.getState().clearedMessageIdsByChannel.general).toBe(
      undefined,
    );
    expect(useAppStore.getState().clearedMessageIdsByChannel[""]).toBe(
      undefined,
    );
  });
});

describe("recordActivitySnapshot", () => {
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    let t = 1_700_000_000_000;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t);
    // Each call advances the clock by 1s so successive snapshots have
    // distinct receivedAtMs / haloUntilMs values that the test can assert.
    nowSpy.mockImplementation(() => {
      const v = t;
      t += 1000;
      return v;
    });
  });

  afterEach(() => {
    nowSpy?.mockRestore();
  });

  it("stores the snapshot, stamps receivedAtMs, and sets haloUntilMs forward by ~600ms", () => {
    useAppStore.getState().recordActivitySnapshot({
      slug: "tess",
      activity: "drafting reply",
      kind: "routine",
    });

    const snap = useAppStore.getState().botActivitySnapshots.tess;
    expect(snap.activity).toBe("drafting reply");
    expect(snap.kind).toBe("routine");
    expect(snap.haloUntilMs - snap.receivedAtMs).toBe(600);
  });

  it("bumps haloUntilMs on each routine event so the halo reblooms", () => {
    useAppStore
      .getState()
      .recordActivitySnapshot({ slug: "tess", kind: "routine" });
    const first = useAppStore.getState().botActivitySnapshots.tess.haloUntilMs;

    useAppStore
      .getState()
      .recordActivitySnapshot({ slug: "tess", kind: "routine" });
    const second = useAppStore.getState().botActivitySnapshots.tess.haloUntilMs;

    expect(second).toBeGreaterThan(first);
  });

  it("does NOT bump haloUntilMs on stuck snapshots — stuck must not visually read as alive", () => {
    useAppStore
      .getState()
      .recordActivitySnapshot({ slug: "rita", kind: "routine" });
    const beforeStuck =
      useAppStore.getState().botActivitySnapshots.rita.haloUntilMs;

    useAppStore.getState().recordActivitySnapshot({
      slug: "rita",
      kind: "stuck",
      activity: "stuck on terraform lock",
    });

    const afterStuck = useAppStore.getState().botActivitySnapshots.rita;
    expect(afterStuck.haloUntilMs).toBe(beforeStuck);
    expect(afterStuck.kind).toBe("stuck");
    expect(afterStuck.activity).toBe("stuck on terraform lock");
  });

  it("ignores snapshots with an empty or missing slug", () => {
    useAppStore.getState().recordActivitySnapshot({
      slug: "",
      activity: "noise",
    });
    expect(useAppStore.getState().botActivitySnapshots).toEqual({});
  });

  it("first event for a slug leaves history empty (nothing displaced yet)", () => {
    useAppStore.getState().recordActivitySnapshot({
      slug: "tess",
      activity: "merging branch",
      kind: "routine",
    });

    expect(useAppStore.getState().botActivityHistory.tess ?? []).toEqual([]);
    expect(useAppStore.getState().botActivitySnapshots.tess.activity).toBe(
      "merging branch",
    );
  });

  it("each subsequent event prepends the displaced previous snapshot to history (newest-first)", () => {
    const store = useAppStore.getState();
    store.recordActivitySnapshot({ slug: "tess", activity: "first" });
    store.recordActivitySnapshot({ slug: "tess", activity: "second" });
    store.recordActivitySnapshot({ slug: "tess", activity: "third" });

    const history = useAppStore.getState().botActivityHistory.tess;
    expect(history.map((h) => h.activity)).toEqual(["second", "first"]);
    expect(useAppStore.getState().botActivitySnapshots.tess.activity).toBe(
      "third",
    );
  });

  it("caps history at MAX_AGENT_HISTORY entries (oldest evicted)", () => {
    const store = useAppStore.getState();
    // Fire MAX_AGENT_HISTORY + 3 events. After event N, the current is in
    // botActivitySnapshots and the previous N-1 sit in history capped at
    // MAX_AGENT_HISTORY.
    for (let i = 0; i < MAX_AGENT_HISTORY + 3; i += 1) {
      store.recordActivitySnapshot({
        slug: "ava",
        activity: `evt-${i}`,
        kind: "routine",
      });
    }

    const history = useAppStore.getState().botActivityHistory.ava;
    expect(history.length).toBe(MAX_AGENT_HISTORY);
    // Newest displaced is the most recent prior current — evt-(N-2) where
    // N = MAX_AGENT_HISTORY + 3 (the still-current value is evt-(N-1)).
    const expectedNewest = `evt-${MAX_AGENT_HISTORY + 1}`;
    expect(history[0].activity).toBe(expectedNewest);
    // Tail is the oldest survivor: total fired = MAX_AGENT_HISTORY + 3, the
    // current absorbs 1, so MAX_AGENT_HISTORY + 2 displaced events compete
    // for MAX_AGENT_HISTORY slots — oldest 2 fall off, leaving evt-2 at tail.
    expect(history[history.length - 1].activity).toBe("evt-2");
  });

  it("history is per-slug and does not leak between bots", () => {
    const store = useAppStore.getState();
    store.recordActivitySnapshot({ slug: "tess", activity: "tess-1" });
    store.recordActivitySnapshot({ slug: "ava", activity: "ava-1" });
    store.recordActivitySnapshot({ slug: "tess", activity: "tess-2" });

    const tessHistory = useAppStore.getState().botActivityHistory.tess;
    const avaHistory = useAppStore.getState().botActivityHistory.ava ?? [];
    expect(tessHistory.map((h) => h.activity)).toEqual(["tess-1"]);
    expect(avaHistory).toEqual([]);
  });

  it("history records the full StoredActivitySnapshot (with receivedAtMs/haloUntilMs preserved)", () => {
    const store = useAppStore.getState();
    store.recordActivitySnapshot({ slug: "sam", activity: "first" });
    const firstStamped = useAppStore.getState().botActivitySnapshots.sam;
    store.recordActivitySnapshot({ slug: "sam", activity: "second" });

    const [displaced] = useAppStore.getState().botActivityHistory.sam;
    expect(displaced.activity).toBe("first");
    expect(displaced.receivedAtMs).toBe(firstStamped.receivedAtMs);
    expect(displaced.haloUntilMs).toBe(firstStamped.haloUntilMs);
  });
});

describe("selectAgentPeek", () => {
  it("returns undefined current and empty history for an unknown slug", () => {
    const result = selectBotPeek(
      { botActivitySnapshots: {}, botActivityHistory: {} },
      "ghost",
    );
    expect(result).toEqual({ current: undefined, history: [] });
  });

  it("returns the current snapshot plus its newest-first history", () => {
    const now = 1_700_000_000_000;
    const state = {
      botActivitySnapshots: {
        tess: {
          slug: "tess",
          activity: "now",
          receivedAtMs: now,
          haloUntilMs: now + 600,
        },
      },
      botActivityHistory: {
        tess: [
          {
            slug: "tess",
            activity: "prev",
            receivedAtMs: now - 1000,
            haloUntilMs: now - 400,
          },
        ],
      },
    };
    expect(selectBotPeek(state, "tess")).toEqual({
      current: state.botActivitySnapshots.tess,
      history: state.botActivityHistory.tess,
    });
  });
});

describe("selectPillState", () => {
  it("returns idle when no snapshot exists for the slug", () => {
    expect(
      selectPillState({ botActivitySnapshots: {} }, "ghost", Date.now()),
    ).toBe("idle");
  });

  it("returns stuck when the snapshot kind is stuck", () => {
    const now = 1_700_000_000_000;
    const state = {
      botActivitySnapshots: {
        rita: {
          slug: "rita",
          kind: "stuck" as const,
          receivedAtMs: now - 1000,
          haloUntilMs: now - 1000,
        },
      },
    };
    expect(selectPillState(state, "rita", now)).toBe("stuck");
  });
});

describe("setIsReconnecting", () => {
  it("only emits a state change when the value actually flips", () => {
    const sub = vi.fn();
    const unsub = useAppStore.subscribe(sub);
    try {
      useAppStore.getState().setIsReconnecting(false);
      expect(sub).not.toHaveBeenCalled();

      useAppStore.getState().setIsReconnecting(true);
      expect(sub).toHaveBeenCalledTimes(1);

      useAppStore.getState().setIsReconnecting(true);
      expect(sub).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });
});

describe("setTheme", () => {
  it("updates DOM + store even when localStorage.setItem throws", () => {
    // Simulates Safari private browsing / sandboxed-iframe (write-only block).
    // The previous setTheme threw uncaught here and broke the dark-mode
    // toggle entirely; the guard makes the DOM + store update succeed and
    // logs a breadcrumb instead.
    const setItemSpy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      useAppStore.getState().setTheme("nex-dark");

      expect(setItemSpy).toHaveBeenCalledWith("wuphf-theme", "nex-dark");
      expect(useAppStore.getState().theme).toBe("nex-dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe(
        "nex-dark",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("setTheme: localStorage.setItem failed"),
        expect.any(DOMException),
      );
    } finally {
      setItemSpy.mockRestore();
      warnSpy.mockRestore();
      // Reset DOM + store so other tests don't inherit dark theme.
      document.documentElement.setAttribute("data-theme", "nex");
      useAppStore.setState({ theme: "nex" });
    }
  });
});

describe("pendingComposerDraft (one-shot composer prefill)", () => {
  it("returns and clears the draft when the channel matches", () => {
    useAppStore
      .getState()
      .setPendingComposerDraft("ceo__human", "Build a Stripe webhook handler");

    // The first consume for the matching channel returns the seeded text.
    expect(
      useAppStore.getState().consumePendingComposerDraft("ceo__human"),
    ).toBe("Build a Stripe webhook handler");

    // It is one-shot: the store is cleared, so a second consume is null and
    // a later revisit to the same channel does not re-apply it.
    expect(useAppStore.getState().pendingComposerDraft).toBeNull();
    expect(
      useAppStore.getState().consumePendingComposerDraft("ceo__human"),
    ).toBeNull();
  });

  it("leaves the draft intact when a different channel consumes", () => {
    useAppStore
      .getState()
      .setPendingComposerDraft("ceo__human", "Draft for the CEO DM");

    // A mismatched channel must not steal another channel's draft.
    expect(
      useAppStore.getState().consumePendingComposerDraft("general"),
    ).toBeNull();
    expect(useAppStore.getState().pendingComposerDraft).toEqual({
      channel: "ceo__human",
      text: "Draft for the CEO DM",
    });

    // The intended channel still receives it.
    expect(
      useAppStore.getState().consumePendingComposerDraft("ceo__human"),
    ).toBe("Draft for the CEO DM");
  });
});

describe("recordComputerEvent", () => {
  it("records state, hold, and help reason for a slug", () => {
    useAppStore.getState().recordComputerEvent({
      slug: "growth",
      state: "ready",
      held: false,
      help_reason: "Xero wants a login",
    });

    expect(useAppStore.getState().computerStates.growth).toEqual({
      state: "ready",
      problem: null,
      frameDataUrl: null,
      frameAt: null,
      held: false,
      helpReason: "Xero wants a login",
    });
  });

  it("stores a live frame and stamps it with the event time", () => {
    useAppStore.getState().recordComputerEvent({
      slug: "growth",
      state: "ready",
      frame: "data:image/jpeg;base64,AAA",
      at: 1000,
    });

    const live = useAppStore.getState().computerStates.growth;
    expect(live.frameDataUrl).toBe("data:image/jpeg;base64,AAA");
    expect(live.frameAt).toBe(1000);
  });

  it("never rewinds to an older frame (poll last_frame vs live SSE frame)", () => {
    const store = useAppStore.getState();
    store.recordComputerEvent({
      slug: "growth",
      state: "ready",
      frame: "data:newer",
      at: 2000,
    });
    store.recordComputerEvent({
      slug: "growth",
      state: "ready",
      frame: "data:older",
      at: 1000,
    });

    expect(useAppStore.getState().computerStates.growth.frameDataUrl).toBe(
      "data:newer",
    );
    expect(useAppStore.getState().computerStates.growth.frameAt).toBe(2000);
  });

  it("keeps the previous frame and hold when a state-only event arrives", () => {
    const store = useAppStore.getState();
    store.recordComputerEvent({
      slug: "growth",
      state: "ready",
      frame: "data:x",
      at: 5,
      held: true,
    });
    store.recordComputerEvent({ slug: "growth", state: "asleep" });

    const live = useAppStore.getState().computerStates.growth;
    expect(live.state).toBe("asleep");
    expect(live.frameDataUrl).toBe("data:x");
    expect(live.held).toBe(true);
  });

  it("clears the help reason when the event carries null", () => {
    const store = useAppStore.getState();
    store.recordComputerEvent({
      slug: "growth",
      state: "ready",
      help_reason: "needs a login",
    });
    store.recordComputerEvent({
      slug: "growth",
      state: "ready",
      help_reason: null,
    });
    expect(useAppStore.getState().computerStates.growth.helpReason).toBeNull();
  });

  it("keeps slugs independent", () => {
    const store = useAppStore.getState();
    store.recordComputerEvent({ slug: "growth", state: "ready" });
    store.recordComputerEvent({ slug: "ceo", state: "off" });
    expect(useAppStore.getState().computerStates.growth.state).toBe("ready");
    expect(useAppStore.getState().computerStates.ceo.state).toBe("off");
  });

  it("routes slug-less events to the runtime build log", () => {
    const store = useAppStore.getState();
    store.recordComputerEvent({
      slug: "",
      state: "building",
      message: "Pulling trycua/xfce-cua",
    });
    store.recordComputerEvent({
      slug: "",
      state: "building",
      message: "Installing cua-driver 0.20.0",
    });

    expect(useAppStore.getState().computerRuntimeBuild).toEqual({
      building: true,
      problem: null,
      lines: ["Pulling trycua/xfce-cua", "Installing cua-driver 0.20.0"],
    });
    expect(useAppStore.getState().computerStates).toEqual({});
  });

  it("marks the build finished and keeps the problem when it fails", () => {
    const store = useAppStore.getState();
    store.recordComputerEvent({
      slug: "",
      state: "building",
      message: "step 1",
    });
    store.recordComputerEvent({
      slug: "",
      state: "error",
      problem: "docker build exited 1",
    });

    expect(useAppStore.getState().computerRuntimeBuild).toMatchObject({
      building: false,
      problem: "docker build exited 1",
    });
  });

  it("caps the build log at MAX_COMPUTER_BUILD_LINES", () => {
    const store = useAppStore.getState();
    for (let i = 0; i < MAX_COMPUTER_BUILD_LINES + 5; i += 1) {
      store.recordComputerEvent({
        slug: "",
        state: "building",
        message: `line ${i}`,
      });
    }
    const { lines } = useAppStore.getState().computerRuntimeBuild;
    expect(lines.length).toBe(MAX_COMPUTER_BUILD_LINES);
    expect(lines[lines.length - 1]).toBe(
      `line ${MAX_COMPUTER_BUILD_LINES + 4}`,
    );
  });
});
