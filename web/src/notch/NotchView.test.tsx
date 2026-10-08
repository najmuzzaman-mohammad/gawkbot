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

  it("messages any agent from the roster, including ones running elsewhere", async () => {
    const props = renderNotch({ expanded: true });
    expect(screen.getByTestId("notch-agent-hermes")).toHaveTextContent(
      "Hermes gateway",
    );
    await userEvent.click(screen.getByTestId("notch-agent-hermes"));
    expect(props.onReply).toHaveBeenCalledWith({
      kind: "message",
      slug: "hermes",
      name: "Hermes",
      channel: "hermes__human",
    });
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
