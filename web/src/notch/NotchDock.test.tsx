import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DONE_CARD_MS, dockAgents, dockCards, trackDone } from "./dock";
import type { DockMessage } from "./dockBridge";
import { BUSY_OFFICE, QUIET_OFFICE } from "./fixtures";
import { NotchDock } from "./NotchDock";
import type { NotchState } from "./types";

// The cards at the top right, fed by a broker whose answer the test
// controls, talking to a stand-in for the Mac app.

let served: NotchState = QUIET_OFFICE;
const stopped: string[] = [];

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  getNotchState: () => Promise.resolve(served),
  stopBot: (slug: string) => {
    stopped.push(slug);
    return Promise.resolve();
  },
}));

type DockHost = { webkit?: unknown };
let posted: DockMessage[] = [];

const AT_WORK: NotchState = {
  ...BUSY_OFFICE,
  jump_out: true,
  agents: [
    { slug: "cos", name: "Chief of Staff", mood: "working", is_lead: true },
    { slug: "ops", name: "Ops", mood: "working", detail: "moving 14 files" },
    { slug: "scout", name: "Scout", mood: "idle" },
    {
      slug: "term",
      name: "Claude Code",
      mood: "working",
      kind: "session",
      tool: "claude-code",
    },
  ],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NotchDock />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  posted = [];
  stopped.length = 0;
  (window as unknown as DockHost).webkit = {
    messageHandlers: {
      gawkDock: { postMessage: (m: DockMessage) => posted.push(m) },
    },
  };
});

afterEach(() => {
  cleanup();
  (window as unknown as DockHost).webkit = undefined;
});

describe("who gets a card", () => {
  it("is every bot at work but the lead and sessions you opened yourself", () => {
    expect(dockAgents(AT_WORK).map((a) => a.slug)).toEqual(["ops"]);
  });
  it("is nobody while bots may not leave the notch, or before the office answers", () => {
    expect(dockAgents({ ...AT_WORK, jump_out: false })).toEqual([]);
    expect(dockAgents(undefined)).toEqual([]);
  });
});

describe("the dock page", () => {
  it("shows a card per working bot and tells the app how tall it is", async () => {
    served = AT_WORK;
    mount();
    expect(await screen.findByTestId("notch-dock-ops")).toBeInTheDocument();
    expect(screen.queryByTestId("notch-dock-cos")).toBeNull();
    expect(screen.getByText("moving 14 files")).toBeInTheDocument();
    const sizes = posted.filter((m) => m.type === "dock");
    expect(sizes.at(-1)).toMatchObject({ type: "dock", count: 1 });
  });

  it("tells the app to hide when nobody is working", async () => {
    served = QUIET_OFFICE;
    mount();
    await waitFor(() =>
      expect(posted.at(-1)).toEqual({ type: "dock", height: 0, count: 0 }),
    );
  });

  it("shows the whole line, more behind History, opens the notch on the bot, and stops it", async () => {
    served = {
      ...AT_WORK,
      agents: AT_WORK.agents.map((a) =>
        a.slug === "ops"
          ? {
              ...a,
              detail:
                "Moving 14 screenshots from Desktop into Shots, then checking for duplicates before I name the rest by date",
              last: {
                from: "ops",
                text: "Found 14 screenshots from last week.",
              },
            }
          : a,
      ),
    };
    mount();
    const card = await screen.findByTestId("notch-dock-ops");
    expect(card).toHaveTextContent(
      "Moving 14 screenshots from Desktop into Shots, then checking for duplicates before I name the rest by date",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /History/ }));
    expect(
      screen.getByText("Found 14 screenshots from last week."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(posted.filter((m) => m.type === "chat")).toEqual([
      { type: "chat", slug: "ops" },
    ]);
    await user.click(screen.getByRole("button", { name: "Stop Ops" }));
    expect(stopped).toEqual(["ops"]);
    expect(screen.getByText("Stopping")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Ops" })).toBeDisabled();
  });
});

describe("cards beyond work", () => {
  const ASKING: NotchState = {
    ...BUSY_OFFICE,
    agents: BUSY_OFFICE.agents,
  };

  it("gives a bot waiting on you a card with its whole question, and never the lead", () => {
    const cards = dockCards(ASKING, new Map(), new Set(), 0);
    const gemini = cards.find((c) => c.agent.slug === "gemini");
    expect(gemini?.kind).toBe("needs_you");
    expect(gemini?.line).toBe(
      "Send the launch email? It goes to 1,204 people.",
    );
    expect(cards.some((c) => c.agent.slug === "cos")).toBe(false);
    expect(
      dockCards(ASKING, new Map(), new Set(["q:req-1"]), 0).some(
        (c) => c.agent.slug === "gemini",
      ),
    ).toBe(false);
  });

  it("keeps a finished bot's card for a while, saying what it last said", () => {
    const state: NotchState = {
      ...QUIET_OFFICE,
      agents: [
        ...QUIET_OFFICE.agents,
        {
          slug: "ops",
          name: "Ops",
          mood: "idle",
          last: { from: "ops", text: "Moved 14 files into Shots." },
        },
      ],
    };
    const done = trackDone(new Set(["ops"]), state, new Map(), 1_000);
    expect([...done.keys()]).toEqual(["ops"]);
    const [card] = dockCards(state, done, new Set(), 2_000);
    expect(card).toMatchObject({
      kind: "done",
      line: "Moved 14 files into Shots.",
    });
    expect(dockCards(state, done, new Set(), 1_000 + DONE_CARD_MS + 1)).toEqual(
      [],
    );
  });
});
