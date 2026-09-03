import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeMember } from "../../api/client";
import { useAppStore } from "../../stores/app";

// Mock the data hooks BEFORE importing BotList so the module under test
// picks up the mocked module bindings.
vi.mock("../../hooks/useMembers", () => ({
  useOfficeMembers: vi.fn(),
  useOfficeMembersMeta: vi.fn(),
  useChannelMembers: vi.fn(),
}));

vi.mock("../../hooks/useFirstRunNudge", () => ({
  useFirstRunNudge: vi.fn(),
}));

vi.mock("../../hooks/useOverflow", () => ({
  useOverflow: () => ({ current: null }),
}));

vi.mock("../../hooks/useConfig", () => ({
  useDefaultHarness: () => "claude-code",
}));

vi.mock("../../routes/useCurrentRoute", () => ({
  useCurrentRoute: () => ({ kind: "unknown" }),
}));

vi.mock("../bots/BotWizard", () => ({
  BotWizard: () => null,
  useBotWizard: () => ({ open: false, show: () => {}, hide: () => {} }),
}));

vi.mock("../ui/PixelAvatar", () => ({
  // Surfaces the `working` prop so the "only the working bot animates"
  // contract is observable without a canvas.
  PixelAvatar: ({ slug, working }: { slug: string; working?: boolean }) => (
    <span
      data-testid={`avatar-${slug}`}
      data-working={working ? "true" : "false"}
    />
  ),
}));

vi.mock("../ui/HarnessBadge", () => ({
  HarnessBadge: () => null,
}));

// BotEventPeek renders into document.body via createPortal and pulls in
// timers — stub it out for BotList's integration tests so we focus on
// the chevron + row wiring contract here. BotEventPeek has its own
// dedicated test file.
vi.mock("./BotEventPeek", () => ({
  BotEventPeek: () => null,
}));

// v3-mvp: BotList row click navigates to /bots/$botSlug via the
// TanStack Router rather than the legacy zustand setActiveBotSlug. Mock
// the router so the navigation contract is observable in unit tests.
vi.mock("../../lib/router", () => ({
  router: { navigate: vi.fn() },
}));

// Mock useBotEventPeek so the per-row peek state is deterministic. We
// flip `isOpen` in tests by tracking calls to `toggle` via the mock
// implementation rather than going through the real Zustand store.
vi.mock("../../hooks/useBotEventPeek", () => {
  const peekState = {
    isOpen: false,
    current: undefined,
    history: [],
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    hoverHandlers: { onMouseEnter: vi.fn(), onMouseLeave: vi.fn() },
    longPressHandlers: {
      onTouchStart: vi.fn(),
      onTouchEnd: vi.fn(),
      onTouchCancel: vi.fn(),
      onTouchMove: vi.fn(),
    },
  };
  return {
    useBotEventPeek: vi.fn(() => peekState),
    usePeekIsOpen: vi.fn(() => false),
  };
});

import { useBotEventPeek } from "../../hooks/useBotEventPeek";
import { useFirstRunNudge } from "../../hooks/useFirstRunNudge";
import { useOfficeMembers } from "../../hooks/useMembers";
import { router } from "../../lib/router";
import { BotList } from "./BotList";

const useOfficeMembersMock = vi.mocked(useOfficeMembers);
const useFirstRunNudgeMock = vi.mocked(useFirstRunNudge);
const useBotEventPeekMock = vi.mocked(useBotEventPeek);

function setMembers(members: OfficeMember[]) {
  useOfficeMembersMock.mockReturnValue({
    data: members,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useOfficeMembers>);
}

function defaultPeekState(
  overrides: Partial<ReturnType<typeof useBotEventPeek>> = {},
) {
  return {
    isOpen: false,
    current: undefined,
    history: [],
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    hoverHandlers: { onMouseEnter: vi.fn(), onMouseLeave: vi.fn() },
    longPressHandlers: {
      onTouchStart: vi.fn(),
      onTouchEnd: vi.fn(),
      onTouchCancel: vi.fn(),
      onTouchMove: vi.fn(),
    },
    ...overrides,
  } as unknown as ReturnType<typeof useBotEventPeek>;
}

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BotList />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useFirstRunNudgeMock.mockReturnValue({ showNudge: false });
  useBotEventPeekMock.mockImplementation(() => defaultPeekState());
  useAppStore.setState({ botActivitySnapshots: {}, computerStates: {} });
});

afterEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ botActivitySnapshots: {}, computerStates: {} });
});

describe("<AgentList>", () => {
  it("renders all bot rows when snapshots are present", () => {
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
      { slug: "ava", name: "Ava", role: "designer", task: "moving pixels" },
    ]);

    useAppStore.setState({
      botActivitySnapshots: {
        tess: {
          slug: "tess",
          activity: "drafting reply",
          kind: "routine",
          receivedAtMs: Date.now() - 5000,
          haloUntilMs: Date.now() - 4400,
        },
        ava: {
          slug: "ava",
          activity: "tweaking spacing",
          kind: "routine",
          receivedAtMs: Date.now() - 5000,
          haloUntilMs: Date.now() - 4400,
        },
      },
    });

    const { container } = renderList();
    const rows = container.querySelectorAll(".sidebar-bot-row");
    expect(rows.length).toBe(2);

    const pills = container.querySelectorAll(".sidebar-bot-pill");
    expect(pills.length).toBe(2);
    expect(pills[0].textContent).toBe("drafting reply");
    expect(pills[1].textContent).toBe("tweaking spacing");
  });

  it("REGRESSION: renders rows correctly with zero SSE snapshots, falling back to member.task", () => {
    // No SSE deployment OR initial paint before first activity event.
    // Pill must NOT render empty — it falls back to the task seed.
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
    ]);

    const { container } = renderList();

    const pill = container.querySelector(".sidebar-bot-pill");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("watching tests");
    // Idle data-state because no snapshot — but with visible fallback text.
    expect(pill?.getAttribute("data-state")).toBe("idle");
  });

  it("renders Office-voice idle copy when no SSE snapshot AND no member.task", () => {
    // Tutorial 3 acceptance: rail must render Office voice immediately, never
    // a blank pill.
    setMembers([{ slug: "devon", name: "Devon", role: "engineer" }]);

    const { container } = renderList();

    const pill = container.querySelector(".sidebar-bot-pill");
    expect(pill).not.toBeNull();
    expect(pill?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("starts the shared 1Hz scheduler exactly once per BotList mount", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
      { slug: "ava", name: "Ava", role: "designer", task: "moving pixels" },
      { slug: "sam", name: "Sam", role: "pm", task: "combing Linear" },
    ]);

    renderList();

    // ONE setInterval for the whole rail — not one per row. This is the
    // explicit C2 contract from eng review (per-bot timers would fan out
    // into a CPU drag at 10+ bots).
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: scheduler clears its interval on BotList unmount (no timer leak)", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
    ]);

    const { unmount } = renderList();
    unmount();

    // Without the cleanup, the interval keeps ticking after BotList is
    // gone (dev hot-reload, route changes, multi-tab) — the eng review
    // flagged this as the CRITICAL test gap to backfill.
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("renders the first-run nudge under the FIRST bot row only when showNudge=true", () => {
    useFirstRunNudgeMock.mockReturnValue({ showNudge: true });
    setMembers([
      {
        slug: "devon",
        name: "Devon",
        role: "engineer",
        task: "watching tests",
      },
      { slug: "lila", name: "Lila", role: "designer", task: "moving pixels" },
    ]);

    const { container } = renderList();

    const nudges = container.querySelectorAll(
      '[data-testid="first-run-nudge"]',
    );
    expect(nudges.length).toBe(1);
    expect(nudges[0].textContent).toBe("→ open a DM with @devon");

    // Confirm the nudge is anchored to the first row, not the second.
    const [firstRow] = container.querySelectorAll(".sidebar-bot-row");
    const [firstNudge] = nudges;
    expect(firstRow.contains(firstNudge)).toBe(true);
  });

  it("does NOT render the nudge when showNudge=false", () => {
    useFirstRunNudgeMock.mockReturnValue({ showNudge: false });
    setMembers([
      {
        slug: "devon",
        name: "Devon",
        role: "engineer",
        task: "watching tests",
      },
    ]);

    const { container } = renderList();
    expect(
      container.querySelectorAll('[data-testid="first-run-nudge"]').length,
    ).toBe(0);
  });

  // ─── Tier 2 chevron / peek wiring ────────────────────────────────────────

  it("renders a peek chevron for every bot row, collapsed by default", () => {
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
      { slug: "ava", name: "Ava", role: "designer", task: "moving pixels" },
    ]);

    const { container } = renderList();
    const triggers = container.querySelectorAll(".sidebar-bot-peek-trigger");
    expect(triggers.length).toBe(2);
    for (const t of triggers) {
      expect(t.getAttribute("aria-expanded")).toBe("false");
      expect(t.getAttribute("aria-haspopup")).toBe("dialog");
    }
  });

  it("REGRESSION: button[data-bot-slug] still resolves to the row button (NOT the chevron)", () => {
    // The e2e harness selects rows via `button[data-bot-slug]`. The
    // chevron is a sibling button without that attribute; it uses
    // data-testid instead.
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
    ]);

    const { container } = renderList();

    const slugButtons = container.querySelectorAll("button[data-bot-slug]");
    expect(slugButtons.length).toBe(1);
    expect(slugButtons[0].classList.contains("sidebar-agent")).toBe(true);

    const chevron = container.querySelector(
      '[data-testid="peek-trigger-tess"]',
    );
    expect(chevron).not.toBeNull();
    expect(chevron?.hasAttribute("data-bot-slug")).toBe(false);
  });

  it("clicking the row (Tier 3 escalation) closes any open peek before navigating", () => {
    // Plan §Disclosure tiers: "Quick activation always wins; the long-press
    // threshold is what differentiates peek from navigate." If peek is open
    // when the user taps the row, the workspace should be the only surface
    // visible after the tap — close the peek as part of escalation.
    // v3-mvp: navigation now goes through router.navigate({ to:
    // "/bots/$botSlug", ... }) instead of the legacy
    // setActiveBotSlug store setter.
    const close = vi.fn();
    const navigate = vi.mocked(router.navigate);
    navigate.mockClear();
    useBotEventPeekMock.mockImplementation(() =>
      defaultPeekState({ isOpen: true, close }),
    );

    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
    ]);

    const { container } = renderList();
    const row = container.querySelector(
      'button[data-bot-slug="tess"]',
    ) as HTMLButtonElement;
    expect(row).not.toBeNull();
    fireEvent.click(row);

    expect(close).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      to: "/agents/$agentSlug",
      params: { agentSlug: "tess" },
    });
  });

  it("clicking the chevron does NOT navigate to the bot subspace (e.stopPropagation)", () => {
    // v3-mvp: row click navigates via router.navigate; the chevron must
    // stopPropagation so the peek toggle doesn't double as a navigation.
    const navigate = vi.mocked(router.navigate);
    navigate.mockClear();

    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
    ]);

    const { container } = renderList();
    const chevron = container.querySelector(
      '[data-testid="peek-trigger-tess"]',
    );
    expect(chevron).not.toBeNull();
    fireEvent.click(chevron as Element);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("clicking the chevron calls peek.toggle and flips aria-expanded to true on the next render", () => {
    const toggle = vi.fn();
    let isOpen = false;
    useBotEventPeekMock.mockImplementation(() => defaultPeekState({ isOpen }));

    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", task: "watching tests" },
    ]);

    const { container, rerender } = renderList();
    const chevron = container.querySelector(
      '[data-testid="peek-trigger-tess"]',
    );
    expect(chevron?.getAttribute("aria-expanded")).toBe("false");

    // Rewire mock so the click handler calls our spy AND so the next
    // render reflects the open state.
    useBotEventPeekMock.mockImplementation(() => {
      const state = defaultPeekState({ isOpen });
      (state as unknown as { toggle: () => void }).toggle = () => {
        toggle();
        isOpen = true;
      };
      return state;
    });

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BotList />
      </QueryClientProvider>,
    );
    const chevron2 = container.querySelector(
      '[data-testid="peek-trigger-tess"]',
    );
    fireEvent.click(chevron2 as Element);
    expect(toggle).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BotList />
      </QueryClientProvider>,
    );
    const chevron3 = container.querySelector(
      '[data-testid="peek-trigger-tess"]',
    );
    expect(chevron3?.getAttribute("aria-expanded")).toBe("true");
  });

  // ─── presence badge ──────────────────────────────────────────────────────
  it("renders the online badge on rows whose member has online=true", () => {
    setMembers([
      {
        slug: "tess",
        name: "Tess",
        role: "engineer",
        online: true,
        last_seen_at: "2026-05-07T00:00:00Z",
      },
      {
        slug: "ava",
        name: "Ava",
        role: "designer",
        online: false,
        last_seen_at: "2026-05-06T22:00:00Z",
      },
      // Built-in member without an adapter session — no presence record at all.
      // The badge must not render and the absence of an "offline" marker is
      // intentional: not-connected and never-connected are the same shape on
      // the avatar, only differentiated inside the peek card.
      { slug: "devon", name: "Devon", role: "engineer" },
    ]);

    const { container } = renderList();
    expect(
      container.querySelector('[data-testid="online-badge-tess"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="online-badge-ava"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="online-badge-devon"]'),
    ).toBeNull();
  });
});

// Split from the block above so neither describe runs long. These cover one
// concern: the working / merely-online distinction and what animates.
describe("<BotList> presence and activity", () => {
  // ─── working vs merely online ────────────────────────────────────────────
  // These two states used to render the same green dot, so "connected" looked
  // exactly like "doing something". They must now be visually distinct, and
  // the avatar must only carry one of them.
  it("shows the working badge, not the online badge, for a bot that is processing", () => {
    setMembers([
      {
        slug: "tess",
        name: "Tess",
        role: "engineer",
        online: true,
        status: "active",
        task: "writing code",
      },
    ]);

    const { container } = renderList();
    expect(
      container.querySelector('[data-testid="working-badge-tess"]'),
    ).not.toBeNull();
    // Critically: NOT both. Two dots on one avatar reinstates the ambiguity.
    expect(
      container.querySelector('[data-testid="online-badge-tess"]'),
    ).toBeNull();
  });

  it("shows the online badge for a bot that is reachable but idle", () => {
    setMembers([
      {
        slug: "ava",
        name: "Ava",
        role: "designer",
        online: true,
        status: "idle",
      },
    ]);

    const { container } = renderList();
    expect(
      container.querySelector('[data-testid="online-badge-ava"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="working-badge-ava"]'),
    ).toBeNull();
  });

  it("animates only the working bot's avatar", () => {
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", status: "active" },
      { slug: "ava", name: "Ava", role: "designer", online: true },
      { slug: "devon", name: "Devon", role: "engineer", status: "idle" },
    ]);

    const { container } = renderList();
    expect(
      container
        .querySelector('[data-testid="avatar-tess"]')
        ?.getAttribute("data-working"),
    ).toBe("true");
    for (const slug of ["ava", "devon"]) {
      expect(
        container
          .querySelector(`[data-testid="avatar-${slug}"]`)
          ?.getAttribute("data-working"),
        `${slug} must not animate`,
      ).toBe("false");
    }
  });

  it("leaves the row status dot unanimated so the eyes carry the motion", () => {
    setMembers([
      { slug: "tess", name: "Tess", role: "engineer", status: "active" },
    ]);

    const { container } = renderList();
    const dot = container.querySelector(".status-dot");
    expect(dot?.className).toContain("active");
    // A pulsing dot beside animating eyes is two clocks for one fact.
    expect(dot?.className).not.toContain("pulse");
  });
});

describe("<BotList> on-its-computer glyph", () => {
  function seedComputer(slug: string, state: string) {
    useAppStore.getState().recordComputerEvent({ slug, state });
  }

  it("shows the monitor glyph only when the computer is ready AND the bot is working", () => {
    setMembers([
      { slug: "growth", name: "Growth", role: "growth", status: "active" },
      { slug: "ceo", name: "CEO", role: "lead", status: "idle" },
      { slug: "ops", name: "Ops", role: "ops", status: "active" },
    ]);
    seedComputer("growth", "ready");
    seedComputer("ceo", "ready");
    seedComputer("ops", "asleep");

    const { queryByTestId } = renderList();

    expect(queryByTestId("computer-glyph-growth")).not.toBeNull();
    // Ready but idle: nothing to watch.
    expect(queryByTestId("computer-glyph-ceo")).toBeNull();
    // Working but the desktop is asleep: no computer to watch.
    expect(queryByTestId("computer-glyph-ops")).toBeNull();
  });

  it("renders no glyph when the store has never heard of the bot's computer", () => {
    setMembers([
      { slug: "growth", name: "Growth", role: "growth", status: "active" },
    ]);
    const { queryByTestId } = renderList();
    expect(queryByTestId("computer-glyph-growth")).toBeNull();
  });
});
