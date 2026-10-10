import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OfficeMember } from "../../api/client";
import { type BotRuntime, BotRuntimeContext } from "../../lib/botRuntime";

// BotList.test.tsx replaces PixelAvatar with a stub, so the model badge can
// never appear there. This file keeps the real avatar and checks one thing:
// a session row's avatar carries the badge for what the session runs on.

vi.mock("../../hooks/useMembers", () => ({
  useOfficeMembers: vi.fn(),
  useOfficeMembersMeta: vi.fn(),
  useChannelMembers: vi.fn(),
}));
vi.mock("../../hooks/useFirstRunNudge", () => ({
  useFirstRunNudge: () => ({ showNudge: false }),
}));
vi.mock("../../hooks/useOverflow", () => ({
  useOverflow: () => ({ current: null }),
}));
vi.mock("../../routes/useCurrentRoute", () => ({
  useCurrentRoute: () => ({ kind: "unknown" }),
}));
vi.mock("../bots/BotWizard", () => ({
  BotWizard: () => null,
  useBotWizard: () => ({ open: false, show: () => {}, hide: () => {} }),
}));
vi.mock("./BotEventPeek", () => ({ BotEventPeek: () => null }));
vi.mock("../../lib/router", () => ({ router: { navigate: vi.fn() } }));

import { useOfficeMembers } from "../../hooks/useMembers";
import { BotList } from "./BotList";

const members: OfficeMember[] = [
  {
    slug: "cos",
    name: "Chief of Staff",
    role: "lead",
    origin: "built_in",
    runtime: {
      harness: "claude-code",
      harness_name: "Claude Code",
      model: "claude-sonnet-5-5",
      model_label: "Sonnet 5.5",
      family: "claude",
    },
  },
  {
    slug: "cx-9c8d7b6a",
    name: "Tidy the migration scripts",
    role: "Codex CLI session in api",
    origin: "session",
    status: "idle",
    runtime: {
      harness: "codex",
      harness_name: "Codex CLI",
      model: "gpt-6-astra",
      model_label: "GPT-6 Astra",
      family: "gpt",
      source: "observed",
    },
    session: { tool: "codex", project: "api", state: "your_turn", live: true },
  },
  {
    slug: "cc-1a2b3c4d",
    name: "Draft the release notes",
    role: "Claude Code session in docs",
    origin: "session",
    status: "idle",
    // No model yet: the tool alone.
    runtime: { harness: "claude-code", harness_name: "Claude Code" },
    session: { tool: "claude-code", project: "docs", live: true },
  },
];

function renderWithRuntimes() {
  vi.mocked(useOfficeMembers).mockReturnValue({
    data: members,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useOfficeMembers>);
  const lookup = (slug: string): BotRuntime | undefined =>
    members.find((m) => m.slug === slug)?.runtime;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BotRuntimeContext.Provider value={lookup}>
        <BotList />
      </BotRuntimeContext.Provider>
    </QueryClientProvider>,
  );
}

describe("<BotList> session rows carry the model badge", () => {
  it("labels a session's avatar with the model and tool it runs on", () => {
    const { getByTestId } = renderWithRuntimes();
    const group = getByTestId("sidebar-sessions-group");

    const codexRow = group.querySelector('button[data-bot-slug="cx-9c8d7b6a"]');
    expect(
      codexRow?.querySelector(
        '[aria-label="Runs on GPT-6 Astra in Codex CLI"]',
      ),
    ).not.toBeNull();

    // The other session's row does not borrow that badge.
    const claudeRow = group.querySelector(
      'button[data-bot-slug="cc-1a2b3c4d"]',
    );
    expect(claudeRow).not.toBeNull();
    expect(claudeRow?.querySelector('[aria-label*="GPT-6 Astra"]')).toBeNull();
  });
});
