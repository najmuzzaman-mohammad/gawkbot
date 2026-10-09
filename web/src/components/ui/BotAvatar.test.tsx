import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type BotRuntime, BotRuntimeContext } from "../../lib/botRuntime";
import { BotAvatar } from "./BotAvatar";
import { PixelAvatar } from "./PixelAvatar";

const runtimes: Record<string, BotRuntime> = {
  eng: {
    harness: "claude-code",
    harness_name: "Claude Code",
    model_label: "Opus 5.5",
    family: "claude",
  },
  // A kind the old harness badge did not know and drew as Claude Code.
  scout: { harness: "cli-agent", harness_name: "Gemini CLI" },
};

function withRuntimes(ui: React.ReactNode) {
  return render(
    <BotRuntimeContext.Provider value={(slug) => runtimes[slug]}>
      {ui}
    </BotRuntimeContext.Provider>,
  );
}

describe("BotAvatar", () => {
  it("badges a bot with the model it runs on", () => {
    withRuntimes(<BotAvatar slug="eng" size={48} />);
    const badge = screen.getByRole("img", {
      name: "Runs on Opus 5.5 in Claude Code",
    });
    expect(badge).toHaveTextContent("Opus 5.5");
  });

  it("badges every PixelAvatar call site without the site asking", () => {
    withRuntimes(<PixelAvatar slug="eng" size={24} />);
    expect(
      screen.getByRole("img", { name: "Runs on Opus 5.5 in Claude Code" }),
    ).toHaveTextContent("O5");
  });

  it("never passes an unknown tool off as Claude Code", () => {
    withRuntimes(<BotAvatar slug="scout" size={48} />);
    const badge = screen.getByRole("img", { name: "Runs on Gemini CLI" });
    expect(badge).toHaveTextContent("Gemini CLI");
    expect(screen.queryByText(/claude/i)).toBeNull();
  });

  it("draws the bare face for a slug with no runtime", () => {
    const { container } = withRuntimes(<BotAvatar slug="a-human" size={24} />);
    expect(container.querySelector(".model-badge")).toBeNull();
    expect(container.querySelector(".bot-avatar")).toBeNull();
  });

  it("can be turned off where the mark is not a running bot", () => {
    const { container } = withRuntimes(
      <BotAvatar slug="eng" size={48} badge={false} />,
    );
    expect(container.querySelector(".model-badge")).toBeNull();
  });

  it("takes a runtime handed to it over the lookup", () => {
    withRuntimes(
      <BotAvatar
        slug="eng"
        size={48}
        runtime={{ harness: "codex", model_label: "GPT-6 Astra" }}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Runs on GPT-6 Astra in codex" }),
    ).toBeInTheDocument();
  });
});
