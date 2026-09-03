import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoist mocks before imports ───────────────────────────────────

const navigateMock = vi.hoisted(() => vi.fn());
const useOfficeMembersMock = vi.hoisted(() => vi.fn());
const getSkillsListMock = vi.hoisted(() => vi.fn());
const getOfficeTasksMock = vi.hoisted(() => vi.fn());
const getChannelsMock = vi.hoisted(() => vi.fn());
const listBotLogTasksMock = vi.hoisted(() => vi.fn());
const getPoliciesMock = vi.hoisted(() => vi.fn());
const getConfigMock = vi.hoisted(() => vi.fn());
const getLocalProvidersStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/router", () => ({
  router: { navigate: navigateMock },
}));

vi.mock("../../hooks/useMembers", () => ({
  useOfficeMembers: useOfficeMembersMock,
}));

vi.mock("../../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/client")>(
      "../../api/client",
    );
  return {
    ...actual,
    getSkillsList: getSkillsListMock,
    getChannels: getChannelsMock,
    getConfig: getConfigMock,
    getLocalProvidersStatus: getLocalProvidersStatusMock,
  };
});

vi.mock("../../api/tasks", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/tasks")>("../../api/tasks");
  return {
    ...actual,
    getOfficeTasks: getOfficeTasksMock,
    listBotLogTasks: listBotLogTasksMock,
  };
});

vi.mock("../../api/policies", async () => ({
  getPolicies: getPoliciesMock,
  policyAppliesToBot: (p: { agents?: string[] }, slug: string) =>
    !p.agents || p.agents.length === 0 || p.agents.includes(slug),
  createPolicy: vi.fn(),
  deactivatePolicy: vi.fn(),
  unassignPolicyBot: vi.fn(),
  assignPolicyBot: vi.fn(),
}));

vi.mock("../../hooks/useConfig", () => ({
  useDefaultHarness: () => "claude-code",
}));

vi.mock("../../lib/harness", () => ({
  resolveHarness: (_provider: unknown, fallback: string) => fallback,
  isGatewayBinding: () => false,
}));

vi.mock("../../hooks/useOfficeTasks", () => ({
  useOfficeTasks: () => ({ data: [], isLoading: false }),
}));

vi.mock("../ui/PixelAvatar", () => ({
  PixelAvatar: ({ slug }: { slug: string }) => (
    <span data-testid={`avatar-${slug}`} />
  ),
}));

vi.mock("../ui/HarnessBadge", () => ({
  HarnessBadge: () => null,
}));

// Mock heavy children so tests stay fast. The Chat tab is now a pure chat
// surface: the shared MessageFeed + Composer pointed at the bot's DM channel.
vi.mock("../messages/MessageFeed", () => ({
  MessageFeed: ({ channel }: { channel?: string }) => (
    <div data-testid="message-feed" data-channel={channel} />
  ),
}));

vi.mock("../messages/Composer", () => ({
  Composer: ({ channel }: { channel?: string }) => (
    <div data-testid="composer" data-channel={channel} />
  ),
}));

vi.mock("../../hooks/useBotStream", () => ({
  useBotStream: () => ({ lines: [], connected: false }),
}));

vi.mock("../../stores/app", () => ({
  directChannelSlug: (slug: string) => `human__${slug}`,
  useAppStore: (sel: (s: { brokerConnected: boolean }) => unknown) =>
    sel({ brokerConnected: true }),
}));

vi.mock("./BotInstructionsSection", () => ({
  BotInstructionsSection: () => <div data-testid="bot-instructions-section" />,
}));

// The Computer tab polls the broker and owns its own phases; it is covered in
// tabs/ComputerTab.test.tsx. Here only registration + the bot it receives
// matter.
vi.mock("./tabs/ComputerTab", () => ({
  ComputerTab: ({ agent }: { agent: { slug: string } }) => (
    <div data-testid="computer-tab" data-agent={agent.slug} />
  ),
}));

vi.mock("../ui/ConfirmDialog", () => ({
  confirm: vi.fn(),
  ConfirmHost: () => null,
}));

vi.mock("../apps/skills/PixelSkillCard", () => ({
  PixelSkillCard: ({ skill }: { skill: { name: string } }) => (
    <div data-testid={`skill-card-${skill.name}`} />
  ),
}));

// The Knowledge panel does its own fetching and promotion; its behavior is
// covered in BotKnowledgePanel.test.tsx. Here we only care that the tab is
// registered and hands the panel the right bot, so mock it like the other
// heavy children and assert on the slug it receives.
vi.mock("../knowledge/BotKnowledgePanel", () => ({
  BotKnowledgePanel: ({ agentSlug }: { agentSlug: string }) => (
    <div data-testid="bot-knowledge-panel" data-agent={agentSlug} />
  ),
}));

import type { OfficeMember } from "../../api/client";
import { AGENT_TABS, BotSubspace } from "./BotSubspace";

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(ui: ReactNode, qc = makeQC()) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const baseBot: OfficeMember = {
  slug: "planner",
  name: "Planner",
  role: "Plans tasks",
  status: "idle",
};

describe("<AgentSubspace>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOfficeMembersMock.mockReturnValue({ data: [baseBot] });
    getSkillsListMock.mockResolvedValue({ skills: [] });
    getChannelsMock.mockResolvedValue({ channels: [] });
    getOfficeTasksMock.mockResolvedValue({ tasks: [] });
    listBotLogTasksMock.mockResolvedValue({ tasks: [] });
    getPoliciesMock.mockResolvedValue([]);
    getConfigMock.mockResolvedValue({
      llm_provider: "claude-code",
      llm_provider_kinds: ["claude-code", "codex"],
    });
    getLocalProvidersStatusMock.mockResolvedValue([]);
  });

  it("renders all 8 tabs in order", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(AGENT_TABS.length);
    const labels = tabs.map((t) => t.textContent?.trim());
    // Knowledge sits next to Skills: both answer "what does this bot bring".
    expect(labels).toEqual([
      "Chat",
      "Computer",
      "Tasks",
      "Skills",
      "Knowledge",
      "Policies",
      "Live Stream",
      "Config",
    ]);
  });

  it("defaults to Chat tab (aria-selected=true on Chat)", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));

    const chatTab = screen.getByRole("tab", { name: "Chat" });
    expect(chatTab).toHaveAttribute("aria-selected", "true");
  });

  it("renders a pure chat surface (feed + composer on the DM channel) when Chat is active", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));

    // Pure chat only — no workbench (Tasks/Live Stream have their own tabs).
    expect(screen.getByTestId("message-feed")).toHaveAttribute(
      "data-channel",
      "human__planner",
    );
    expect(screen.getByTestId("composer")).toHaveAttribute(
      "data-channel",
      "human__planner",
    );
  });

  it("resolves the /live alias to the Live Stream tab (no silent Chat fallback)", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="live" />));

    expect(screen.getByRole("tab", { name: "Live Stream" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("renames the bot from the persistent shell header (parity with old panel)", async () => {
    const user = userEvent.setup();
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));

    // The header shows the name as a click-to-edit control (EditableName).
    // Clicking it must open an inline text input — the rename affordance the
    // old BotProfilePanel header had, relocated to the shell header.
    const nameButton = screen.getByRole("button", { name: /planner/i });
    await user.click(nameButton);

    const input = await screen.findByRole("textbox", { name: /bot name/i });
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("Planner");
  });

  it("marks the active tab as aria-selected", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="tasks" />));

    const tasksTab = screen.getByRole("tab", { name: "Tasks" });
    expect(tasksTab).toHaveAttribute("aria-selected", "true");

    const chatTab = screen.getByRole("tab", { name: "Chat" });
    expect(chatTab).toHaveAttribute("aria-selected", "false");
  });

  it("navigates when a tab is clicked", async () => {
    const user = userEvent.setup();
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));

    await user.click(screen.getByRole("tab", { name: "Tasks" }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/agents/$agentSlug/$tab",
      params: { agentSlug: "planner", tab: "tasks" },
    });
  });

  it("renders Config tab without losing sections (headless BotProfilePanel)", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="config" />));

    // Config tab content should be present
    const configPanel = screen.getByTestId("config-tab");
    expect(configPanel).toBeInTheDocument();
    // The close button should NOT appear (headless mode)
    expect(
      screen.queryByLabelText("Close bot profile"),
    ).not.toBeInTheDocument();
  });

  it("renders Skills tab content", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="skills" />));
    expect(screen.getByTestId("skills-tab")).toBeInTheDocument();
  });

  // Knowledge is per-bot: the panel is handed THIS bot's slug, so the tab
  // can only ever show what this bot knows.
  it("renders Knowledge tab content scoped to the bot", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="knowledge" />));

    const panel = screen.getByTestId("bot-knowledge-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute("data-agent", "planner");
    expect(screen.getByRole("tab", { name: "Knowledge" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it.each([
    "wiki",
    "notes",
    "notebook",
  ])("resolves the /%s alias to the Knowledge tab", (alias) => {
    render(wrap(<BotSubspace agent={baseBot} tab={alias} />));

    expect(screen.getByRole("tab", { name: "Knowledge" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("bot-knowledge-panel")).toBeInTheDocument();
  });

  // The bot's computer sits right after Chat and is handed THIS bot.
  it("renders Computer tab content scoped to the bot", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="computer" />));

    const panel = screen.getByTestId("computer-tab");
    expect(panel).toHaveAttribute("data-agent", "planner");
    expect(screen.getByRole("tab", { name: "Computer" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it.each([
    "screen",
    "desktop",
    "vm",
  ])("resolves the /%s alias to the Computer tab", (alias) => {
    render(wrap(<BotSubspace agent={baseBot} tab={alias} />));
    expect(screen.getByRole("tab", { name: "Computer" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders Policies tab content", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="policies" />));
    expect(screen.getByTestId("policies-tab")).toBeInTheDocument();
  });

  it("renders Live Stream tab content", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="live-stream" />));
    expect(screen.getByTestId("live-stream-tab")).toBeInTheDocument();
  });

  it("falls back to chat tab for unknown tab value", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="unknown-tab" />));

    const chatTab = screen.getByRole("tab", { name: "Chat" });
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("message-feed")).toBeInTheDocument();
  });

  it("renders the bot name in the shell header", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));
    // EditableName renders the name as a button with the bot's name
    expect(screen.getByText("Planner")).toBeInTheDocument();
  });

  it("renders the bot avatar in the shell header", () => {
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));
    expect(screen.getByTestId("avatar-planner")).toBeInTheDocument();
  });

  // "Teach a workflow" lives in the persistent shell header, so it is present
  // for every bot and on every tab rather than only where a tab happens to
  // be mounted. It is an action, not a section, so it is not a seventh tab.
  it("offers Teach a workflow from the shell header on every tab", () => {
    for (const t of AGENT_TABS) {
      const { unmount } = render(
        wrap(<BotSubspace agent={baseBot} tab={t.id} />),
      );
      expect(screen.getByTestId("teach-workflow-btn")).toBeInTheDocument();
      unmount();
    }
  });

  it("opens the screenshare flow from the header button, closed until clicked", async () => {
    const user = userEvent.setup();
    render(wrap(<BotSubspace agent={baseBot} tab="chat" />));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("teach-workflow-btn"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Teach Planner a workflow")).toBeInTheDocument();
  });
});
