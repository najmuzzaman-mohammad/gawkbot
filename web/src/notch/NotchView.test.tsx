import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { gang } from "./antics";
import { BUSY_OFFICE, MACBOOK_NOTCH, NO_NOTCH, QUIET_OFFICE } from "./fixtures";
import { NotchView, type NotchViewProps } from "./NotchView";

function renderNotch(overrides: Partial<NotchViewProps> = {}) {
  const props: NotchViewProps = {
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
  render(<NotchView {...props} />);
  return props;
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
