import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MemberProvenance, runsOnLabel } from "./MemberProvenance";

describe("MemberProvenance", () => {
  it("tags a bot you made that runs here", () => {
    render(
      <MemberProvenance
        member={{
          origin: "user",
          runs_on: "this_machine",
          runs_on_detail: "this machine",
          managed_by: "cos",
        }}
      />,
    );
    expect(screen.getByText("Made by you")).toBeInTheDocument();
    expect(screen.getByText("Runs on this machine")).toBeInTheDocument();
    expect(screen.getByText("Managed by @cos")).toBeInTheDocument();
  });

  it("flags a gateway bot as running elsewhere", () => {
    render(
      <MemberProvenance
        member={{
          origin: "imported",
          runs_on: "elsewhere",
          runs_on_detail: "OpenClaw gateway",
        }}
      />,
    );
    expect(screen.getByText("Imported")).toBeInTheDocument();
    expect(
      screen.getByText("Runs elsewhere · OpenClaw gateway"),
    ).toBeInTheDocument();
  });

  it("tags a terminal session as yours, running on this machine", () => {
    render(
      <MemberProvenance
        member={{
          origin: "session",
          runs_on: "this_machine",
          runs_on_detail: "Claude Code on this machine",
          managed_by: "cos",
        }}
      />,
    );
    const tag = screen.getByText("Your session");
    expect(tag).toHaveAttribute("data-origin", "session");
    expect(screen.getByText("Runs here · Claude Code")).toBeInTheDocument();
  });

  it("renders nothing for a member without provenance", () => {
    const { container } = render(<MemberProvenance member={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shortens adopted CLI details", () => {
    expect(
      runsOnLabel({
        runs_on: "this_machine",
        runs_on_detail: "Gemini CLI on this machine",
      }),
    ).toBe("Runs here · Gemini CLI");
  });
});
