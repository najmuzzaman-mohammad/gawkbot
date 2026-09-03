import { useMemo, useRef } from "react";

import type { OfficeMember } from "../../api/client";
import { useBotEventPeek } from "../../hooks/useBotEventPeek";
import { useDefaultHarness } from "../../hooks/useConfig";
import { useFirstRunNudge } from "../../hooks/useFirstRunNudge";
import { useOfficeMembers } from "../../hooks/useMembers";
import { useOverflow } from "../../hooks/useOverflow";
import { AVATAR_MODE } from "../../lib/avatarMode";
import { type HarnessKind, resolveHarness } from "../../lib/harness";
import { router } from "../../lib/router";
import { useCurrentRoute } from "../../routes/useCurrentRoute";
import { useAppStore } from "../../stores/app";
import { BotWizard, useBotWizard } from "../bots/BotWizard";
import { HarnessBadge } from "../ui/HarnessBadge";
import { PixelAvatar } from "../ui/PixelAvatar";
import { BotEventPeek } from "./BotEventPeek";
import { BotEventPill, BotEventTickProvider } from "./BotEventPill";

function classifyActivity(member: OfficeMember | undefined) {
  if (!member)
    return { state: "lurking", label: "lurking", dotClass: "lurking" };
  const status = (member.status || "").toLowerCase();
  const activity = (member.task || "").toLowerCase();

  if (
    status === "active" &&
    /tool|code|write|edit|commit|build|deploy|ship|push|run|test/.test(activity)
  )
    return { state: "shipping", label: "shipping", dotClass: "shipping" };
  if (
    status === "active" &&
    /think|plan|queue|review|sync|debug|trace|investigat/.test(activity)
  )
    return { state: "plotting", label: "plotting", dotClass: "plotting" };
  // No `pulse` here on purpose. The bot's EYES now animate while it works,
  // and a pulsing dot beside animating eyes is two clocks for one fact. The
  // dot stays categorical and still; the eyes carry the motion.
  if (status === "active")
    return { state: "talking", label: "talking", dotClass: "active" };
  return { state: "lurking", label: "lurking", dotClass: "lurking" };
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
  defaultHarness: HarnessKind;
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
  defaultHarness,
  onSelect,
}: SidebarBotRowProps) {
  const peek = useBotEventPeek(agent.slug);
  const anchorRef = useRef<HTMLDivElement>(null);
  const ac = classifyActivity(agent);
  const working = isWorking(agent);
  // "On its computer": the desktop is up AND the bot is mid-turn. Both
  // facts are required so an idle bot with a sleeping VM shows nothing.
  const computerReady = useAppStore(
    (s) => s.computerStates[agent.slug]?.state === "ready",
  );
  const onComputer = working && computerReady;
  const harness = resolveHarness(agent.provider, defaultHarness);
  const displayName = agent.name || agent.slug;

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
        title={`${displayName} — ${ac.label}`}
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
          />
          {/* The harness badge is dropped in blob mode. On the old character
              sprite it sat over the body; a blob has no body to spare, so it
              lands on the mark itself and competes with the one status signal
              that has to survive at 24px -- the working dot. In sprite mode it
              behaves exactly as before. */}
          {AVATAR_MODE !== "blob" && (
            <HarnessBadge
              kind={harness}
              size={10}
              className="harness-badge-on-avatar"
            />
          )}
          {/* Top-right of the avatar carries exactly ONE dot, and which one
              depends on the more important fact being true.

              Green means WORKING: the bot is processing right now. That is
              the state a human actually wants to spot in a rail of a dozen
              teammates, so it gets the loud treatment and the position the
              eye lands on.

              The transport-presence dot is the fallback, shown only when the
              bot is reachable but idle. It is deliberately smaller and
              muted rather than green — two green dots on one row would put
              the old ambiguity straight back.

              Both are decorative: the peek card states presence textually
              ("Online" / "Last seen Xm ago") and the row's status dot carries
              activity, so announcing either here would just repeat it. */}
          {working ? (
            <span
              className="working-badge"
              data-testid={`working-badge-${agent.slug}`}
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
          <span className="sidebar-bot-name">{displayName}</span>
          <BotEventPill
            slug={agent.slug}
            agentRole={agent.role}
            fallbackTask={agent.task}
          />
        </div>
        <span className={`status-dot ${ac.dotClass}`} />
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

export function BotList() {
  const { data: members = [] } = useOfficeMembers();
  const route = useCurrentRoute();
  // The active sidebar row matches the bot-detail page (/bots/$slug)
  // so the highlight tracks the per-bot config surface.
  const activeBotSlug = route.kind === "bot-detail" ? route.agentSlug : null;
  const wizard = useBotWizard();
  const overflowRef = useOverflow<HTMLDivElement>();
  const defaultHarness = useDefaultHarness();
  const { showNudge } = useFirstRunNudge();
  const isReconnecting = useAppStore((s) => s.isReconnecting);

  const agents = members.filter((m) => m.slug && m.slug !== "human");
  // v3 MVP — split CEO out of the flat bot list so the sidebar can
  // render it as the orchestrator with specialists listed beneath. The
  // CEO is always rendered first (even if missing — we render a slot so
  // the org chart stays stable), specialists keep the broker's order.
  const ceo = useMemo(() => agents.find((a) => a.slug === "ceo"), [agents]);
  const specialists = useMemo(
    () => agents.filter((a) => a.slug !== "ceo"),
    [agents],
  );
  const orderedBots = useMemo<typeof agents>(
    () => (ceo ? [ceo, ...specialists] : specialists),
    [ceo, specialists],
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
              {ceo ? (
                <div className="sidebar-bot-group sidebar-bot-group--ceo">
                  <div className="sidebar-bot-rank-label">Orchestrator</div>
                  <SidebarBotRow
                    agent={ceo}
                    isDMActive={activeBotSlug === ceo.slug}
                    isFirst={ceo.slug === firstBotSlug}
                    showNudge={showNudge}
                    defaultHarness={defaultHarness}
                    onSelect={handleSelect}
                  />
                </div>
              ) : null}
              {specialists.length > 0 ? (
                <div className="sidebar-bot-group sidebar-bot-group--specialists">
                  <div className="sidebar-bot-rank-label">
                    {ceo ? "Reports to @ceo" : "Specialists"}
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
                          defaultHarness={defaultHarness}
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
