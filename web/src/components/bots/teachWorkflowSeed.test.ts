import { describe, expect, it } from "vitest";

import type { ObservedScreen } from "../../appdetail/apps/observeClient";
import { buildBotWorkflowSeed } from "./teachWorkflowSeed";

const screens: ObservedScreen[] = [
  {
    app: "Google Chrome",
    title: "Expensify | New report",
    components: [
      { role: "Button", label: "Add expense" },
      { role: "TextField", label: "Merchant" },
    ],
    text: "Weekly expenses due Friday",
  },
  {
    app: "Mail",
    title: "Inbox — Finance",
    components: [{ role: "Button", label: "Send" }],
  },
];

describe("buildAgentWorkflowSeed", () => {
  it("keeps the screens in the order they were used", () => {
    const seed = buildBotWorkflowSeed({
      agentSlug: "planner",
      goal: "File the weekly expense report",
      screens,
    });
    expect(seed).toContain("1. Google Chrome — Expensify | New report");
    expect(seed).toContain("2. Mail — Inbox — Finance");
    expect(seed.indexOf("1. Google Chrome")).toBeLessThan(
      seed.indexOf("2. Mail"),
    );
  });

  it("carries the elements and visible text the observer read", () => {
    const seed = buildBotWorkflowSeed({
      agentSlug: "planner",
      goal: "File the weekly expense report",
      screens,
    });
    expect(seed).toContain("Button:Add expense, TextField:Merchant");
    expect(seed).toContain("text: Weekly expenses due Friday");
  });

  it("addresses the bot it is teaching", () => {
    const seed = buildBotWorkflowSeed({
      agentSlug: "planner",
      goal: "File the weekly expense report",
      screens,
    });
    expect(seed).toContain(
      "Learn this workflow: File the weekly expense report",
    );
    expect(seed).toContain("@planner");
  });

  // The honesty gate: the bot's first reply has to name what it cannot run,
  // so nothing downstream can present an untried workflow as a working one.
  it("asks the bot to name the steps it cannot do yet", () => {
    const seed = buildBotWorkflowSeed({
      agentSlug: "planner",
      goal: "File the weekly expense report",
      screens,
    });
    expect(seed).toContain("cannot do yet with the tools you have");
  });

  it("says no screens were read rather than implying a capture happened", () => {
    const seed = buildBotWorkflowSeed({
      agentSlug: "planner",
      goal: "File the weekly expense report",
      screens: [],
    });
    expect(seed).toContain("No screens were read during the screenshare");
    expect(seed).not.toContain("I just did this on my own screen");
  });

  it("does not invent a workflow the observer never reported", () => {
    const seed = buildBotWorkflowSeed({
      agentSlug: "planner",
      goal: "File the weekly expense report",
      screens: [screens[0]],
    });
    expect(seed).not.toContain("Mail");
    expect(seed).not.toContain("2.");
  });
});
