import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { gang } from "./antics";
import { BUSY_OFFICE, MACBOOK_NOTCH, NO_NOTCH, QUIET_OFFICE } from "./fixtures";
import { DOT_BAND, dotsThatFit, stripShapeFor } from "./NotchStrip";
import { NotchView, type NotchViewProps } from "./NotchView";
import { byNeed } from "./order";
import type { NotchState } from "./types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function notchProps(overrides: Partial<NotchViewProps> = {}): NotchViewProps {
  return {
    state: BUSY_OFFICE,
    geometry: MACBOOK_NOTCH,
    expanded: false,
    mode: "home",
    screen: { kind: "suggestions" },
    gang: gang(BUSY_OFFICE.attention, BUSY_OFFICE.agents),
    boredom: 0,
    now: Date.parse("2026-10-12T12:00:00Z"),
    selectedId: "req-1",
    answering: new Set(),
    composer: null,
    sending: false,
    error: null,
    voiceAvailable: true,
    onPick: vi.fn(),
    onExpand: vi.fn(),
    onPeekHeight: vi.fn(),
    onBack: vi.fn(),
    onSettings: vi.fn(),
    onNewBot: vi.fn(),
    onNewBotSubmit: vi.fn(),
    onOpenFull: vi.fn(),
    onStop: vi.fn(),
    onShowSource: vi.fn(),
    onCompose: vi.fn(),
    onSelect: vi.fn(),
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSend: vi.fn(),
    onOpen: vi.fn(),
    onComposerText: vi.fn(),
    onComposerSubmit: vi.fn(),
    onComposerCancel: vi.fn(),
    onVoice: vi.fn(),
    onKeyboard: vi.fn(),
    ...overrides,
  };
}

function withQuery(ui: ReactElement) {
  return (
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
  );
}

function renderNotch(overrides: Partial<NotchViewProps> = {}) {
  const props = notchProps(overrides);
  render(withQuery(<NotchView {...props} />));
  return props;
}

function renderNotchWith(overrides: Partial<NotchViewProps>) {
  const props = notchProps(overrides);
  return render(withQuery(<NotchView {...props} />));
}

describe("collapsed notch", () => {
  it("is exactly the notch plus two compact ears", () => {
    renderNotch();
    const shell = screen.getByTestId("notch-shell");
    // Compact ears that hug the notch, not 72 points over the menu bar.
    expect(shell.style.width).toBe(`${186 + 2 * 40}px`);
    expect(shell.style.height).toBe("32px");
  });

  it("shows every state as a centred row of dots: red, green, orange, latest first", () => {
    const at = (min: number) =>
      new Date(Date.now() - min * 60_000).toISOString();
    const state: NotchState = {
      ...QUIET_OFFICE,
      attention: [],
      finished: [
        { id: "finished:c@1", kind: "finished", from: "c", question: "done" },
        {
          id: "finished:cc-1@1",
          kind: "finished",
          from: "cc-1",
          question: "ok",
        },
      ],
      agents: [
        { slug: "a", name: "A", mood: "working", updated_at: at(9) },
        { slug: "b", name: "B", mood: "error", updated_at: at(5) },
        {
          slug: "cos",
          name: "Chief of Staff",
          mood: "working",
          is_lead: true,
          updated_at: at(1),
        },
        {
          slug: "c",
          name: "C",
          mood: "idle",
          state: "your_turn",
          updated_at: at(8),
        },
        { slug: "q", name: "Q", mood: "needs_you", updated_at: at(2) },
        { slug: "e", name: "E", mood: "idle" },
        // Marked done: its turn is over and nobody is waiting, so no dot.
        {
          slug: "d",
          name: "D",
          mood: "idle",
          state: "your_turn",
          updated_at: at(1),
        },
        {
          slug: "cc-1",
          name: "S",
          mood: "idle",
          kind: "session",
          state: "your_turn",
          updated_at: at(3),
        },
      ],
    };
    const finished = new Set(["c", "cc-1"]);
    const shape = stripShapeFor(MACBOOK_NOTCH, finished, state.agents);
    expect(shape).toEqual({ earWidth: 0, band: DOT_BAND });
    renderNotchWith({
      geometry: { ...MACBOOK_NOTCH, ...shape },
      state,
      gang: [],
    });
    const shell = screen.getByTestId("notch-shell");
    // No wider than the notch; a thin band under it.
    expect(shell.style.width).toBe("186px");
    expect(shell.style.height).toBe(`${32 + DOT_BAND}px`);
    expect(document.querySelector(".notch-strip .notch-bot")).toBeNull();
    const row = Array.from(
      screen.getByTestId("notch-dots").querySelectorAll("[data-mood]"),
    );
    expect(row.map((el) => el.getAttribute("aria-label"))).toEqual([
      "Q: needs your answer",
      "B: stuck",
      "S: finished, your turn",
      "C: finished, your turn",
      "Chief of Staff: working",
      "A: working",
    ]);
    expect(row.map((el) => el.className)).toEqual([
      "ndot ndot-needs_you",
      "ndot ndot-error",
      "ndot ndot-done",
      "ndot ndot-done",
      "ndot ndot-working",
      "ndot ndot-working",
    ]);
  });

  it("draws a question red, stuck as a red ring, a finished turn green", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/notch/notch.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.ndot-needs_you\s*\{\s*background: var\(--mood-error\);/,
    );
    expect(css).toMatch(
      /\.ndot-error\s*\{\s*background: transparent;\s*box-shadow: inset 0 0 0 1\.5px var\(--mood-error\);/,
    );
    expect(css).toMatch(/\.ndot-done\s*\{\s*background: var\(--mood-done\);/);
  });

  it("orders the agent list the same way, bots and sessions together", () => {
    const at = (min: number) =>
      new Date(Date.now() - min * 60_000).toISOString();
    const order = byNeed(
      [
        { slug: "idle", name: "I", mood: "idle", updated_at: at(0) },
        { slug: "w-old", name: "W1", mood: "working", updated_at: at(20) },
        { slug: "w-new", name: "W2", mood: "working", updated_at: at(1) },
        {
          slug: "turn",
          name: "T",
          mood: "idle",
          kind: "session",
          updated_at: at(4),
        },
        { slug: "ask", name: "A", mood: "needs_you", updated_at: at(30) },
      ],
      new Set(["turn"]),
    ).map((a) => a.slug);
    expect(order).toEqual(["ask", "turn", "w-new", "w-old", "idle"]);
  });

  it("draws work as a pulsing orange dot, with no spinner left in the notch", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/notch/notch.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.ndot-working\s*\{\s*background: var\(--dot-working\);/,
    );
    expect(css).toMatch(/--dot-working: #ff9f0a;/);
    expect(css).toMatch(/\.ndot-working\s*\{\s*animation: ndot-pulse/);
    expect(css).not.toMatch(/rotate\(360deg\)/);
    expect(css).not.toMatch(/ndot-spin/);
  });

  it("fits as many dots as the notch is wide", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      slug: `b${i}`,
      name: `B${i}`,
      mood: "working" as const,
    }));
    const state: NotchState = { ...QUIET_OFFICE, attention: [], agents: many };
    const shape = stripShapeFor(MACBOOK_NOTCH, new Set(), many);
    renderNotchWith({
      geometry: { ...MACBOOK_NOTCH, ...shape },
      state,
      gang: [],
    });
    expect(
      screen.getByTestId("notch-dots").querySelectorAll("[data-mood]"),
    ).toHaveLength(dotsThatFit(186));
    expect(dotsThatFit(186)).toBe(17);
  });

  it("sizes the strip to what is going on", () => {
    const idle = [{ slug: "x", name: "X", mood: "idle" as const }];
    const working = [{ slug: "x", name: "X", mood: "working" as const }];
    const none = new Set<string>();
    expect(stripShapeFor(MACBOOK_NOTCH, none, idle)).toEqual({
      earWidth: 0,
      band: 0,
    });
    expect(stripShapeFor(MACBOOK_NOTCH, none, working)).toEqual({
      earWidth: 0,
      band: DOT_BAND,
    });
    // Something that needs the human is a dot too, never faces beside the notch.
    const asking = [{ slug: "x", name: "X", mood: "needs_you" as const }];
    expect(stripShapeFor(MACBOOK_NOTCH, none, asking)).toEqual({
      earWidth: 0,
      band: DOT_BAND,
    });
    expect(stripShapeFor(MACBOOK_NOTCH, new Set(["x"]), idle)).toEqual({
      earWidth: 0,
      band: DOT_BAND,
    });
    expect(stripShapeFor(NO_NOTCH, none, working)).toEqual({
      earWidth: NO_NOTCH.earWidth,
      band: 0,
    });
  });

  it("is exactly the notch, nothing beside it, when it has no ears", () => {
    renderNotchWith({
      geometry: { ...MACBOOK_NOTCH, earWidth: 0 },
      state: QUIET_OFFICE,
      gang: [],
    });
    const shell = screen.getByTestId("notch-shell");
    expect(shell.style.width).toBe("186px");
    expect(shell.style.height).toBe("32px");
    // Nothing is drawn: the notch itself has no pixels to draw in.
    expect(document.querySelector(".notch-strip .notch-bot")).toBeNull();
  });

  it("piles everyone who needs you onto the notch, with a count", () => {
    renderNotch();
    expect(screen.getByTestId("notch-gang").children).toHaveLength(2);
    expect(
      screen.getByRole("img", { name: "Gemini CLI needs you" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("2 need you")).toBeInTheDocument();
  });

  it("puts the lead to sleep in a mask when nothing is going on", () => {
    const quiet = {
      ...QUIET_OFFICE,
      mood: "idle" as const,
      attention: [],
      agents: QUIET_OFFICE.agents.map((a) => ({ ...a, mood: "idle" as const })),
    };
    const { unmount } = renderNotchWith({ state: quiet, gang: [] });
    expect(
      screen.getByRole("img", { name: /asleep, nothing needs you/ }),
    ).toHaveClass("nb-tucked");
    expect(document.querySelector(".nb-mask")).not.toBeNull();
    // A mask is enough; there is no blanket.
    expect(document.querySelector(".nb-blanket")).toBeNull();
    unmount();
    // The human opens the notch (hovering in opens it): it wakes up.
    const open = renderNotchWith({ state: quiet, gang: [], expanded: true });
    expect(document.querySelector(".nb-mask")).toBeNull();
    expect(document.querySelector(".notch-strip .nb-awake")).not.toBeNull();
    expect(document.querySelector(".notch-strip .nb-tucked")).toBeNull();
    open.unmount();
    // Someone working, or anything waiting on the human: it is up.
    renderNotch();
    expect(document.querySelector(".nb-mask")).toBeNull();
  });

  it("renders as a pill on Macs without a notch", () => {
    renderNotch({ geometry: NO_NOTCH, state: QUIET_OFFICE, gang: [] });
    expect(screen.getByTestId("notch-shell").style.width).toBe("128px");
    expect(screen.queryByLabelText(/need you/)).not.toBeInTheDocument();
  });
});
