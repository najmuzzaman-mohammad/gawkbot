import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  LOCAL_AGENTS_QUERY_KEY,
  type LocalAgentsResponse,
} from "../../../api/localAgents";
import { LocalAgentsSection } from "./LocalAgentsSection";

import "../../../styles/settings.css";

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
      running: [{ pid: 4242, cwd: "/Users/me/src/gawkbot" }],
    },
    {
      id: "codex",
      name: "Codex CLI",
      vendor: "OpenAI",
      runtime: "native",
      installed: true,
      adoptable: true,
      binary_path: "/opt/homebrew/bin/codex",
      running: [{ pid: 101 }, { pid: 102 }],
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
      id: "aider",
      name: "Aider",
      vendor: "Aider",
      runtime: "cli",
      installed: false,
      adoptable: true,
      running: [{ pid: 77 }],
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      runtime: "gateway",
      installed: true,
      adoptable: false,
      note: "Gateway with its own bots. Bridge them from the Integrations app.",
    },
    {
      id: "cursor",
      name: "Cursor",
      vendor: "Cursor",
      runtime: "app",
      installed: true,
      adoptable: false,
      config_path: "/Users/me/.cursor",
      note: "IDE with no headless mode. Install the Cursor CLI (cursor-agent) to adopt it.",
    },
  ],
};

function seeded(data: LocalAgentsResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(LOCAL_AGENTS_QUERY_KEY, data);
  return client;
}

const meta: Meta<typeof LocalAgentsSection> = {
  title: "Settings / LocalAgentsSection",
  component: LocalAgentsSection,
};
export default meta;

type Story = StoryObj<typeof LocalAgentsSection>;

export const Default: Story = {
  render: () => (
    <QueryClientProvider client={seeded(SCAN)}>
      <LocalAgentsSection />
    </QueryClientProvider>
  ),
};

export const AllAdopted: Story = {
  render: () => (
    <QueryClientProvider
      client={seeded({
        lead: "cos",
        agents: SCAN.agents
          .filter((a) => a.adoptable && a.installed)
          .map((a) => ({ ...a, adopted_as: a.id })),
      })}
    >
      <LocalAgentsSection />
    </QueryClientProvider>
  ),
};

export const NothingFound: Story = {
  render: () => (
    <QueryClientProvider client={seeded({ lead: "cos", agents: [] })}>
      <LocalAgentsSection />
    </QueryClientProvider>
  ),
};
