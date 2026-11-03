import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionRuntimeSection } from "./SessionRuntimeSection";

describe("SessionRuntimeSection", () => {
  it("shows the tool, the model, and the folder, with nothing to edit", () => {
    render(
      <SessionRuntimeSection
        agent={{
          runtime: {
            harness: "codex",
            harness_name: "Codex CLI",
            model: "gpt-5.5-codex",
            model_label: "GPT-5.5 Codex",
          },
          session: {
            tool: "codex",
            project: "api",
            cwd: "/Users/me/api",
            live: true,
          },
        }}
      />,
    );
    expect(screen.getByTestId("session-runtime-tool").textContent).toBe(
      "Codex CLI",
    );
    expect(screen.getByTestId("session-runtime-model").textContent).toBe(
      "GPT-5.5 Codex",
    );
    expect(screen.getByTestId("session-runtime-folder").textContent).toBe(
      "/Users/me/api",
    );
    expect(
      screen
        .getByTestId("session-runtime-section")
        .querySelectorAll("select, input, button, textarea").length,
    ).toBe(0);
  });

  it("says a value is not known yet and never shows the local-session kind", () => {
    render(
      <SessionRuntimeSection
        agent={{
          runtime: { harness: "claude-code" },
          session: { tool: "claude-code", project: "shop", live: false },
        }}
      />,
    );
    // No display name from the broker: the tool id, not the binding kind.
    expect(screen.getByTestId("session-runtime-tool").textContent).toBe(
      "claude-code",
    );
    expect(screen.getByTestId("session-runtime-model").textContent).toBe(
      "Not known yet",
    );
    // No full path: the folder name alone.
    expect(screen.getByTestId("session-runtime-folder").textContent).toBe(
      "shop",
    );
    expect(
      screen.getByTestId("session-runtime-section").textContent,
    ).not.toContain("local-session");
  });
});
