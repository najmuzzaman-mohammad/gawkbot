import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  adoptLocalAgents,
  getLocalAgents,
  type LocalAgentsResponse,
} from "../../../api/localAgents";
import { LocalAgentsSection } from "./LocalAgentsSection";

vi.mock("../../../api/localAgents", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/localAgents")>();
  return {
    ...actual,
    getLocalAgents: vi.fn(),
    adoptLocalAgents: vi.fn(),
  };
});

const getMock = vi.mocked(getLocalAgents);
const adoptMock = vi.mocked(adoptLocalAgents);

const SCAN: LocalAgentsResponse = {
  lead: "cos",
  agents: [
    {
      id: "claude-code",
      name: "Claude Code",
      vendor: "Anthropic",
      runtime: "native",
      installed: true,
      adoptable: true,
      adopted_as: "claude-code",
      running: [{ pid: 10, cwd: "/src/app" }],
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      vendor: "Google",
      runtime: "cli",
      installed: true,
      adoptable: true,
      binary_path: "/usr/local/bin/gemini",
    },
    {
      id: "codex",
      name: "Codex CLI",
      vendor: "OpenAI",
      runtime: "native",
      installed: true,
      adoptable: true,
      running: [{ pid: 11 }, { pid: 12 }],
    },
    {
      id: "cursor",
      name: "Cursor",
      runtime: "app",
      installed: true,
      adoptable: false,
      note: "IDE with no headless mode.",
    },
  ],
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(SCAN);
  adoptMock.mockResolvedValue({
    adopted: [{ id: "gemini", slug: "gemini", name: "Gemini CLI" }],
    lead: "cos",
  });
});

describe("LocalAgentsSection", () => {
  it("lists each agent with its state and names the Chief of Staff", async () => {
    render(wrap(<LocalAgentsSection />));
    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.getByText(/managed by @cos/)).toBeInTheDocument();
    expect(screen.getByText("Teammate @claude-code")).toBeInTheDocument();
    expect(screen.getByText("Working in /src/app")).toBeInTheDocument();
    expect(screen.getByText("Running ×2")).toBeInTheDocument();
    expect(screen.getByText("IDE with no headless mode.")).toBeInTheDocument();
    // Already-adopted and IDE-only agents get no Adopt button.
    expect(
      screen.queryByRole("button", { name: "Adopt Claude Code" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Adopt Cursor" }),
    ).not.toBeInTheDocument();
  });

  it("adopts one agent", async () => {
    const user = userEvent.setup();
    render(wrap(<LocalAgentsSection />));
    await user.click(
      await screen.findByRole("button", { name: "Adopt Gemini CLI" }),
    );
    await waitFor(() => expect(adoptMock).toHaveBeenCalledWith(["gemini"]));
  });

  it("adopt all sends only the agents that can be adopted now", async () => {
    const user = userEvent.setup();
    render(wrap(<LocalAgentsSection />));
    const all = await screen.findByRole("button", { name: "Adopt all (2)" });
    await user.click(all);
    await waitFor(() =>
      expect(adoptMock).toHaveBeenCalledWith(["gemini", "codex"]),
    );
  });

  it("says so when nothing is found", async () => {
    getMock.mockResolvedValue({ agents: [], lead: "cos" });
    render(wrap(<LocalAgentsSection />));
    expect(await screen.findByText(/No agent CLIs found/)).toBeInTheDocument();
    expect(screen.getByTestId("local-agents-adopt-all")).toBeDisabled();
  });
});
