/**
 * BotSubspace — tabbed per-bot view with 8 tabs:
 *   Chat · Computer · Tasks · Skills · Knowledge · Policies · Live Stream · Config
 *
 * The shell header (avatar + editable name + role + status + current-task chip
 * + "Teach a workflow") is persistent across all tabs. Tab content is
 * mounted/unmounted on switch; the active tab uses stable keys to prevent
 * unnecessary remounts.
 *
 * "Teach a workflow" lives in the header rather than in its own tab because it
 * is an action, not a section: it opens a screenshare, runs once, and hands the
 * result to the Chat tab. Being in the header also makes it reachable from
 * every tab and, since this header is the one per-bot surface, from every
 * bot without exception.
 *
 * Knowledge IS a section, so it is a tab. It holds what this bot knows — the
 * pages in its own notebook — and the gate that promotes one of them into the
 * shared team wiki. It sits next to Skills because both answer "what does this
 * bot bring", and it is per-bot for the same reason the other tabs are:
 * knowledge belongs to whoever learned it.
 */

import { useCallback, useState } from "react";
import { Eye } from "iconoir-react";

import type { OfficeMember } from "../../api/client";
import { useDefaultHarness } from "../../hooks/useConfig";
import { resolveHarness } from "../../lib/harness";
import { router } from "../../lib/router";
import { BotKnowledgePanel } from "../knowledge/BotKnowledgePanel";
import { HarnessBadge } from "../ui/HarnessBadge";
import { PixelAvatar } from "../ui/PixelAvatar";
import { EditableName } from "./BotProfilePanel";
import { TeachWorkflowModal } from "./TeachWorkflowModal";
import { ChatTab } from "./tabs/ChatTab";
import { ComputerTab } from "./tabs/ComputerTab";
import { ConfigTab } from "./tabs/ConfigTab";
import { LiveStreamTab } from "./tabs/LiveStreamTab";
import { PoliciesTab } from "./tabs/PoliciesTab";
import { SkillsTab } from "./tabs/SkillsTab";
import { TasksTab } from "./tabs/TasksTab";

// ── Tab definitions ─────────────────────────────────────────────

export type BotTab =
  | "chat"
  | "computer"
  | "tasks"
  | "skills"
  | "knowledge"
  | "policies"
  | "live-stream"
  | "config";

export const AGENT_TABS: Array<{ id: BotTab; label: string }> = [
  { id: "chat", label: "Chat" },
  // Right after Chat: watching the bot work is the second thing a gawker
  // reaches for, and the screen is where a mid-turn "needs hands" lands.
  { id: "computer", label: "Computer" },
  { id: "tasks", label: "Tasks" },
  { id: "skills", label: "Skills" },
  { id: "knowledge", label: "Knowledge" },
  { id: "policies", label: "Policies" },
  { id: "live-stream", label: "Live Stream" },
  { id: "config", label: "Config" },
];

// ── Props ────────────────────────────────────────────────────────

interface BotSubspaceProps {
  agent: OfficeMember;
  tab: string;
}

function isBotTab(value: string): value is BotTab {
  return AGENT_TABS.some((t) => t.id === value);
}

// Friendly aliases for tab slugs people are likely to type/guess in the URL
// so they land on the right tab instead of silently falling back to Chat.
const TAB_ALIASES: Record<string, BotTab> = {
  live: "live-stream",
  stream: "live-stream",
  livestream: "live-stream",
  settings: "config",
  task: "tasks",
  skill: "skills",
  policy: "policies",
  screen: "computer",
  desktop: "computer",
  vm: "computer",
  // Knowledge used to be an app tab and is now per-bot, so the words people
  // reach for from the old surface (and from the wiki) land on it.
  wiki: "knowledge",
  notes: "knowledge",
  notebook: "knowledge",
};

function resolveTab(raw: string): BotTab {
  if (isBotTab(raw)) return raw;
  return TAB_ALIASES[raw.toLowerCase()] ?? "chat";
}

// ── Shell header ─────────────────────────────────────────────────

interface ShellHeaderProps {
  agent: OfficeMember;
  onTeachWorkflow: () => void;
}

function ShellHeader({ agent, onTeachWorkflow }: ShellHeaderProps) {
  const defaultHarness = useDefaultHarness();
  const harness = resolveHarness(agent.provider, defaultHarness);
  const statusClass = agent.status === "active" ? "active pulse" : "lurking";

  return (
    <div className="bot-subspace-header">
      <div className="bot-subspace-header-identity">
        {/* Large pixel avatar with harness badge */}
        <div className="bot-subspace-header-avatar avatar-with-harness">
          <PixelAvatar slug={agent.slug} size={48} />
          <HarnessBadge
            kind={harness}
            size={16}
            className="harness-badge-on-avatar"
          />
        </div>

        {/* Name + role + status */}
        <div className="bot-subspace-header-meta">
          <div className="bot-subspace-header-name-row">
            <EditableName agent={agent} />
            <span
              className={`status-dot ${statusClass}`}
              title={agent.status === "active" ? "Active" : "Idle"}
              aria-hidden="true"
            />
          </div>
          {agent.role ? (
            <div className="bot-subspace-header-role">{agent.role}</div>
          ) : null}
          <div className="bot-subspace-header-status-row">
            {agent.status === "active" ? (
              <span className="bot-subspace-status-badge bot-subspace-status-badge--active">
                Working
              </span>
            ) : (
              <span className="bot-subspace-status-badge bot-subspace-status-badge--idle">
                Idle
              </span>
            )}
            {agent.task && agent.status === "active" ? (
              <span className="bot-subspace-task-chip" title={agent.task}>
                {agent.task}
              </span>
            ) : null}
          </div>
        </div>

        {/* Show it once. It will do it from now on. */}
        <button
          type="button"
          className="btn bot-subspace-teach-btn"
          onClick={onTeachWorkflow}
          data-testid="teach-workflow-btn"
          title={`Show ${agent.name || agent.slug} a workflow on a screenshare`}
        >
          <Eye width={14} height={14} aria-hidden="true" />
          Teach a workflow
        </button>
      </div>
    </div>
  );
}

// ── Tab bar ──────────────────────────────────────────────────────

interface TabBarProps {
  agentSlug: string;
  activeTab: BotTab;
}

function TabBar({ agentSlug, activeTab }: TabBarProps) {
  const navigate = useCallback(
    (tab: BotTab) => {
      void router.navigate({
        to: "/agents/$agentSlug/$tab",
        params: { agentSlug, tab },
      });
    },
    [agentSlug],
  );

  return (
    <div
      className="bot-subspace-tabbar"
      role="tablist"
      aria-label="Bot sections"
    >
      {AGENT_TABS.map((t) => {
        const isActive = t.id === activeTab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`bot-tab-${t.id}`}
            aria-selected={isActive}
            aria-controls={`bot-tabpanel-${t.id}`}
            className={`bot-subspace-tab${isActive ? " is-active" : ""}`}
            onClick={() => navigate(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Content dispatch ─────────────────────────────────────────────

function TabContent({ agent, tab }: { agent: OfficeMember; tab: BotTab }) {
  // Each case renders into a stable panel. The `key` on each component ensures
  // the chat/stream don't remount when parent re-renders (slug is stable).
  switch (tab) {
    case "chat":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-chat"
          aria-labelledby="bot-tab-chat"
          className="bot-subspace-panel"
        >
          <ChatTab key={`chat-${agent.slug}`} agent={agent} />
        </div>
      );
    case "computer":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-computer"
          aria-labelledby="bot-tab-computer"
          className="bot-subspace-panel"
        >
          <ComputerTab key={`computer-${agent.slug}`} agent={agent} />
        </div>
      );
    case "tasks":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-tasks"
          aria-labelledby="bot-tab-tasks"
          className="bot-subspace-panel"
        >
          <TasksTab key={`tasks-${agent.slug}`} agentSlug={agent.slug} />
        </div>
      );
    case "skills":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-skills"
          aria-labelledby="bot-tab-skills"
          className="bot-subspace-panel"
        >
          <SkillsTab key={`skills-${agent.slug}`} agentSlug={agent.slug} />
        </div>
      );
    case "knowledge":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-knowledge"
          aria-labelledby="bot-tab-knowledge"
          className="bot-subspace-panel"
        >
          <BotKnowledgePanel
            key={`knowledge-${agent.slug}`}
            agentSlug={agent.slug}
          />
        </div>
      );
    case "policies":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-policies"
          aria-labelledby="bot-tab-policies"
          className="bot-subspace-panel"
        >
          <PoliciesTab key={`policies-${agent.slug}`} agentSlug={agent.slug} />
        </div>
      );
    case "live-stream":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-live-stream"
          aria-labelledby="bot-tab-live-stream"
          className="bot-subspace-panel"
        >
          <LiveStreamTab
            key={`live-stream-${agent.slug}`}
            agentSlug={agent.slug}
          />
        </div>
      );
    case "config":
      return (
        <div
          role="tabpanel"
          id="bot-tabpanel-config"
          aria-labelledby="bot-tab-config"
          className="bot-subspace-panel"
        >
          <ConfigTab key={`config-${agent.slug}`} agent={agent} />
        </div>
      );
    default: {
      const _exhaustive: never = tab;
      void _exhaustive;
      return null;
    }
  }
}

// ── Main export ──────────────────────────────────────────────────

export function BotSubspace({ agent, tab }: BotSubspaceProps) {
  const activeTab = resolveTab(tab);
  const [teaching, setTeaching] = useState(false);

  return (
    <div
      className="bot-subspace"
      data-testid="bot-subspace"
      data-bot-slug={agent.slug}
    >
      <ShellHeader agent={agent} onTeachWorkflow={() => setTeaching(true)} />
      <TabBar agentSlug={agent.slug} activeTab={activeTab} />
      <TabContent agent={agent} tab={activeTab} />
      <TeachWorkflowModal
        agentSlug={agent.slug}
        agentName={agent.name}
        open={teaching}
        onClose={() => setTeaching(false)}
        // The taught workflow lands as a message in the bot's DM, so send the
        // operator to the tab where the bot's answer will appear.
        onSent={() => {
          void router.navigate({
            to: "/agents/$agentSlug/$tab",
            params: { agentSlug: agent.slug, tab: "chat" },
          });
        }}
      />
    </div>
  );
}
