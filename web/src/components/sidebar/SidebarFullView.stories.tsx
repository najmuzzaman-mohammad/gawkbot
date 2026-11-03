import type { Meta, StoryObj } from "@storybook/react-vite";

import { SidebarContext } from "../../../.storybook/sidebar-decorator";
import type { OfficeMember } from "../../api/client";
import { type BotRuntime, BotRuntimeContext } from "../../lib/botRuntime";
import { Sidebar } from "../layout/Sidebar";

/**
 * Mounts the REAL Sidebar (from components/layout/Sidebar) with React Query
 * + memory router seeded by SidebarContext. The right pane is just a
 * scaffold so the sidebar has a layout neighbour.
 */
const meta: Meta = {
  title: "Sidebar/Full view",
  parameters: { layout: "fullscreen" },
};

export default meta;

function MockContent({ title }: { title: string }) {
  return (
    <main
      style={{
        flex: 1,
        padding: 32,
        color: "var(--text)",
        background: "var(--bg)",
        minHeight: "100vh",
      }}
    >
      <h2 style={{ margin: 0, marginBottom: 8 }}>{title}</h2>
      <p style={{ color: "var(--text-secondary)", maxWidth: 520 }}>
        Switch themes from the toolbar to see the sidebar reskin via tokens.
      </p>
    </main>
  );
}

export const Expanded: StoryObj = {
  render: () => (
    <SidebarContext initialUrl="/channels/architecture">
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar />
        <MockContent title="#architecture" />
      </div>
    </SidebarContext>
  ),
};

export const OnAppRoute: StoryObj = {
  name: "On an app route",
  render: () => (
    <SidebarContext initialUrl="/apps/wiki">
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar />
        <MockContent title="Wiki" />
      </div>
    </SidebarContext>
  ),
};

export const HeavyUnread: StoryObj = {
  name: "Heavy unread",
  render: () => (
    <SidebarContext
      initialUrl="/channels/incidents"
      unreadByChannel={{
        architecture: 3,
        deploys: 11,
        wiki: 1,
        incidents: 47,
      }}
    >
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar />
        <MockContent title="#incidents" />
      </div>
    </SidebarContext>
  ),
};

// The office's own bots, then the terminal sessions found on this Mac in
// their own group: one working, one waiting on you, one whose window closed.
const MEMBERS_WITH_SESSIONS: OfficeMember[] = [
  {
    slug: "cos",
    name: "Chief of Staff",
    role: "lead",
    status: "idle",
    online: true,
    origin: "built_in",
    runtime: {
      harness: "claude-code",
      harness_name: "Claude Code",
      model: "claude-opus-5-5",
      model_label: "Opus 5.5",
      family: "claude",
      source: "default",
    },
  },
  {
    slug: "atlas",
    name: "Atlas",
    role: "engineer",
    status: "active",
    task: "writing migration plan",
    online: true,
    origin: "user",
    runtime: {
      harness: "claude-code",
      harness_name: "Claude Code",
      model: "claude-sonnet-5-5",
      model_label: "Sonnet 5.5",
      family: "claude",
      source: "observed",
    },
  },
  {
    slug: "cc-1a2b3c4d",
    name: "Fix the flaky checkout test",
    role: "Claude Code session in shop",
    status: "active",
    task: "Working",
    origin: "session",
    runs_on: "this_machine",
    runs_on_detail: "Claude Code on this machine",
    runtime: {
      harness: "claude-code",
      harness_name: "Claude Code",
      model: "claude-opus-5-5",
      model_label: "Opus 5.5",
      family: "claude",
      source: "observed",
    },
    session: {
      tool: "claude-code",
      project: "shop",
      cwd: "/Users/me/shop",
      state: "working",
      live: true,
    },
  },
  {
    slug: "cx-0199f3aa",
    name: "Tidy the migration scripts before the long weekend release",
    role: "Codex CLI session in api",
    status: "idle",
    task: "Your turn",
    origin: "session",
    runs_on: "this_machine",
    runs_on_detail: "Codex CLI on this machine",
    runtime: {
      harness: "codex",
      harness_name: "Codex CLI",
      model: "gpt-6-astra",
      model_label: "GPT-6 Astra",
      family: "gpt",
      source: "observed",
    },
    session: {
      tool: "codex",
      project: "api",
      cwd: "/Users/me/api",
      state: "your_turn",
      last_said: "Shall I run them on staging?",
      live: true,
    },
  },
  {
    slug: "cc-9f8e7d6c",
    name: "Draft the release notes",
    role: "Claude Code session in docs",
    status: "idle",
    origin: "session",
    runs_on: "this_machine",
    runs_on_detail: "Claude Code on this machine",
    runtime: { harness: "claude-code", harness_name: "Claude Code" },
    session: { tool: "claude-code", project: "docs", live: false },
  },
];

// In the app OfficeBotRuntimeProvider feeds every avatar its model badge
// from the roster. The story does the same from its seeded members.
const runtimeOfSeededMember = (slug: string): BotRuntime | undefined =>
  MEMBERS_WITH_SESSIONS.find((m) => m.slug === slug)?.runtime;

export const WithSessionsOnThisMac: StoryObj = {
  name: "With sessions on this Mac",
  render: () => (
    <SidebarContext
      initialUrl="/channels/architecture"
      members={MEMBERS_WITH_SESSIONS}
    >
      <BotRuntimeContext.Provider value={runtimeOfSeededMember}>
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <Sidebar />
          <MockContent title="#architecture" />
        </div>
      </BotRuntimeContext.Provider>
    </SidebarContext>
  ),
};
