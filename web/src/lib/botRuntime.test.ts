import { describe, expect, it } from "vitest";

import {
  type BotRuntime,
  badgeDensity,
  badgeText,
  runtimeTitle,
} from "./botRuntime";

const opus: BotRuntime = {
  harness: "claude-code",
  harness_name: "Claude Code",
  model: "claude-opus-5-5",
  model_label: "Opus 5.5",
  family: "claude",
};
const astra: BotRuntime = {
  harness: "codex",
  harness_name: "Codex CLI",
  model_label: "GPT-6 Astra",
};
const gemini: BotRuntime = { harness: "cli-agent", harness_name: "Gemini CLI" };
const local: BotRuntime = {
  harness: "ollama",
  harness_name: "Ollama",
  model_label: "qwen2.5-coder:32b",
};

describe("badgeDensity", () => {
  it("says more as the avatar gets bigger", () => {
    expect([12, 16, 24, 32, 43, 44, 64].map(badgeDensity)).toEqual([
      "dot",
      "code",
      "code",
      "word",
      "word",
      "full",
      "full",
    ]);
  });
});

describe("badgeText", () => {
  it("spells the model out where there is room", () => {
    expect(badgeText(opus, "full")).toBe("Opus 5.5");
    expect(badgeText(opus, "word")).toBe("Opus");
    expect(badgeText(opus, "code")).toBe("O5");
    expect(badgeText(astra, "word")).toBe("GPT-6");
    expect(badgeText(astra, "code")).toBe("G6");
    expect(badgeText(local, "code")).toBe("Q2");
  });

  it("falls back to the tool when the model is unknown", () => {
    expect(badgeText(gemini, "full")).toBe("Gemini CLI");
    expect(badgeText(gemini, "code")).toBe("GC");
    expect(badgeText({ harness: "exo" }, "code")).toBe("ex");
  });

  it("is empty for a dot", () => {
    expect(badgeText(opus, "dot")).toBe("");
  });
});

describe("runtimeTitle", () => {
  it("names the model and the tool", () => {
    expect(runtimeTitle(opus)).toBe("Opus 5.5 in Claude Code");
    expect(runtimeTitle(gemini)).toBe("Gemini CLI");
  });
});
