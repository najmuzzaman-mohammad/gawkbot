import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BotRuntimeContext } from "../lib/botRuntime";
import { gang } from "./antics";
import { BUSY_OFFICE, MACBOOK_NOTCH, NO_NOTCH, QUIET_OFFICE } from "./fixtures";
import { NotchBot } from "./NotchBot";
import { agentsSummary } from "./NotchPanel";
import { NotchView, type NotchViewProps } from "./NotchView";
import type { NotchState } from "./types";

function notchProps(overrides: Partial<NotchViewProps> = {}): NotchViewProps {
  return {
    state: BUSY_OFFICE,
    geometry: MACBOOK_NOTCH,
    expanded: false,
    gang: gang(BUSY_OFFICE.attention, BUSY_OFFICE.agents),
    boredom: 0,
    line: null,
    peeker: null,
    selectedId: "req-1",
    answering: new Set(),
    composer: null,
    sending: false,
    error: null,
    soundOn: true,
    voiceAvailable: true,
    onSelect: vi.fn(),
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onComposerText: vi.fn(),
    onComposerSubmit: vi.fn(),
    onComposerCancel: vi.fn(),
    onVoice: vi.fn(),
    onOpen: vi.fn(),
    onKeyboard: vi.fn(),
    onToggleSound: vi.fn(),
    onOpenFull: vi.fn(),
    agentsOpen: false,
    onAgentsOpen: vi.fn(),
    ...overrides,
  };
}

function renderNotch(overrides: Partial<NotchViewProps> = {}) {
  const props = notchProps(overrides);
  render(<NotchView {...props} />);
  return props;
}

function renderNotchWith(overrides: Partial<NotchViewProps>) {
  const props = notchProps(overrides);
  return render(<NotchView {...props} />);
}

describe("collapsed notch", () => {
  it("is exactly the notch plus two ears", () => {
    renderNotch();
    const shell = screen.getByTestId("notch-shell");
    expect(shell.style.width).toBe(`${186 + 2 * 72}px`);
    expect(shell.style.height).toBe("32px");
  });

  it("piles everyone who needs you onto the notch, with a count", () => {
    renderNotch();
    expect(screen.getByTestId("notch-gang").children).toHaveLength(2);
    expect(
      screen.getByRole("img", { name: "Gemini CLI needs you" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("2 need you")).toBeInTheDocument();
  });

  it("lets the bored gang talk below the notch", () => {
    renderNotch({
      boredom: 2,
      line: { speaker: "gemini", text: "Is the human even there?" },
    });
    expect(screen.getByTestId("notch-chat")).toHaveTextContent(
      "Gemini CLI Is the human even there?",
    );
  });

  it("shows an agent peeking out for fun", () => {
    renderNotch({
      state: QUIET_OFFICE,
      gang: [],
      peeker: QUIET_OFFICE.agents[1],
    });
    expect(
      screen.getByRole("img", { name: "Designer peeks out" }),
    ).toBeInTheDocument();
  });

  it("flies a new asker in under the notch before it joins the gang", () => {
    const flyer = gang(BUSY_OFFICE.attention, BUSY_OFFICE.agents)[0];
    renderNotch({ arrival: flyer });
    expect(
      screen.getByRole("img", {
        name: `${flyer.name} flies in with a question`,
      }),
    ).toBeInTheDocument();
    // Still in the air: the gang waits for it to land.
    expect(screen.getByTestId("notch-gang").children).toHaveLength(1);
    expect(
      screen.queryByRole("img", { name: `${flyer.name} needs you` }),
    ).toBeNull();
  });

  it("tucks the lead in under a blanket when nothing is going on", () => {
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
    expect(document.querySelector(".nb-blanket")).not.toBeNull();
    unmount();
    // The human opens the notch (hovering in opens it): it wakes up.
    const open = renderNotchWith({ state: quiet, gang: [], expanded: true });
    expect(document.querySelector(".nb-blanket")).toBeNull();
    expect(document.querySelector(".notch-strip .nb-awake")).not.toBeNull();
    expect(document.querySelector(".notch-strip .nb-tucked")).toBeNull();
    open.unmount();
    // Someone working, or anything waiting on the human: it is up.
    renderNotch();
    expect(document.querySelector(".nb-blanket")).toBeNull();
  });

  it("renders as a pill on Macs without a notch", () => {
    renderNotch({ geometry: NO_NOTCH, state: QUIET_OFFICE, gang: [] });
    expect(screen.getByTestId("notch-shell").style.width).toBe("128px");
    expect(screen.queryByLabelText(/need you/)).not.toBeInTheDocument();
  });
});

describe("open notch", () => {
  it("answers in one tap and numbers the answers on the selected question", async () => {
    const props = renderNotch({ expanded: true });
    const approve = screen.getByRole("button", { name: "1 Approve" });
    await userEvent.click(approve);
    expect(props.onAnswer).toHaveBeenCalledWith("req-1", "approve");
  });

  it("replies to the asker in words", async () => {
    const props = renderNotch({ expanded: true });
    await userEvent.click(screen.getAllByRole("button", { name: /Reply/ })[1]);
    expect(props.onReply).toHaveBeenCalledWith({
      kind: "answer",
      requestId: "req-2",
      to: "Chief of Staff",
    });
  });

  it("badges every agent with what it runs on, sessions and bots alike", () => {
    const [lead, ...rest] = BUSY_OFFICE.agents;
    const state: NotchState = {
      ...BUSY_OFFICE,
      agents: [
        {
          ...lead,
          runtime: {
            harness: "claude-code",
            harness_name: "Claude Code",
            model_label: "Sonnet 4.6",
            family: "claude",
            source: "default",
          },
        },
        ...rest,
        {
          slug: "session.codex.b",
          name: "Add rate limits to the login route",
          mood: "working",
          kind: "session",
          tool: "codex",
          tool_name: "Codex CLI",
          runtime: {
            harness: "codex",
            harness_name: "Codex CLI",
            model: "gpt-6-astra",
            model_label: "GPT-6 Astra",
            family: "gpt",
            source: "observed",
          },
        },
      ],
    };
    renderNotch({ expanded: true, agentsOpen: true, state });
    const session = screen.getByTestId("notch-agent-session.codex.b");
    expect(
      session.querySelector(
        '[role="img"][aria-label="Runs on GPT-6 Astra in Codex CLI"]',
      ),
    ).not.toBeNull();
    // A bot that is asking carries its badge on the question card too.
    expect(
      document.querySelector(
        '.model-badge[aria-label="Runs on Sonnet 4.6 in Claude Code"]',
      ),
    ).not.toBeNull();
    // The collapsed strip is too small for a legible badge: its bots are
    // drawn, and none of them carries one.
    const gang = screen.getByTestId("notch-gang");
    expect(gang.querySelector(".notch-bot")).not.toBeNull();
    expect(gang.querySelector(".model-badge")).toBeNull();
    // The badge sits on the bot, beside its mood: it does not replace the
    // notch's own mood class.
    const bot = session.querySelector(".notch-bot");
    expect(bot).toHaveClass("nb-working");
    expect(bot?.querySelector(".model-badge")).not.toBeNull();
  });

  it("says what a named bot runs on in its accessible name", () => {
    // The bot is one image to a screen reader, so the badge inside it is
    // not read on its own.
    render(
      <BotRuntimeContext.Provider
        value={() => ({
          harness: "codex",
          harness_name: "Codex CLI",
          model_label: "GPT-6 Astra",
        })}
      >
        <NotchBot slug="cx-1" mood="working" label="Rate limits: working" />
      </BotRuntimeContext.Provider>,
    );
    expect(
      screen.getByRole("img", {
        name: "Rate limits: working, runs on GPT-6 Astra in Codex CLI",
      }),
    ).toBeInTheDocument();
  });

  it("lists a session running on this Mac as an agent, by what it is doing", async () => {
    const state: NotchState = {
      ...BUSY_OFFICE,
      agents: [
        ...BUSY_OFFICE.agents,
        {
          slug: "session.claude-code.a",
          name: "Fix the flaky checkout test",
          mood: "idle",
          detail: "Your turn · shop",
          kind: "session",
          tool: "claude-code",
          tool_name: "Claude Code",
          project: "shop",
          cwd: "/Users/me/shop",
          state: "your_turn",
          updated_at: new Date(Date.now() - 12 * 60_000).toISOString(),
          last_said: "Both fixes pass. Which one should I keep?",
        },
      ],
    };
    renderNotch({ expanded: true, agentsOpen: true, state });
    // One list: there is no separate section for what runs on this Mac.
    expect(screen.queryByLabelText("Running on this Mac")).toBeNull();
    const row = screen.getByTestId("notch-agent-session.claude-code.a");
    // The words are what the session is about; the tool is the logo.
    expect(row).toHaveTextContent("Fix the flaky checkout test");
    expect(row).toHaveTextContent("Your turn · shop · 12m");
    expect(
      row.querySelector('[role="img"][aria-label="Claude Code"] svg'),
    ).not.toBeNull();
    // It has its own face, like every other agent.
    expect(row.querySelector("svg, canvas")).not.toBeNull();
    // The two kinds of agent are listed apart, under the one Agents card.
    expect(screen.getByText(/^gawkbot team · \d+$/)).toBeInTheDocument();
    expect(screen.getByText("Sessions on this Mac · 1")).toBeInTheDocument();
    // Not a member of the office yet: pressing it shows what it last said.
    expect(row.querySelector(".nagent-open")).toBeNull();
    expect(row).not.toHaveTextContent("Which one should I keep?");
    await userEvent.click(
      screen.getByRole("button", { name: /Fix the flaky checkout test/ }),
    );
    expect(row).toHaveTextContent("Both fixes pass. Which one should I keep?");
    expect(row).toHaveTextContent("/Users/me/shop");
    expect(row).toHaveTextContent("Answer it in its Claude Code window.");
  });

  it("does not send the human to a window that is closed", async () => {
    const state: NotchState = {
      ...BUSY_OFFICE,
      agents: [
        ...BUSY_OFFICE.agents,
        {
          slug: "session.claude-code.b",
          name: "Tidy the migration scripts",
          mood: "idle",
          detail: "Closed · api",
          kind: "session",
          tool: "claude-code",
          tool_name: "Claude Code",
          open: false,
          last_said: "Run them on staging?",
        },
      ],
    };
    renderNotch({ expanded: true, agentsOpen: true, state });
    await userEvent.click(
      screen.getByRole("button", { name: /Tidy the migration scripts/ }),
    );
    const row = screen.getByTestId("notch-agent-session.claude-code.b");
    expect(row).toHaveTextContent("Its Claude Code window is closed.");
    expect(row).not.toHaveTextContent("Answer it in its");
  });

  it("shows every active agent on the strip in its own state, up to the cap", () => {
    const moods = [
      "working",
      "done",
      "error",
      "working",
      "working",
      "working",
      "working",
    ] as const;
    const agents = [
      {
        slug: "cos",
        name: "Chief of Staff",
        mood: "idle" as const,
        is_lead: true,
      },
      ...moods.map((mood, i) => ({ slug: `bot-${i}`, name: `Bot ${i}`, mood })),
      { slug: "napper", name: "Napper", mood: "idle" as const },
    ];
    const state: NotchState = {
      ...QUIET_OFFICE,
      mood: "working",
      attention: [],
      agents,
    };
    renderNotchWith({ state, gang: [] });
    const crew = screen.getByTestId("notch-crew");
    expect(crew.children).toHaveLength(5);
    // The one that hit a snag leads, then the one that finished, then work.
    const shown = Array.from(crew.querySelectorAll("[data-mood]")).map((el) =>
      el.getAttribute("data-mood"),
    );
    expect(shown).toEqual(["error", "done", "working", "working", "working"]);
    // Two more are working than the strip holds; the idle ones do not count.
    expect(
      screen.getByRole("img", { name: "2 more active" }),
    ).toHaveTextContent("+2");
  });

  it("treats a session that has joined the office exactly like a bot", async () => {
    const state: NotchState = {
      ...BUSY_OFFICE,
      agents: [
        ...BUSY_OFFICE.agents,
        {
          slug: "cc-1a2b3c4d",
          name: "Fix the flaky checkout test",
          mood: "idle",
          detail: "Your turn · shop",
          kind: "session",
          tool: "claude-code",
          tool_name: "Claude Code",
          can_message: true,
        },
      ],
    };
    const props = renderNotch({ expanded: true, agentsOpen: true, state });
    await userEvent.click(
      screen.getByRole("button", {
        name: "Message Fix the flaky checkout test",
      }),
    );
    expect(props.onReply).toHaveBeenCalledWith({
      kind: "message",
      slug: "cc-1a2b3c4d",
      name: "Fix the flaky checkout test",
      channel: "cc-1a2b3c4d__human",
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "Open Fix the flaky checkout test in full view",
      }),
    );
    expect(props.onOpen).toHaveBeenCalledWith("/agents/cc-1a2b3c4d");
  });

  it("says what the folded agent list holds, and that it opens", () => {
    renderNotch({ expanded: true });
    const toggle = screen.getByRole("button", { name: /Agents/ });
    expect(toggle).toHaveTextContent("Show all");
    expect(toggle).toHaveTextContent(agentsSummary(BUSY_OFFICE.agents));
  });

  it("keeps the agent list folded away until asked for", async () => {
    const props = renderNotch({ expanded: true });
    expect(screen.queryByTestId("notch-agent-gemini")).toBeNull();
    const toggle = screen.getByRole("button", { name: /Agents/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(props.onAgentsOpen).toHaveBeenCalledWith(true);
  });

  it("tags a local agent with the tool that runs it, after who made it", () => {
    renderNotch({ expanded: true, agentsOpen: true });
    const gemini = screen.getByTestId("notch-agent-gemini");
    expect(
      Array.from(gemini.querySelectorAll(".ntag")).map((t) => t.textContent),
    ).toEqual(["adopted", "Gemini CLI · this Mac"]);
    // No tool from the broker: only the origin.
    expect(
      Array.from(
        screen.getByTestId("notch-agent-codex").querySelectorAll(".ntag"),
      ).map((t) => t.textContent),
    ).toEqual(["adopted"]);
    // A question card keeps one tag: who made it when it runs here.
    expect(
      Array.from(
        screen.getByTestId("notch-attention-req-1").querySelectorAll(".ntag"),
      ).map((t) => t.textContent),
    ).toEqual(["adopted", "holding up work"]);
  });

  it("messages an agent from the roster, with a button for its full view", async () => {
    const props = renderNotch({ expanded: true, agentsOpen: true });
    expect(screen.getByTestId("notch-agent-hermes")).toHaveTextContent(
      "Hermes gateway",
    );
    // The row is the quick chat, including for agents running elsewhere.
    await userEvent.click(
      screen.getByRole("button", { name: "Message Hermes" }),
    );
    expect(props.onReply).toHaveBeenCalledWith({
      kind: "message",
      slug: "hermes",
      name: "Hermes",
      channel: "hermes__human",
    });
    expect(props.onOpen).not.toHaveBeenCalled();
    // The arrow leaves for the agent's page in the full app.
    await userEvent.click(
      screen.getByRole("button", { name: "Open Hermes in full view" }),
    );
    expect(props.onOpen).toHaveBeenCalledWith("/agents/hermes");
  });

  it("opens the selected question with its full background, and only that one", () => {
    const state = {
      ...BUSY_OFFICE,
      attention: BUSY_OFFICE.attention.map((a, i) =>
        i === 0
          ? {
              ...a,
              context: "Short lead-in.",
              brief: {
                context: "The whole account of the decision.",
                project: "checkout",
                project_about: "Ship the new checkout this week.",
                task: { title: "Migrate sessions", status: "in_progress" },
                recent: [
                  {
                    from: "gemini",
                    name: "Gemini CLI",
                    text: "Dry run is clean.",
                  },
                ],
              },
              options: (a.options ?? []).map((o) =>
                o.id === "approve" ? { ...o, description: "Sends it now." } : o,
              ),
            }
          : a,
      ),
    };
    const first = state.attention[0].id;
    renderNotch({ expanded: true, state, selectedId: first });
    const card = screen.getByTestId(`notch-attention-${first}`);
    const brief = screen.getByTestId("notch-brief");
    expect(card).toContainElement(brief);
    expect(brief).toHaveTextContent(
      "#checkout Ship the new checkout this week.",
    );
    expect(brief).toHaveTextContent("Migrate sessions");
    expect(brief).toHaveTextContent("in progress");
    expect(brief).toHaveTextContent("The whole account of the decision.");
    expect(brief).toHaveTextContent("Gemini CLI Dry run is clean.");
    expect(card).toHaveTextContent("Sends it now.");
    // One brief on screen: the cards that are not selected stay short.
    expect(screen.getAllByTestId("notch-brief")).toHaveLength(1);
  });

  it("shows only the lead-in on a question that is not selected", () => {
    const state = {
      ...BUSY_OFFICE,
      attention: BUSY_OFFICE.attention.map((a, i) =>
        i === 0
          ? {
              ...a,
              context: "Short lead-in.",
              brief: { context: "The whole account." },
            }
          : a,
      ),
    };
    renderNotch({ expanded: true, state, selectedId: "none" });
    expect(screen.queryByTestId("notch-brief")).toBeNull();
    expect(screen.getByText("Short lead-in.")).toBeInTheDocument();
  });

  it("composes, listens and sends", async () => {
    const props = renderNotch({
      expanded: true,
      composer: {
        target: {
          kind: "message",
          slug: "codex",
          name: "Codex CLI",
          channel: "codex__human",
        },
        text: "pause it",
        listening: false,
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(props.onComposerSubmit).toHaveBeenCalled();
    screen
      .getByRole("button", { name: "Talk" })
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(props.onVoice).toHaveBeenCalledWith(true);
  });

  it("opens the full app from the widget", async () => {
    const props = renderNotch({ expanded: true });
    await userEvent.click(
      screen.getByRole("button", { name: "Open full view" }),
    );
    expect(props.onOpenFull).toHaveBeenCalled();
  });

  it("can mute its sounds", async () => {
    const props = renderNotch({ expanded: true });
    await userEvent.click(screen.getByRole("button", { name: "Mute sounds" }));
    expect(props.onToggleSound).toHaveBeenCalled();
  });

  it("disables answers already in flight", () => {
    renderNotch({ expanded: true, answering: new Set(["req-1"]) });
    expect(screen.getByRole("button", { name: "1 Approve" })).toBeDisabled();
  });
});
