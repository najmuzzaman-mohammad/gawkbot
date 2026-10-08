import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BUSY_OFFICE, MACBOOK_NOTCH, NO_NOTCH, QUIET_OFFICE } from "./fixtures";
import { NotchView, type NotchViewProps } from "./NotchView";

function renderNotch(overrides: Partial<NotchViewProps> = {}) {
  const props: NotchViewProps = {
    state: BUSY_OFFICE,
    geometry: MACBOOK_NOTCH,
    expanded: false,
    onAnswer: vi.fn(),
    onSend: vi.fn(),
    onOpen: vi.fn(),
    onKeyboard: vi.fn(),
    ...overrides,
  };
  render(<NotchView {...props} />);
  return props;
}

describe("NotchView collapsed", () => {
  it("is exactly the notch plus two ears", () => {
    renderNotch();
    const shell = screen.getByTestId("notch-shell");
    expect(shell.style.width).toBe(`${186 + 2 * 72}px`);
    expect(shell.style.height).toBe("32px");
  });

  it("shows the Chief of Staff, the agents that need looking at, and a count", () => {
    renderNotch();
    expect(
      screen.getByRole("img", { name: /^Chief of Staff: 2 things need you/ }),
    ).toBeInTheDocument();
    // Idle agents stay off the strip; at most three others show.
    expect(
      screen.getByRole("img", { name: "Gemini CLI: needs you" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Codex CLI: error" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /Hermes/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("2 need you")).toBeInTheDocument();
  });

  it("renders as a pill on Macs without a notch", () => {
    renderNotch({ geometry: NO_NOTCH, state: QUIET_OFFICE });
    expect(screen.getByTestId("notch-shell").style.width).toBe("128px");
    expect(screen.queryByLabelText(/need you/)).not.toBeInTheDocument();
  });
});

describe("NotchView expanded", () => {
  it("answers an approval in one tap", async () => {
    const props = renderNotch({ expanded: true });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(props.onAnswer).toHaveBeenCalledWith("req-1", "approve");
  });

  it("sends typed answers to the app instead of guessing", async () => {
    const props = renderNotch({ expanded: true });
    const card = screen.getByTestId("notch-attention-req-2");
    expect(card).not.toHaveTextContent("Other");
    await userEvent.click(
      screen.getAllByRole("button", { name: "Answer in app" })[0],
    );
    expect(props.onOpen).toHaveBeenCalledWith("/channels/cos__human");
  });

  it("tags agents by origin and where they run", () => {
    renderNotch({ expanded: true });
    expect(screen.getByTestId("notch-agent-designer")).toHaveTextContent(
      "yours",
    );
    expect(screen.getByTestId("notch-agent-gemini")).toHaveTextContent(
      "adopted",
    );
    expect(screen.getByTestId("notch-agent-scout")).toHaveTextContent(
      "hired by CoS",
    );
    expect(screen.getByTestId("notch-agent-hermes")).toHaveTextContent(
      "Hermes gateway",
    );
  });

  it("messages the Chief of Staff and asks native for the keyboard", async () => {
    const props = renderNotch({ expanded: true });
    const input = screen.getByRole("textbox", {
      name: "Message Chief of Staff",
    });
    fireEvent.focus(input);
    expect(props.onKeyboard).toHaveBeenCalledWith(true);
    await userEvent.type(input, "Pause @codex until I'm back{Enter}");
    expect(props.onSend).toHaveBeenCalledWith("Pause @codex until I'm back");
    expect(input).toHaveValue("");
  });

  it("disables answers already in flight", () => {
    renderNotch({ expanded: true, answering: new Set(["req-1"]) });
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });
});
