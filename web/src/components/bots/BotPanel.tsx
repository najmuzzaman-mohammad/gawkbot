import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Xmark } from "iconoir-react";

import type { OfficeMember } from "../../api/client";
import { post } from "../../api/client";
import { listBotLogTasks, type TaskLogSummary } from "../../api/tasks";
import { useBotStream } from "../../hooks/useBotStream";
import { useDefaultHarness } from "../../hooks/useConfig";
import { useChannelMembers, useOfficeMembers } from "../../hooks/useMembers";
import { resolveHarness } from "../../lib/harness";
import { router } from "../../lib/router";
import {
  type CurrentRoute,
  useChannelSlug,
  useCurrentRoute,
} from "../../routes/useCurrentRoute";
import { useAppStore } from "../../stores/app";
import { StreamLineView } from "../messages/StreamLineView";
import { confirm } from "../ui/ConfirmDialog";
import { HarnessBadge } from "../ui/HarnessBadge";
import { PixelAvatar } from "../ui/PixelAvatar";
import { showNotice } from "../ui/Toast";
import { BotProfilePanel } from "./BotProfilePanel";

/**
 * Stable identity key for the BotPanel "close on route change" effect.
 * Uses an explicit per-kind key instead of JSON.stringify(route) so
 * adding a new CurrentRoute kind that includes a non-string field can't
 * silently produce an unstable serialization (and the exhaustiveness
 * check forces the maintainer to update this helper).
 */
function routeIdentityKey(route: CurrentRoute): string {
  switch (route.kind) {
    case "channel":
      return `channel:${route.channelSlug}`;
    case "app":
      return `app:${route.appId}`;
    case "task-board":
      return "task-board";
    case "task-detail":
      return `task-detail:${route.taskId}`;
    case "wiki":
      return "wiki";
    case "wiki-article":
      return `wiki-article:${route.articlePath}`;
    case "wiki-lookup":
      return `wiki-lookup:${route.query ?? ""}`;
    case "article":
      return `article:${route.articleId}`;
    case "inbox":
      return "inbox";
    case "task-decision":
      return `task-decision:${route.taskId}`;
    case "task-new":
      return "task-new";
    case "agents":
      return "agents";
    case "bot-detail":
      return `bot-detail:${route.agentSlug}:${route.tab ?? ""}`;
    case "skill-detail":
      return `skill-detail:${route.skillName}`;
    case "routine-detail":
      return `routine-detail:${route.routineSlug}`;
    case "routine-new":
      return "routine-new";
    case "home":
      return "home";
    case "unknown":
      return "unknown";
    default: {
      const _exhaustive: never = route;
      void _exhaustive;
      return "unknown";
    }
  }
}

interface BotPanelViewProps {
  agent: OfficeMember;
  onClose: () => void;
}

function StreamSection({ slug }: { slug: string }) {
  const { lines, connected } = useBotStream(slug);
  const scrollRef = useRef<HTMLDivElement>(null);
  // appendStreamLine merges consecutive raw chunks into the last line's
  // `data` without growing the array, so depending on length alone would
  // freeze the scroll while a model is still streaming text. Track the
  // last line's id+data so coalesced updates retrigger the effect too.
  const lastLine = lines[lines.length - 1];

  // Stick to bottom only when the user is already near it, so scrolling
  // back through history isn't disrupted by every new line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every new line so the log auto-scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 32) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length, lastLine?.id, lastLine?.data]);

  return (
    <div className="bot-panel-section">
      <div className="bot-panel-section-title">Live stream</div>
      <div className="bot-stream-status">
        <span
          className={`status-dot ${connected ? "active pulse" : "lurking"}`}
        />
        {connected ? "Connected" : "Disconnected"}
      </div>
      <div className="bot-stream-log" ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="bot-stream-empty">No output yet</div>
        ) : (
          lines.map((line) => (
            <StreamLineView key={line.id} line={line} compact={true} />
          ))
        )}
      </div>
    </div>
  );
}

function LogsSection({ slug }: { slug: string }) {
  const [tasks, setTasks] = useState<TaskLogSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    listBotLogTasks({ limit: 50 })
      .then((data) => {
        if (!cancelled) {
          const mine = (data.tasks ?? []).filter((t) => t.agentSlug === slug);
          setTasks(mine.slice(0, 10));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  function formatTime(ms: number | undefined): string {
    if (!ms) return "";
    try {
      return new Date(ms).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  return (
    <div className="bot-panel-logs">
      <div className="bot-panel-section">
        <div className="bot-panel-section-title">Recent activity</div>
      </div>
      {loading ? (
        <div className="bot-log-empty">Loading...</div>
      ) : tasks.length === 0 ? (
        <div className="bot-log-empty">No recent activity</div>
      ) : (
        tasks.map((t) => (
          <div key={t.taskId} className="bot-log-item">
            <div className="bot-log-action">
              {t.taskId} {t.hasError ? "\u26a0" : ""}
            </div>
            <div className="bot-log-content">
              {t.toolCallCount} tool call{t.toolCallCount === 1 ? "" : "s"}
            </div>
            <div className="bot-log-time">{formatTime(t.lastToolAt)}</div>
          </div>
        ))
      )}
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: BotPanelView — off-conversation toggle/channel guard added in PR #634; baselined pending the follow-up panel-extraction refactor.
function BotPanelView({ agent, onClose }: BotPanelViewProps) {
  const setActiveBotSlug = useAppStore((s) => s.setActiveBotSlug);
  // Read the URL channel directly — no fallback to "general" or last-visited
  // here. The Enable/disable toggle below would otherwise silently flip the
  // bot's membership in a channel the user isn't actually looking at,
  // which is destructive. Off-conversation routes hide the toggle entirely.
  const currentChannel = useChannelSlug();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"stream" | "logs">("stream");
  const [toggling, setToggling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const defaultHarness = useDefaultHarness();

  // Derive the per-channel enabled state. A bot is "enabled" in the
  // current channel when it appears in /members and is not flagged
  // disabled. useChannelMembers stays disabled when `currentChannel` is
  // null, so this query and the toggle UI below are hidden in lockstep
  // off conversation routes.
  const { data: channelMembers = [] } = useChannelMembers(currentChannel);
  const channelEntry = channelMembers.find((m) => m.slug === agent.slug);
  const enabled = Boolean(channelEntry) && channelEntry?.disabled !== true;

  // All hooks called. Now it is safe to branch on profile mode.
  if (showProfile) {
    return <BotProfilePanel agent={agent} onClose={onClose} />;
  }

  // Broker rejects remove / disable for any `built_in` member (lead bot).
  // Use `!== true` (not `!bot.built_in`) so an absent field isn't silently
  // treated as "removable" — we want explicit permission, not optimistic.
  // Keep the `ceo` literal as legacy fallback for stored rosters that
  // predate the BuiltIn field getting serialized.
  const isLead = agent.built_in === true || agent.slug === "ceo";
  const canRemove = !isLead;
  // The toggle is per-channel; off conversation routes there is no channel
  // to scope the action to, so we hide the toggle entirely rather than
  // dispatch against a stale fallback channel.
  const canToggle = !isLead && currentChannel !== null;

  function handleOpenBot() {
    // Bots are reached via the Bots tool now: navigate to the
    // per-bot config/detail page. Bots are no longer chat surfaces,
    // so there is no DM channel to create.
    void router.navigate({
      to: "/agents/$agentSlug",
      params: { agentSlug: agent.slug },
    });
    setActiveBotSlug(null);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: handleToggleEnabled — existing cognitive complexity is baselined for a focused follow-up refactor.
  async function handleToggleEnabled(next: boolean) {
    // canToggle already gates currentChannel, but re-check here so the
    // post body is provably non-null and TypeScript narrows. The toggle
    // UI is unmounted off conversation routes, so this branch only
    // protects against a future caller wiring this handler somewhere
    // else.
    if (!canToggle || toggling || currentChannel === null) return;
    setToggling(true);
    try {
      // Broker's `enable` action only lifts the Disabled flag — it doesn't
      // add a non-member. Translate to `add` so flipping the toggle ON does
      // what the user expects regardless of prior channel membership.
      const action = next ? (channelEntry ? "enable" : "add") : "disable";
      await post("/channel-members", {
        channel: currentChannel,
        slug: agent.slug,
        action,
      });
      await queryClient.refetchQueries({
        queryKey: ["channel-members", currentChannel],
      });
      await queryClient.invalidateQueries({ queryKey: ["office-members"] });
      showNotice(
        `${agent.name || agent.slug} ${next ? "enabled" : "disabled"}`,
        "success",
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Toggle failed";
      showNotice(message, "error");
    } finally {
      setToggling(false);
    }
  }

  function handleRemove() {
    if (!canRemove) return;
    const label = agent.name || agent.slug;
    confirm({
      title: "Remove bot",
      message: `Remove ${label}? This cannot be undone.`,
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        setRemoving(true);
        try {
          await post("/office-members", { action: "remove", slug: agent.slug });
          await queryClient.invalidateQueries({ queryKey: ["office-members"] });
          // Removing from /office-members affects every channel-members
          // list. Invalidate the whole `channel-members` key so each cached
          // channel refreshes — narrowing this to `currentChannel` would
          // skip refetching when the panel is open off a conversation
          // route, leaving the sidebar showing the removed bot.
          await queryClient.invalidateQueries({
            queryKey: ["channel-members"],
          });
          showNotice(`${label} removed`, "success");
          onClose();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Remove failed";
          showNotice(message, "error");
        } finally {
          setRemoving(false);
        }
      },
    });
  }

  const statusClass = agent.status === "active" ? "active pulse" : "lurking";

  return (
    <div className="bot-panel">
      {/* Header */}
      <div className="bot-panel-header">
        <div className="bot-panel-identity">
          <div className="bot-panel-avatar avatar-with-harness">
            <PixelAvatar
              slug={agent.slug}
              size={36}
              className="pixel-avatar-panel"
            />
            <HarnessBadge
              kind={resolveHarness(agent.provider, defaultHarness)}
              size={18}
              className="harness-badge-on-avatar"
            />
          </div>
          <div
            style={{
              minWidth: 0,
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span className="bot-panel-name">{agent.name || agent.slug}</span>
              <span
                className={`status-dot ${statusClass}`}
                style={{ marginLeft: -2 }}
              />
            </div>
            {agent.role ? (
              <span className="bot-panel-role">{agent.role}</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="bot-panel-close"
          onClick={onClose}
          aria-label="Close bot panel"
        >
          <Xmark width={20} height={20} />
        </button>
      </div>

      {/* Info */}
      <div className="bot-panel-section">
        <div className="bot-panel-info">
          <div className="bot-panel-info-row">
            <span className="bot-panel-info-label">slug</span>
            <span className="bot-panel-info-value">{agent.slug}</span>
          </div>
          {(() => {
            const p = agent.provider;
            const label = typeof p === "string" ? p : p?.kind;
            return label ? (
              <div className="bot-panel-info-row">
                <span className="bot-panel-info-label">provider</span>
                <span className="bot-panel-info-value">{label}</span>
              </div>
            ) : null;
          })()}
          {agent.status ? (
            <div className="bot-panel-info-row">
              <span className="bot-panel-info-label">status</span>
              <span className="bot-panel-info-value">{agent.status}</span>
            </div>
          ) : null}
          {agent.task ? (
            <div className="bot-panel-info-row">
              <span className="bot-panel-info-label">task</span>
              <span className="bot-panel-info-value">{agent.task}</span>
            </div>
          ) : null}
        </div>
      </div>

      {/* Enable/disable — controls whether this bot participates in
          the current conversation channel. Off conversation routes (apps,
          wiki, notebooks, …) `currentChannel` is null so this whole
          section is hidden, since the toggle would otherwise hit the
          broker against a stale fallback channel. */}
      {canToggle && currentChannel ? (
        <div className="bot-panel-section">
          <div className="bot-panel-stat">
            <span className="bot-panel-stat-label">
              Enabled in <strong>#{currentChannel}</strong>
            </span>
            <label
              className="bot-toggle"
              aria-label={`Toggle ${agent.name || agent.slug} in #${currentChannel}`}
            >
              <input
                type="checkbox"
                checked={enabled}
                disabled={toggling}
                onChange={(e) => handleToggleEnabled(e.target.checked)}
              />
              <span className="bot-toggle-slider" />
            </label>
          </div>
        </div>
      ) : null}

      {/* Primary actions */}
      <div className="bot-panel-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleOpenBot}
        >
          Open bot
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setView(view === "logs" ? "stream" : "logs")}
        >
          {view === "logs" ? "Live stream" : "View logs"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowProfile(true)}
          aria-label={`View full profile for ${agent.name || agent.slug}`}
        >
          Profile
        </button>
      </div>

      {/* Destructive — shown only when the broker will accept a remove */}
      {canRemove && (
        <div className="bot-panel-actions-stack">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleRemove}
            disabled={removing}
            style={{ color: "var(--red)" }}
          >
            {removing ? "Removing..." : "Remove bot"}
          </button>
        </div>
      )}

      {/* Stream or Logs */}
      {view === "stream" ? (
        <StreamSection slug={agent.slug} />
      ) : (
        <LogsSection slug={agent.slug} />
      )}
    </div>
  );
}

export function BotPanel() {
  const activeBotSlug = useAppStore((s) => s.activeBotSlug);
  const setActiveBotSlug = useAppStore((s) => s.setActiveBotSlug);
  const route = useCurrentRoute();
  const { data: members = [] } = useOfficeMembers();
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setActiveBotSlug(null), [setActiveBotSlug]);

  // Close when the user navigates to a different surface. The intent is
  // "nav away from the bot panel" — driven by route changes, NOT by
  // activeBotSlug itself (which would close on every open). The
  // identity key is per-kind explicit (not JSON-stringified) so adding
  // a non-string field to CurrentRoute can't silently produce a churning
  // serialization that closes the panel mid-interaction.
  const routeKey = routeIdentityKey(route);
  useEffect(() => {
    // routeKey is referenced via the `void` so biome's
    // useExhaustiveDependencies sees it used in-body and accepts the dep.
    // The dep IS the trigger for this effect — re-firing only when the
    // matched route identity changes — so dropping it would break the
    // close-on-navigation contract.
    void routeKey;
    close();
  }, [routeKey, close]);

  // Close on outside click — ignore clicks on sidebar bot items that would
  // just re-open the panel, and ignore clicks inside the panel itself.
  useEffect(() => {
    if (!activeBotSlug) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const panel = panelRef.current;
      if (!(panel && target)) return;
      if (panel.contains(target)) return;
      const el = target as HTMLElement;
      if (el.closest?.("[data-bot-slug]")) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [activeBotSlug, close]);

  if (!activeBotSlug) return null;

  const agent = members.find((m) => m.slug === activeBotSlug);
  if (!agent) return null;

  return (
    <div ref={panelRef} style={{ display: "contents" }}>
      <BotPanelView key={activeBotSlug} agent={agent} onClose={close} />
    </div>
  );
}
