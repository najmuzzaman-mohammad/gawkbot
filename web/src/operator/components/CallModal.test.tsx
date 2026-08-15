// Regression: the call must open un-finished and reveal progressively, not show
// the whole transcript instantly. Previously `revealed` started at SCRIPT.length
// so the call was "done" on mount and "Skip ahead" never rendered.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallModal } from "./CallModal";

afterEach(cleanup);

describe("CallModal reveal", () => {
  it("opens un-finished: shows Skip ahead and disables the describe CTA", () => {
    render(<CallModal onClose={vi.fn()} onDescribe={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /skip ahead/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /describe your own workflow/i }),
    ).toBeDisabled();
  });

  it("reveals only the first line on mount", () => {
    render(<CallModal onClose={vi.fn()} onDescribe={vi.fn()} />);

    // The transcript renders one <b> speaker label per revealed line.
    const transcript = document.querySelector(".opr-call-transcript");
    expect(transcript?.querySelectorAll(".opr-call-line").length).toBe(1);
  });

  it("jumps to the end (enabling the CTA) when Skip ahead is clicked", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<CallModal onClose={vi.fn()} onDescribe={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /skip ahead/i }));

    expect(
      screen.getByRole("button", { name: /describe your own workflow/i }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /skip ahead/i }),
    ).not.toBeInTheDocument();
  });
});

// Modify mode: passing a `tool` reframes the example as demonstrating a CHANGE
// to an existing tool — different dialog label, scoped script, and a
// describe-the-change CTA — instead of a brand-new workflow.
describe("CallModal modify mode", () => {
  it("frames the example around the existing tool", () => {
    render(
      <CallModal
        onClose={vi.fn()}
        onDescribe={vi.fn()}
        tool={{ id: "inbound-routing", name: "Inbound routing" }}
      />,
    );

    expect(
      screen.getByRole("dialog", {
        name: /example: demo a change to inbound routing/i,
      }),
    ).toBeInTheDocument();
    // The CTA is the modify label, not the build one.
    expect(
      screen.getByRole("button", { name: /describe the change yourself/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /describe your own workflow/i }),
    ).not.toBeInTheDocument();
  });

  it("enables the describe CTA after Skip ahead", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(
      <CallModal
        onClose={vi.fn()}
        onDescribe={vi.fn()}
        tool={{ id: "inbound-routing", name: "Inbound routing" }}
      />,
    );

    expect(
      screen.getByRole("button", { name: /describe the change yourself/i }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /skip ahead/i }));

    expect(
      screen.getByRole("button", { name: /describe the change yourself/i }),
    ).toBeEnabled();
  });

  // 2026-08-15 audit regression: the scripted example must NEVER claim a
  // capture happened, and its exit carries NO payload — the operator lands in
  // the real chat with an empty composer.
  it("claims no capture and exits with no payload", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onDescribe = vi.fn();
    render(
      <CallModal
        onClose={vi.fn()}
        onDescribe={onDescribe}
        tool={{ id: "inbound-routing", name: "Inbound routing" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /skip ahead/i }));
    expect(
      screen.queryByText(/captured from your screen/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/live call/i)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /describe the change yourself/i }),
    );

    expect(onDescribe).toHaveBeenCalledTimes(1);
    expect(onDescribe.mock.calls[0]).toHaveLength(0);
  });
});
