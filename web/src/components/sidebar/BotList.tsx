import { useMemo, useRef } from "react";

import type { OfficeMember } from "../../api/client";
import { useBotEventPeek } from "../../hooks/useBotEventPeek";
import { useFirstRunNudge } from "../../hooks/useFirstRunNudge";
import { useOfficeMembers } from "../../hooks/useMembers";
import { useOverflow } from "../../hooks/useOverflow";
import { botDot, botDotClass } from "../../lib/botDot";
import { router } from "../../lib/router";
import {
  isSessionMember,
  sessionProject,
  sessionStatusLabel,
} from "../../lib/sessionMember";
import { useCurrentRoute } from "../../routes/useCurrentRoute";
import { useAppStore } from "../../stores/app";
import { BotWizard, useBotWizard } from "../bots/BotWizard";
import { PixelAvatar } from "../ui/PixelAvatar";
import { BotEventPeek } from "./BotEventPeek";
import { BotEventPill, BotEventTickProvider } from "./BotEventPill";

/** The word in a row's tooltip for what the bot is up to. */
function activityLabel(member: OfficeMember | undefined): string {
  if ((member?.status || "").toLowerCase() !== "active") return "lurking";
  const activity = (member?.task || "").toLowerCase();
  if (
    /tool|code|write|edit|commit|build|deploy|ship|push|run|test/.test(activity)
  )
    return "shipping";
  if (/think|plan|queue|review|sync|debug|trace|investigat/.test(activity))
    return "plotting";
  return "talking";
}

/**
 * "Working" means processing right now, derived from `status`. It is NOT
 * `online`, which only says an adapter session is reachable. The two were
 * conflated in the UI before: both rendered as a green dot, and the louder of
 * the two meant the less useful thing.
 */
function isWorking(member: OfficeMember): boolean {
  return (member.status || "").toLowerCase() === "active";
}

interface SidebarBotRowProps {
  agent: OfficeMember;
  isDMActive: boolean;
  isFirst: boolean;
  showNudge: boolean;
  onSelect: (slug: string) => void;
}

/**
 * Row body extracted into its own component so the per-row hook
 * (`useBotEventPeek`) is called once per row instead of inside a `.map`
 * loop in the parent — React forbids hooks in loops directly.
 */
function SidebarBotRow({
  agent,
  isDMActive,
  isFirst,
  showNudge,
  onSelect,
}: SidebarBotRowProps) {
  const peek = useBotEventPeek(agent.slug);
  const anchorRef = useRef<HTMLDivElement>(null);
  const working = isWorking(agent);
  const dot = botDot(agent);
  // "On its computer": the desktop is up AND the bot is mid-turn. Both
  // facts are required so an idle bot with a sleeping VM shows nothing.
  const computerReady = useAppStore(
    (s) => s.computerStates[agent.slug]?.state === "ready",
  );
  const onComputer = working && computerReady;
  const displayName = agent.name || agent.slug;
  // A session row also says which folder it is working in: four sessions of
  // the same tool are otherwise told apart by their titles alone.
  const isSession = isSessionMember(agent);
  const project = isSession ? sessionProject(agent) : "";
  // Its status comes from the session alone. The event pill falls back to
  // the office's idle copy ("clearing something small"), which would invent
  // an activity for a session that is waiting or closed.
  const sessionStatus = isSession ? sessionStatusLabel(agent) : "";

  return (
    <div
      className="sidebar-bot-row"
      ref={anchorRef}
      {...peek.hoverHandlers}
      {...peek.longPressHandlers}
    >
      <button
        type="button"
        className={`sidebar-agent${isDMActive ? " active" : ""}`}
        title={`${displayName} — ${activityLabel(agent)}`}
        onClick={() => {
          // Tier 3 escalation: "quick activation always wins" per the plan.
          // Close any open Tier 2 peek so the workspace is the only surface
          // visible after the tap, instead of two competing per-bot UIs.
          peek.close();
          onSelect(agent.slug);
        }}
        data-bot-slug={agent.slug}
      >
        <span className="sidebar-bot-avatar avatar-with-harness">
          <PixelAvatar
            slug={agent.slug}
            size={24}
            className="pixel-avatar-sidebar"
            working={working}
            avatar={agent.avatar}
          />
          {/* Top-right of the avatar carries exactly ONE dot, and which one
              depends on the more important fact being true.

              Pulsing orange means WORKING: the bot is processing now. That is
              the state a human actually wants to spot in a rail of a dozen
              teammates, so it gets the loud treatment and the position the
              eye lands on.

              The transport-presence dot is the fallback, shown only when the
              bot is reachable but idle. It is deliberately smaller and
              muted, so being reachable never reads as working.

              Both are decorative: the peek card states presence textually
              ("Online" / "Last seen Xm ago") and the row's status dot carries
              activity, so announcing either here would just repeat it. */}
          {dot === "working" ? (
            <span
              className="working-badge"
              data-testid={`working-badge-${agent.slug}`}
              aria-hidden="true"
            />
          ) : dot === "finished" ? (
            <span
              className="finished-badge"
              data-testid={`finished-badge-${agent.slug}`}
              aria-hidden="true"
            />
          ) : agent.online ? (
            <span
              className="online-badge"
              data-testid={`online-badge-${agent.slug}`}
              aria-hidden="true"
            />
          ) : null}
        </span>
        <div className="sidebar-bot-wrap">
          <span className="sidebar-bot-title">
            <span className="sidebar-bot-name">{displayName}</span>
            {isSession ? <SessionMark agent={agent} /> : null}
          </span>
          {project ? (
            <span
              className="sidebar-bot-task"
              data-testid={`session-project-${agent.slug}`}
            >
              {project}
            </span>
          ) : null}
          {isSession ? (
            <span
              className="sidebar-bot-pill"
              data-state={sessionStatus === "Working" ? "holding" : "dim"}
              data-testid={`session-status-${agent.slug}`}
            >
              {sessionStatus}
            </span>
          ) : (
            <BotEventPill
              slug={agent.slug}
              agentRole={agent.role}
              fallbackTask={agent.task}
            />
          )}
        </div>
        <span
          className={`status-dot ${botDotClass(dot)}`}
          data-testid={`status-dot-${agent.slug}`}
        />
      </button>
      {onComputer ? (
        <span
          className="sidebar-bot-computer"
          title={`${displayName} is on its computer`}
          data-testid={`computer-glyph-${agent.slug}`}
          aria-hidden="true"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </svg>
        </span>
      ) : null}
      <button
        type="button"
        className="sidebar-bot-peek-trigger"
        aria-haspopup="dialog"
        aria-expanded={peek.isOpen}
        aria-controls={`bot-peek-${agent.slug}`}
        aria-label={`Recent activity for ${displayName}`}
        onClick={(e) => {
          e.stopPropagation();
          peek.toggle();
        }}
        data-testid={`peek-trigger-${agent.slug}`}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path
            d="M2 1 L6 4 L2 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <BotEventPeek
        slug={agent.slug}
        agentName={displayName}
        agentRole={agent.role}
        open={peek.isOpen}
        current={peek.current}
        history={peek.history}
        anchorRef={anchorRef}
        onClose={peek.close}
        onOpenWorkspace={() => {
          peek.close();
          onSelect(agent.slug);
        }}
        online={agent.online}
        lastSeenAt={agent.last_seen_at}
      />
      {isFirst && showNudge ? (
        <span className="sidebar-bot-nudge" data-testid="first-run-nudge">
          {`→ open a DM with @${agent.slug}`}
        </span>
      ) : null}
    </div>
  );
}

const SESSION_TOOL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** A terminal mark: this bot is a session found on this Mac. */
function SessionMark({ agent }: { agent: OfficeMember }) {
  const tool = agent.session?.tool ?? "";
  const what = `${SESSION_TOOL[tool] ?? "Terminal"} session on this Mac`;
  return (
    <span
      className="sidebar-session-mark"
      role="img"
      aria-label={what}
      title={what}
      data-testid={`session-mark-${agent.slug}`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5" />
      </svg>
    </span>
  );
}

export function BotList() {
  const { data: members = [] } = useOfficeMembers();
  const route = useCurrentRoute();
  // The active sidebar row matches the bot-detail page (/bots/$slug)
  // so the highlight tracks the per-bot config surface.
  const activeBotSlug = route.kind === "bot-detail" ? route.agentSlug : null;
  const wizard = useBotWizard();
  const overflowRef = useOverflow<HTMLDivElement>();
  const { showNudge } = useFirstRunNudge();
  const isReconnecting = useAppStore((s) => s.isReconnecting);

  // Terminal sessions are bots like any other: listed with the office's
  // own, told apart only by the terminal mark on their row.
  const agents = members.filter((m) => m.slug && m.slug !== "human");
  // v3 MVP — split CEO out of the flat bot list so the sidebar can
  // render it as the orchestrator with specialists listed beneath. The
  // CEO is always rendered first (even if missing — we render a slot so
  // the org chart stays stable), specialists keep the broker's order.
  const cos = useMemo(() => agents.find((a) => a.slug === "cos"), [agents]);
  const specialists = useMemo(
    () => agents.filter((a) => a.slug !== "cos"),
    [agents],
  );
  const orderedBots = useMemo<typeof agents>(
    () => (cos ? [cos, ...specialists] : specialists),
    [cos, specialists],
  );
  const firstBotSlug = orderedBots[0]?.slug;

  // v3 MVP — clicking a bot in the sidebar opens its subspace at
  // /bots/$slug. The floating BotPanel popup (driven by the legacy
  // activeBotSlug store value) auto-closes on route change, so we do
  // not need to clear it here.
  const handleSelect = (slug: string) => {
    void router.navigate({
      to: "/agents/$agentSlug",
      params: { agentSlug: slug },
    });
  };

  return (
    <BotEventTickProvider>
      <div className="sidebar-scroll-wrap is-bots">
        <div className="sidebar-agents" ref={overflowRef}>
          {orderedBots.length === 0 ? (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-tertiary)",
                padding: "4px 8px",
              }}
            >
              No bots online
            </div>
          ) : (
            <>
              {cos ? (
                <div className="sidebar-bot-group sidebar-bot-group--ceo">
                  <div className="sidebar-bot-rank-label">Orchestrator</div>
                  <SidebarBotRow
                    agent={cos}
                    isDMActive={activeBotSlug === cos.slug}
                    isFirst={cos.slug === firstBotSlug}
                    showNudge={showNudge}
                    onSelect={handleSelect}
                  />
                </div>
              ) : null}
              {specialists.length > 0 ? (
                <div className="sidebar-bot-group sidebar-bot-group--specialists">
                  <div className="sidebar-bot-rank-label">
                    {cos ? "Reports to @cos" : "Specialists"}
                  </div>
                  <div className="sidebar-bot-rail-tree">
                    {specialists.map((agent) => (
                      <div
                        key={agent.slug}
                        className="sidebar-bot-rail-tree-row"
                      >
                        <span
                          className="sidebar-bot-rail-tree-stem"
                          aria-hidden="true"
                        />
                        <SidebarBotRow
                          agent={agent}
                          isDMActive={activeBotSlug === agent.slug}
                          isFirst={agent.slug === firstBotSlug}
                          showNudge={showNudge}
                          onSelect={handleSelect}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
          <button
            type="button"
            className="sidebar-item sidebar-add-btn"
            onClick={wizard.show}
            title="Create a new bot"
          >
            <span style={{ width: 18, textAlign: "center", flexShrink: 0 }}>
              +
            </span>
            <span>New Bot</span>
          </button>
          {isReconnecting ? (
            <div
              className="sidebar-agents-reconnecting"
              role="status"
              aria-live="polite"
              data-testid="agents-reconnecting"
            >
              Reconnecting…
            </div>
          ) : null}
        </div>
      </div>
      <BotWizard open={wizard.open} onClose={wizard.hide} />
    </BotEventTickProvider>
  );
}
