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
    expect(badgeText(opus, "code")).toBe("Op");
    expect(badgeText(astra, "word")).toBe("GPT-6");
    expect(badgeText(astra, "code")).toBe("G6");
    expect(badgeText(local, "code")).toBe("q2");
  });

  it("tells one model from another in two characters", () => {
    // "O5" read as "05" on a 24px avatar, and Opus 5.5 and Sonnet 5.5 got
    // the same digit. The code is the name, not the version.
    const code = (model_label: string) =>
      badgeText({ harness: "x", model_label }, "code");
    expect(code("Opus 5.5")).toBe("Op");
    expect(code("Sonnet 5.5")).toBe("So");
    expect(code("Sonnet 4.6")).toBe("So");
    expect(code("Haiku 5.5")).toBe("Ha");
    expect(code("Fable 5.1")).toBe("Fa");
    expect(code("Gemini 2.5 Pro")).toBe("Ge");
    expect(code("GPT-6 Astra")).toBe("G6");
    expect(code("GPT-5.5")).toBe("G5");
    expect(code("o3")).toBe("o3");
    // No code is a bare number or starts with a zero-like "O" plus a digit.
    for (const label of ["Opus 5.5", "Sonnet 4.6", "Haiku 5.5", "Fable 5.1"]) {
      expect(code(label)).not.toMatch(/\d/);
    }
  });

  it("falls back to the tool when the model is unknown", () => {
    expect(badgeText(gemini, "full")).toBe("Gemini CLI");
    expect(badgeText(gemini, "word")).toBe("Gemini");
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
