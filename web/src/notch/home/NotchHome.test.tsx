import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { gang } from "../antics";
import { FINISHED_OFFICE, HOME_OFFICE, MACBOOK_NOTCH } from "../fixtures";
import { NotchView, type NotchViewProps } from "../NotchView";
import type { NotchState } from "../types";
import { resolveHome, rowLine, sessionsOf, sidebarBots } from "./model";

vi.mock("../../api/client", async (original) => ({
  ...(await original<typeof import("../../api/client")>()),
  getMessages: () => Promise.resolve({ messages: [] }),
}));

afterEach(cleanup);

const NOW = Date.parse("2026-10-12T12:00:00Z");

function props(overrides: Partial<NotchViewProps> = {}): NotchViewProps {
  const state = overrides.state ?? HOME_OFFICE;
  return {
    state,
    geometry: MACBOOK_NOTCH,
    expanded: true,
    mode: "home",
    screen: { kind: "suggestions" },
    gang: gang(state?.attention ?? [], state?.agents ?? []),
    boredom: 0,
    now: NOW,
    selectedId: null,
    answering: new Set(),
    composer: null,
    sending: false,
    error: null,
    voiceAvailable: false,
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

function mount(overrides: Partial<NotchViewProps> = {}) {
  const p = props(overrides);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NotchView {...p} />
    </QueryClientProvider>,
  );
  return p;
}

describe("who the sidebar lists, and where Home opens", () => {
  it("puts the lead first, then whoever needs you, then work, and leaves sessions out", () => {
    expect(sidebarBots(HOME_OFFICE).map((a) => a.slug)).toEqual([
      "cos",
      "gemini",
      "codex",
      "designer",
      "scout",
      "hermes",
    ]);
    expect(sessionsOf(HOME_OFFICE).map((a) => a.slug)).toEqual([
      "cx-2",
      "cc-1",
    ]);
  });

  it("opens on the first bot with a question, else the ideas, else the lead", () => {
    expect(resolveHome(HOME_OFFICE)).toEqual({
      kind: "agent",
      slug: "gemini",
      name: "Gemini CLI",
      channel: "gemini__human",
    });
    const calm: NotchState = { ...HOME_OFFICE, attention: [] };
    expect(resolveHome(calm)).toEqual({ kind: "suggestions" });
    const empty: NotchState = {
      ...calm,
      ideas: { enabled: true, items: [] },
    };
    expect(resolveHome(empty)).toMatchObject({ kind: "agent", slug: "cos" });
  });

  it("says under each name what it waits on, does, or last said", () => {
    const by = (slug: string) =>
      HOME_OFFICE.agents.find((a) => a.slug === slug)!;
    expect(rowLine(by("gemini"), HOME_OFFICE)).toBe("Send the launch email?");
    expect(rowLine(by("designer"), HOME_OFFICE)).toBe("drafting response");
    expect(rowLine(by("scout"), HOME_OFFICE)).toBe(
      "Found three companies hiring a Head of RevOps.",
    );
  });
});

describe("Home", () => {
  it("is a sidebar of one Suggestions group, the bots, and one Sessions group", async () => {
    const p = mount();
    const side = screen.getByRole("navigation", { name: "Bots" });
    const suggestions = within(side).getByTestId("notch-row-suggestions");
    expect(suggestions).toHaveTextContent("Suggestions");
    expect(suggestions).toHaveTextContent("1");
    expect(within(side).getByTestId("notch-row-scout")).toHaveTextContent(
      "Found three companies",
    );
    expect(
      within(side).getByTestId("notch-row-scout").querySelector(".is-unread"),
    ).not.toBeNull();
    // The sessions are one row, never one row each.
    expect(within(side).queryByTestId("notch-row-cc-1")).toBeNull();
    expect(within(side).getByTestId("notch-row-sessions")).toHaveTextContent(
      "Sessions2",
    );
    await userEvent
      .setup()
      .click(within(side).getByTestId("notch-row-sessions"));
    expect(p.onPick).toHaveBeenCalledWith({ kind: "sessions" });
  });

  it("shows the suggestions as a carousel with the bot's ask", () => {
    mount();
    expect(
      screen.getByRole("heading", { name: "Suggested for you" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Want to bring me on as your release checker?"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Yes, make it and go" }),
    ).toBeInTheDocument();
  });

  it("lists the sessions in their own pane, each with its way back", async () => {
    const p = mount({ screen: { kind: "sessions" } });
    expect(screen.getByTestId("notch-session-cc-1")).toHaveTextContent(
      "Tests pass. Want me to merge it?",
    );
    await userEvent.setup().click(
      within(screen.getByTestId("notch-session-cc-1")).getByRole("button", {
        name: "Open in its window",
      }),
    );
    expect(p.onShowSource).toHaveBeenCalledWith("cc-1");
  });

  it("never makes a card of a finished turn", () => {
    mount({ state: FINISHED_OFFICE, screen: { kind: "suggestions" } });
    expect(screen.queryByText("Your turn")).toBeNull();
    expect(screen.queryByText("Add a test, then merge")).toBeNull();
  });

  it("asks the lead for a new bot", async () => {
    const p = mount({ screen: { kind: "new" } });
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "What the new bot should do" }),
      "Watch my inbox for invoices",
    );
    await user.click(
      screen.getByRole("button", { name: "Ask Chief of Staff" }),
    );
    expect(p.onNewBotSubmit).toHaveBeenCalledWith(
      "Watch my inbox for invoices",
    );
  });
});

describe("the hover list", () => {
  it("drops out of the notch with the suggestions, the bots, and the sessions, and opens Home on a row", async () => {
    const p = mount({ mode: "peek" });
    const list = screen.getByTestId("notch-peek");
    expect(
      within(list).getByTestId("notch-row-suggestions"),
    ).toBeInTheDocument();
    expect(within(list).getByTestId("notch-row-sessions")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Bots" })).toBeNull();
    await userEvent.setup().click(within(list).getByTestId("notch-row-scout"));
    expect(p.onPick).toHaveBeenCalledWith({
      kind: "agent",
      slug: "scout",
      name: "Scout",
      channel: "human__scout",
    });
    expect(p.onPeekHeight).toHaveBeenCalled();
  });
});
