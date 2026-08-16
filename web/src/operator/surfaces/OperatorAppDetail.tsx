// OperatorAppDetail — the detail view for a REAL built app (id `app_…`). It
// keeps the operator App's tab model (UI / Routines / Tools / Data / Knowledge /
// Integrations); the UI tab renders the agent's ONE live app inside the shipped
// hardened sandbox (CustomAppFrame + Bridge v2), with the artifacts its runs
// produced (md/html/pdf) collected below the app.

import { useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronsLeft,
  ChevronsRight,
  Maximize2,
  Minimize2,
  Pencil,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import type { CustomApp, CustomAppDetail } from "../../api/apps";
import { get } from "../../api/client";
import { AppLivePreview } from "../../components/apps/AppLivePreview";
import { CustomAppFrame } from "../../components/apps/CustomAppFrame";
import { PixelAvatar } from "../../components/ui/PixelAvatar";
import { AgentName } from "../agents/AgentName";
import { AgentPurpose } from "../agents/AgentPurpose";
import { AgentSessions } from "../agents/AgentSessions";
import { tryListArtifacts } from "../agents/agentStateClient";
import {
  appBuildState,
  useDeleteApp,
  useOperatorApp,
} from "../apps/useOperatorApps";
import { ArtifactsTab } from "../artifacts/ArtifactsTab";
import type { Artifact } from "../artifacts/artifacts";
import { AppIntegrationBanner } from "../components/AppIntegrationBanner";
import { EmptyState } from "../components/EmptyState";
import { Eyebrow, type TabDef, Tabs } from "../components/primitives";
import { RoutinesTab } from "../routines/RoutinesTab";
import { ToolsProvider } from "../tools/toolsContext";
import { AppDataTab } from "./AppDataTab";
import { AppToolsTab } from "./AppToolsTab";
import { KnowledgeSurface } from "./KnowledgeSurface";
import { ToolIntegrations } from "./ToolIntegrations";

type PanelSize = "dock" | "wide" | "modal";

type AppTab =
  | "ui"
  | "workflow"
  | "tools"
  | "data"
  | "integrations"
  | "knowledge";

const TABS: readonly TabDef<AppTab>[] = [
  { id: "ui", label: "UI" },
  { id: "workflow", label: "Routines" },
  // Tools: the callable tools Nex builds from taught workflows; the app's chat
  // calls them. Additive — the Workflow tab is unchanged.
  { id: "tools", label: "Tools" },
  { id: "data", label: "Data" },
  { id: "knowledge", label: "Knowledge" },
  { id: "integrations", label: "Integrations" },
];

interface OperatorAppDetailProps {
  appId: string;
  onBack: () => void;
  /**
   * Build mode: once the app publishes, walk the tabs UI → Workflow → Data →
   * Knowledge so the operator sees each part get hooked up, then settle back on
   * the UI. Used by the build experience; a manual tab click cancels the walk.
   */
  buildWalk?: boolean;
  /**
   * Opens the app-EDIT chat (AppBuilderChat in editApp mode → the broker's
   * improve path, which republishes a new version). This is deliberately a
   * SEPARATE affordance from Ask Agent: Ask Agent teaches/runs the agent's
   * tools, and a UI change or bug report sent there would be misauthored as
   * a tool. Absent in the build experience (the build chat is already docked).
   */
  onEditApp?: (app: { id: string; name: string }) => void;
}

export function OperatorAppDetail({
  appId,
  onBack,
  buildWalk,
  onEditApp,
}: OperatorAppDetailProps) {
  const [tab, setTab] = useState<AppTab>("ui");
  const [chatOpen, setChatOpen] = useState(false);
  // A routine's "Open its chat" jumps the Ask Agent dock to that session.
  const [requestedSession, setRequestedSession] = useState<string | null>(null);
  const [panelSize, setPanelSize] = useState<PanelSize>("dock");
  const query = useOperatorApp(appId);
  const remove = useDeleteApp();

  const detail = query.data;
  const app = detail?.app;
  // No app record yet means UNKNOWN, not "Building" — an erroring detail
  // query must not stamp a confident build state (2026-08-16 audit).
  const state = app ? appBuildState(app) : null;
  const failed = state === "failed";
  const ready = state === "ready" && !!detail?.html;

  // Deterministic refresh while the app builds. useOperatorApp's own
  // refetchInterval has been observed not to tick (same failure family as the
  // build chat's poll — see AppBuilderChat), leaving the header stuck on
  // "Building · v0" after the broker published. Explicit invalidation is
  // immune to observer bookkeeping.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (ready || failed) return;
    const tick = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["operator-app", appId] });
      void queryClient.invalidateQueries({ queryKey: ["operator-apps"] });
    }, 3000);
    return () => window.clearInterval(tick);
  }, [ready, failed, appId, queryClient]);

  // The agent's persisted artifacts (routine outcomes) from the agent service,
  // collected below the live app on the UI tab. Refreshed each time the UI tab
  // becomes active; stays empty when the service is unreachable.
  const [remoteArtifacts, setRemoteArtifacts] = useState<Artifact[]>([]);
  const agentId = app?.id;
  useEffect(() => {
    if (tab !== "ui" || !agentId) return;
    let cancelled = false;
    void tryListArtifacts(agentId).then((wire) => {
      if (cancelled || !wire) return;
      setRemoteArtifacts(
        wire.map(({ id, type, title, producedBy, at, content, url, size }) => ({
          id,
          type,
          title,
          producedBy,
          at,
          content,
          url,
          size,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [tab, agentId]);

  // Guided reveal: when the app finishes building, walk through the tabs once so
  // the operator sees the workflow, data, and knowledge get hooked up.
  const walkedRef = useRef(false);
  const walkTimersRef = useRef<number[]>([]);
  // One caption line under the tabs narrating the walk, so the auto-advance
  // reads as a guided tour instead of the UI flipping between empty states.
  const [walkNote, setWalkNote] = useState<string | null>(null);
  useEffect(() => {
    if (!(buildWalk && ready) || walkedRef.current) return;
    walkedRef.current = true;
    walkTimersRef.current = [
      window.setTimeout(() => {
        setTab("workflow");
        setWalkNote("Its routines: the schedule it runs your workflow on.");
      }, 900),
      window.setTimeout(() => {
        setTab("data");
        setWalkNote("Its own database. It fills up as it works.");
      }, 3200),
      window.setTimeout(() => {
        setTab("knowledge");
        setWalkNote("What it learns, written down with citations.");
      }, 5500),
      window.setTimeout(() => {
        setTab("ui");
        setWalkNote(null);
      }, 8000),
    ];
    return () => {
      walkTimersRef.current.forEach((t) => window.clearTimeout(t));
      // A mid-walk unmount must not resurrect a stale caption on re-entry.
      setWalkNote(null);
    };
  }, [buildWalk, ready]);

  // A manual tab click cancels the walk (the documented contract) — the tour
  // must never yank the operator off a tab they chose.
  function selectTab(next: AppTab) {
    walkTimersRef.current.forEach((t) => window.clearTimeout(t));
    walkTimersRef.current = [];
    setWalkNote(null);
    setTab(next);
  }

  function removeAndBack() {
    if (!app) return;
    remove.mutate(app.id, { onSuccess: onBack });
  }

  return (
    // Key the provider on the loaded identity: it mounts before the app query
    // resolves, so remount once the real agent arrives instead of keeping
    // tools/purpose state seeded from the "This app" placeholder.
    <ToolsProvider
      key={app?.id ?? "loading"}
      appName={app?.name ?? "This app"}
      agentId={app?.id}
    >
      <div
        className={`opr-detail-wrap${
          chatOpen && panelSize !== "modal" ? ` is-chat-${panelSize}` : ""
        }`}
      >
        <div className="opr-surface-wide opr-app-detail">
          <button type="button" className="opr-back" onClick={onBack}>
            <ArrowLeft size={13} strokeWidth={1.9} aria-hidden={true} />
            All agents
          </button>

          <div className="opr-detail-head">
            <span
              className="opr-tool-emoji opr-portrait-frame"
              title={app?.icon || undefined}
              aria-hidden={true}
            >
              <PixelAvatar slug={appId} size={34} />
            </span>
            <div className="opr-detail-titles">
              <div className="opr-detail-name">
                {app ? (
                  <AgentName id={app.id} fallback={app.name} />
                ) : (
                  "Loading agent…"
                )}
              </div>
              <div className="opr-tool-meta">
                <span
                  className={`opr-pill ${failed ? "opr-pill-bad" : "opr-pill-muted"}`}
                >
                  <span
                    className={`opr-led ${
                      failed
                        ? "opr-led-bad"
                        : ready
                          ? "opr-led-live"
                          : "opr-led-draft"
                    }`}
                  />
                  {failed
                    ? "Stopped"
                    : ready
                      ? "Live"
                      : state === "building"
                        ? "Building"
                        : "Loading…"}
                </span>
                {app ? (
                  <span className="opr-meta-dot">v{app.version}</span>
                ) : null}
              </div>
            </div>
            {ready ? (
              <div className="opr-detail-actions">
                {app && onEditApp ? (
                  <button
                    type="button"
                    className="opr-btn opr-btn-sm"
                    onClick={() => onEditApp({ id: app.id, name: app.name })}
                  >
                    <Pencil size={13} strokeWidth={1.9} aria-hidden={true} />
                    Edit app
                  </button>
                ) : null}
                <button
                  type="button"
                  className="opr-btn opr-btn-sm"
                  onClick={() => setChatOpen(true)}
                >
                  <Sparkles size={13} strokeWidth={1.9} aria-hidden={true} />
                  Ask Agent
                </button>
              </div>
            ) : failed ? (
              <div className="opr-detail-actions">
                <button
                  type="button"
                  className="opr-btn opr-btn-sm"
                  onClick={removeAndBack}
                  disabled={remove.isPending}
                >
                  <Trash2 size={13} strokeWidth={1.9} aria-hidden={true} />
                  Remove
                </button>
              </div>
            ) : null}
          </div>

          <AgentPurpose summary={app?.summary} />

          <Tabs tabs={TABS} active={tab} onSelect={selectTab} />
          {walkNote ? (
            <p className="opr-scoped-note" aria-hidden={true}>
              {walkNote}
            </p>
          ) : null}

          <div
            role="tabpanel"
            id={`opr-panel-${tab}`}
            aria-labelledby={`opr-tab-${tab}`}
          >
            {/* The UI tab (hosting the live app frame) stays MOUNTED across
                tab switches — hidden, not unmounted — so returning to it does
                NOT reload the iframe and re-run the app every time. The other
                tabs mount only while active. */}
            <div style={tab === "ui" ? undefined : { display: "none" }}>
              <UiTab
                query={query}
                failed={failed}
                onRemove={removeAndBack}
                removing={remove.isPending}
              />
              {/* The artifacts the agent's runs produced, under its one app. */}
              {remoteArtifacts.length > 0 ? (
                <div className="opr-ui-artifacts">
                  <Eyebrow>Artifacts</Eyebrow>
                  <ArtifactsTab
                    agentName={app?.name ?? "This agent"}
                    artifacts={remoteArtifacts}
                  />
                </div>
              ) : null}
            </div>
            {tab !== "ui" ? (
              <TabBody
                tab={tab}
                appId={appId}
                query={query}
                onOpenRoutineSession={(sessionId) => {
                  setRequestedSession(sessionId);
                  setChatOpen(true);
                }}
                onOpenChat={() => setChatOpen(true)}
              />
            ) : null}
          </div>
        </div>

        {/* Ask AI — floating bubble + docked drawer, openable from any tab.
          During the build experience the build chat is already docked, so the
          floating bubble stays suppressed — but an EXPLICIT open (the header
          button, "Teach a tool in chat", a routine's "Open its chat") must
          still work: those buttons silently no-opped during the walk
          (2026-08-16 audit). */}
        {app && ready && (!buildWalk || chatOpen) ? (
          <AskAiDock
            app={app}
            open={chatOpen}
            size={panelSize}
            onOpenChange={setChatOpen}
            onSizeChange={setPanelSize}
            requestedSessionId={requestedSession}
          />
        ) : null}
      </div>
    </ToolsProvider>
  );
}

// ── Ask AI dock: floating bubble + right-side docked drawer (dock/wide/modal) ──

function AskAiDock({
  app,
  open,
  size,
  onOpenChange,
  onSizeChange,
  requestedSessionId,
}: {
  app: CustomApp;
  open: boolean;
  size: PanelSize;
  onOpenChange: (open: boolean) => void;
  onSizeChange: (next: (s: PanelSize) => PanelSize) => void;
  requestedSessionId?: string | null;
}) {
  const panelRef = useRef<HTMLElement>(null);

  // a11y: close on Escape, move focus into the panel on open, and restore it
  // on close, matching the shell's overlay keyboard grammar (see CallModal).
  // Escape originating inside the chat composer (input/textarea/
  // contentEditable) is left alone: closing unmounts the composer, and a
  // mid-composition Escape must never destroy an un-sent draft.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      onOpenChange(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onOpenChange]);

  if (!open) {
    return (
      <button
        type="button"
        className="opr-ask-fab"
        onClick={() => onOpenChange(true)}
        aria-label={`Ask Agent about ${app.name}`}
      >
        <Sparkles size={16} strokeWidth={2} aria-hidden={true} />
        Ask Agent
      </button>
    );
  }
  return (
    <>
      {size === "modal" ? (
        <button
          type="button"
          className="opr-ask-backdrop"
          aria-label="Close chat"
          onClick={() => onOpenChange(false)}
        />
      ) : null}
      <aside
        ref={panelRef}
        tabIndex={-1}
        className={`opr-ask-panel is-${size}`}
        aria-label={`Ask Agent about ${app.name}`}
      >
        <div className="opr-ask-bar">
          <span className="opr-ask-bar-title">
            <Sparkles size={13} strokeWidth={2} aria-hidden={true} />
            Ask Agent · {app.name}
          </span>
          <div className="opr-ask-bar-controls">
            <button
              type="button"
              className="opr-icon-btn"
              onClick={() =>
                onSizeChange((s) => (s === "wide" ? "dock" : "wide"))
              }
              aria-label={size === "wide" ? "Narrow panel" : "Widen panel"}
              title={size === "wide" ? "Narrow" : "Widen"}
            >
              {size === "wide" ? (
                <ChevronsRight size={15} strokeWidth={1.9} aria-hidden={true} />
              ) : (
                <ChevronsLeft size={15} strokeWidth={1.9} aria-hidden={true} />
              )}
            </button>
            <button
              type="button"
              className="opr-icon-btn"
              onClick={() =>
                onSizeChange((s) => (s === "modal" ? "dock" : "modal"))
              }
              aria-label={size === "modal" ? "Exit full screen" : "Full screen"}
              title={size === "modal" ? "Exit full screen" : "Full screen"}
            >
              {size === "modal" ? (
                <Minimize2 size={14} strokeWidth={1.9} aria-hidden={true} />
              ) : (
                <Maximize2 size={14} strokeWidth={1.9} aria-hidden={true} />
              )}
            </button>
            <button
              type="button"
              className="opr-icon-btn"
              onClick={() => onOpenChange(false)}
              aria-label="Close chat"
              title="Close"
            >
              <X size={15} strokeWidth={1.9} aria-hidden={true} />
            </button>
          </div>
        </div>
        <div className="opr-ask-body">
          <AgentSessions
            agentName={app.name}
            agentId={app.id}
            requestedSessionId={requestedSessionId}
          />
        </div>
      </aside>
    </>
  );
}

function TabBody({
  tab,
  appId,
  query,
  onOpenRoutineSession,
  onOpenChat,
}: {
  tab: AppTab;
  appId: string;
  query: UseQueryResult<CustomAppDetail>;
  onOpenRoutineSession?: (sessionId: string) => void;
  /** Open the Ask Agent dock — the Tools tab's teach affordance. */
  onOpenChat?: () => void;
}) {
  const app = query.data?.app;
  switch (tab) {
    case "workflow":
      return (
        <RoutinesTab
          agentName={app?.name ?? "This agent"}
          agentId={app?.id}
          onOpenSession={(sessionId) => onOpenRoutineSession?.(sessionId)}
        />
      );
    case "tools":
      return (
        <AppToolsTab appName={app?.name ?? "This app"} onTeach={onOpenChat} />
      );
    case "data":
      return app ? (
        <AppDataTab appId={app.id} />
      ) : (
        <EmptyState
          glyph="▦"
          portraitSlug={appId}
          title="No data yet"
          hint="The data this agent reads and writes appears here once it has finished building."
        />
      );
    case "integrations":
      return <AppIntegrationsTab />;
    case "knowledge":
      // The gbrain-backed, Wikipedia-style reader with cited claims — backed by
      // the agent's REAL synthesized pages (grounded in its own artifacts).
      return app ? (
        <KnowledgeSurface appId={app.id} />
      ) : (
        <EmptyState
          glyph="📖"
          portraitSlug={appId}
          title="No knowledge yet"
          hint="Your AI writes cited pages about this agent once it has finished building."
        />
      );
    default:
      return null;
  }
}

// The agent's Integrations tab IS the workspace catalog: connected platforms
// (which this agent can call) plus the connectable rest. The catalog's own
// "Connected" section is the single source — no duplicate chip strip
// (2026-08-15 audit).
function AppIntegrationsTab() {
  return <ToolIntegrations />;
}

function UiTab({
  query,
  failed,
  onRemove,
  removing,
}: {
  query: UseQueryResult<CustomAppDetail>;
  failed: boolean;
  onRemove: () => void;
  removing: boolean;
}) {
  const detail = query.data;
  const app = detail?.app;
  const ready = app && appBuildState(app) === "ready" && detail?.html;
  if (ready) {
    return (
      <div className="opr-app-frame">
        {/* Host-side connect affordance: the sandboxed app can say "no CRM
            connected" but cannot offer the fix — this banner can. */}
        <AppIntegrationBanner app={app} />
        <CustomAppFrame appId={app.id} title={app.name} html={detail.html} />
      </div>
    );
  }
  // Still building, but the app exists: show the LIVE dev-server preview so the
  // UI builds in front of you (HMR reflects the agent's edits) instead of a
  // static placeholder. Reuses the shipped AppLivePreview.
  if (app && !failed) {
    return (
      <div className="opr-app-frame">
        <AppLivePreview appId={app.id} title={app.name} />
      </div>
    );
  }
  if (failed) {
    return (
      <div className="opr-app-building opr-app-failed" role="status">
        <span className="opr-empty-glyph" aria-hidden={true}>
          ⚠
        </span>
        <div className="opr-empty-title">Build failed</div>
        <div className="opr-empty-hint">
          This agent stalled before it published a version — it is not building
          anymore. Remove it and rebuild, or describe it again.
        </div>
        <div className="opr-empty-actions">
          <button
            type="button"
            className="opr-btn opr-btn-primary opr-btn-sm"
            onClick={onRemove}
            disabled={removing}
          >
            <Trash2 size={13} strokeWidth={1.9} aria-hidden={true} />
            Remove agent
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="opr-app-building" role="status">
      <span className="opr-work-dots" aria-hidden={true}>
        <span />
        <span />
        <span />
      </span>
      <div className="opr-empty-title">
        {query.isError ? "Could not load this agent" : "Building your agent…"}
      </div>
      <div className="opr-empty-hint">
        {query.isError
          ? "The workspace may be offline. It will retry automatically."
          : "The live app appears here the moment the first version publishes."}
      </div>
    </div>
  );
}
