// OperatorAppDetail — the detail view for a REAL built app (id `app_…`). Three
// tabs: UI / Data / Integrations. The UI tab renders the bot's ONE live app
// inside the shipped hardened sandbox (CustomAppFrame + Bridge v2), with the
// artifacts its runs produced (md/html/pdf) collected below the app.
//
// There is no chat on an app. Talking to a bot happens in that bot's DM,
// full stop — an app's one conversational affordance is "Edit app", which posts
// a change request to the App Builder that owns the build.

import { useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";

import "../../styles/app-detail.css";

import type { CustomAppDetail } from "../../api/apps";
import { AppLivePreview } from "../../components/apps/AppLivePreview";
import { CustomAppFrame } from "../../components/apps/CustomAppFrame";
import { navigateToSidebarApp } from "../../lib/sidebarNav";
import {
  appBuildState,
  useDeleteApp,
  useOperatorApp,
} from "../apps/useOperatorApps";
import { ArtifactsTab } from "../artifacts/ArtifactsTab";
import type { Artifact } from "../artifacts/artifacts";
import { BotName } from "../bots/BotName";
import { BotPurpose } from "../bots/BotPurpose";
import { tryListArtifacts } from "../bots/botStateClient";
import { AppIntegrationBanner } from "../components/AppIntegrationBanner";
import { EmptyState } from "../components/EmptyState";
import { Eyebrow, type TabDef, Tabs } from "../components/primitives";
import { AppDataTab } from "./AppDataTab";
import { ToolIntegrations } from "./ToolIntegrations";

type AppTab = "ui" | "data" | "integrations";

const TABS: readonly TabDef<AppTab>[] = [
  { id: "ui", label: "UI" },
  { id: "data", label: "Data" },
  { id: "integrations", label: "Integrations" },
];

interface AppDetailProps {
  appId: string;
  /** Optional: the operator shell passed a back handler; inside the office the
   * sidebar owns navigation, so this is absent and the back button is hidden. */
  onBack?: () => void;
  /**
   * Build mode: once the app publishes, walk from UI to Data and back so the
   * operator sees the app's own database get hooked up. Used by the build
   * experience; a manual tab click cancels the walk.
   */
  buildWalk?: boolean;
  /**
   * Opens the app-EDIT chat (AppBuilderChat in editApp mode → the broker's
   * improve path, which republishes a new version). This is the ONLY way to ask
   * for a change to an app: a UI change or a bug report goes to the bot that
   * builds the app, not to a chat pane on the app itself.
   */
  onEditApp?: (app: { id: string; name: string }) => void;
}

export function AppDetail({
  appId,
  onBack,
  buildWalk,
  onEditApp,
}: AppDetailProps) {
  const [tab, setTab] = useState<AppTab>("ui");
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

  // The bot's persisted artifacts (routine outcomes) from the bot service,
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

  // Guided reveal: when the app finishes building, step over to the Data tab
  // once so the operator sees the app's own database get hooked up, then settle
  // back on the UI.
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
        setTab("data");
        setWalkNote("Its own database. It fills up as it works.");
      }, 900),
      window.setTimeout(() => {
        setTab("ui");
        setWalkNote(null);
      }, 3200),
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
    remove.mutate(app.id, {
      onSuccess: () => (onBack ? onBack() : navigateToSidebarApp("activity")),
    });
  }

  return (
    <div className="opr-detail-wrap">
      <div className="app-detail opr-surface-wide opr-app-detail">
        {onBack ? (
          <button type="button" className="opr-back" onClick={onBack}>
            <ArrowLeft size={13} strokeWidth={1.9} aria-hidden={true} />
            All bots
          </button>
        ) : null}

        <div className="opr-detail-head">
          <div className="opr-detail-titles">
            <div className="opr-detail-name">
              {app ? (
                <BotName id={app.id} fallback={app.name} />
              ) : (
                "Loading app…"
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
          {/* "Edit app" is the app's whole conversational surface: it hands the
              change request to the App Builder that owns this build. */}
          {ready && app && onEditApp ? (
            <div className="opr-detail-actions">
              <button
                type="button"
                className="opr-btn opr-btn-sm"
                onClick={() => onEditApp({ id: app.id, name: app.name })}
              >
                <Pencil size={13} strokeWidth={1.9} aria-hidden={true} />
                Edit app
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

        <BotPurpose summary={app?.summary} />

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
            {/* The artifacts the bot's runs produced, under its one app. */}
            {remoteArtifacts.length > 0 ? (
              <div className="opr-ui-artifacts">
                <Eyebrow>Artifacts</Eyebrow>
                <ArtifactsTab
                  agentName={app?.name ?? "This bot"}
                  artifacts={remoteArtifacts}
                />
              </div>
            ) : null}
          </div>
          {tab !== "ui" ? <TabBody tab={tab} query={query} /> : null}
        </div>
      </div>
    </div>
  );
}

function TabBody({
  tab,
  query,
}: {
  tab: AppTab;
  query: UseQueryResult<CustomAppDetail>;
}) {
  const app = query.data?.app;
  switch (tab) {
    case "data":
      return app ? (
        <AppDataTab appId={app.id} />
      ) : (
        <EmptyState
          glyph="▦"
          title="No data yet"
          hint="The data this app reads and writes appears here once it has finished building."
        />
      );
    case "integrations":
      return <AppIntegrationsTab />;
    default:
      return null;
  }
}

// The bot's Integrations tab IS the workspace catalog: connected platforms
// (which this bot can call) plus the connectable rest. The catalog's own
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
  // UI builds in front of you (HMR reflects the bot's edits) instead of a
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
          This app's build stalled before it published a version — it is not
          building anymore. Remove it and rebuild, or describe it again.
        </div>
        <div className="opr-empty-actions">
          <button
            type="button"
            className="opr-btn opr-btn-primary opr-btn-sm"
            onClick={onRemove}
            disabled={removing}
          >
            <Trash2 size={13} strokeWidth={1.9} aria-hidden={true} />
            Remove app
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
        {query.isError ? "Could not load this app" : "Building your app…"}
      </div>
      <div className="opr-empty-hint">
        {query.isError
          ? "The workspace may be offline. It will retry automatically."
          : "The live app appears here the moment the first version publishes."}
      </div>
    </div>
  );
}
