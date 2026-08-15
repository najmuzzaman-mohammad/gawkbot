// Apps — the list surface. Only REAL built apps (from the shipped app-builder
// backend): a live hero app, then the rest, building, and failed. Selecting an
// app opens OperatorAppDetail. An empty state invites the first build.

import { ArrowRight, PhoneCall, Plus, Trash2 } from "lucide-react";

import type { CustomApp } from "../../api/apps";
import { PixelAvatar } from "../../components/ui/PixelAvatar";
import {
  appBuildState,
  useDeleteApp,
  useOperatorApps,
} from "../apps/useOperatorApps";
import { Eyebrow, SurfaceHeader, sigil } from "../components/primitives";

/** Three faces for the empty roster: the desks you have not filled yet. */
const HIRE_LINEUP = ["pam", "eng", "gtm"] as const;

interface InternalToolsSurfaceProps {
  onOpen: (toolId: string) => void;
  onStartCall: () => void;
  onBuild: () => void;
}

export function InternalToolsSurface({
  onOpen,
  onStartCall,
  onBuild,
}: InternalToolsSurfaceProps) {
  const appsQuery = useOperatorApps();
  const deleteApp = useDeleteApp();
  const apps = appsQuery.data ?? [];
  const ready = apps.filter((a) => appBuildState(a) === "ready");
  const buildingApps = apps.filter((a) => appBuildState(a) === "building");
  const failedApps = apps.filter((a) => appBuildState(a) === "failed");
  const hero = ready[0];
  const rest = ready.slice(1);

  return (
    <div className="opr-surface-wide">
      <SurfaceHeader
        eyebrow="Agents"
        title="Your agents"
        lede="One agent per manual workflow, running it end to end. Build one by describing the job in chat, or by demoing it once on a call."
        actions={
          <div className="opr-header-actions">
            <button
              type="button"
              className="opr-btn opr-btn-primary"
              onClick={onBuild}
            >
              <Plus size={14} strokeWidth={1.9} aria-hidden={true} />
              Build an agent
            </button>
            <button type="button" className="opr-btn" onClick={onStartCall}>
              <PhoneCall size={14} strokeWidth={1.9} aria-hidden={true} />
              Demo a workflow to Nex
            </button>
          </div>
        }
      />

      {hero ? (
        <HeroAppCard app={hero} onOpen={() => onOpen(hero.id)} />
      ) : appsQuery.isLoading ? (
        <p className="opr-scoped-note">Checking who is in today…</p>
      ) : apps.length > 0 ? null : (
        <div className="opr-empty opr-empty-hire">
          <div className="opr-hire-lineup" aria-hidden={true}>
            {HIRE_LINEUP.map((slug) => (
              <span key={slug} className="opr-hire-portrait">
                <PixelAvatar slug={slug} size={44} />
              </span>
            ))}
          </div>
          <div className="opr-empty-title">Nobody works here yet</div>
          <div className="opr-empty-hint">
            Describe a manual workflow — the one you do every Monday at 9:00 —
            and your AI builds the agent that runs it. It shows up here the
            moment it is ready, and it does not need a chair.
          </div>
          <div className="opr-empty-actions">
            <button
              type="button"
              className="opr-btn opr-btn-primary opr-btn-sm"
              onClick={onBuild}
            >
              <Plus size={13} strokeWidth={1.9} aria-hidden={true} />
              Build your first agent
            </button>
          </div>
        </div>
      )}

      {rest.length > 0 || buildingApps.length > 0 || failedApps.length > 0 ? (
        <>
          <div className="opr-section-label">
            <Eyebrow>All agents</Eyebrow>
            <div className="opr-section-rule" />
          </div>
          <div className="opr-grid">
            {rest.map((app) => (
              <AppRow key={app.id} app={app} onOpen={() => onOpen(app.id)} />
            ))}
            {buildingApps.map((app) => (
              <BuildingRow
                key={app.id}
                app={app}
                onOpen={() => onOpen(app.id)}
              />
            ))}
            {failedApps.map((app) => (
              <FailedRow
                key={app.id}
                app={app}
                onRemove={() => deleteApp.mutate(app.id)}
                removing={deleteApp.isPending}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Every agent gets a face. The portrait is derived from the app id, so it is
 *  stable across renames and unique per agent; the emoji an app carries (if
 *  any) rides along as the tile's title text. */
function AgentPortrait({ app, size = 28 }: { app: CustomApp; size?: number }) {
  return (
    <span
      className="opr-tool-emoji opr-portrait-frame"
      title={app.icon?.trim() ? app.icon : sigil(app.name)}
      aria-hidden={true}
    >
      <PixelAvatar slug={app.id} size={size} />
    </span>
  );
}

function HeroAppCard({ app, onOpen }: { app: CustomApp; onOpen: () => void }) {
  return (
    <div
      className="opr-card opr-card-hero"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{ cursor: "pointer", marginBottom: "var(--space-2)" }}
    >
      <div className="opr-detail-head" style={{ marginBottom: 0 }}>
        <AgentPortrait app={app} size={34} />
        <div className="opr-detail-titles">
          <div className="opr-tool-name">{app.name}</div>
          {app.summary ? (
            <p className="opr-tool-summary">{app.summary}</p>
          ) : null}
          <div className="opr-tool-meta">
            <span className="opr-pill opr-pill-muted">
              <span className="opr-led opr-led-live" />
              Live
            </span>
            <span className="opr-meta-dot">v{app.version}</span>
          </div>
        </div>
        <span className="opr-btn opr-btn-sm" aria-hidden={true}>
          Open
          <ArrowRight size={13} strokeWidth={1.9} />
        </span>
      </div>
    </div>
  );
}

function AppRow({ app, onOpen }: { app: CustomApp; onOpen: () => void }) {
  return (
    <div
      className="opr-tool-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <AgentPortrait app={app} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="opr-tool-name" style={{ fontSize: "var(--text-md)" }}>
          {app.name}
        </div>
        {app.summary ? <p className="opr-tool-summary">{app.summary}</p> : null}
      </div>
      <span className="opr-pill opr-pill-muted">
        <span className="opr-led opr-led-live" />v{app.version}
      </span>
    </div>
  );
}

function BuildingRow({ app, onOpen }: { app: CustomApp; onOpen: () => void }) {
  // Clickable while building: opening it shows the live preview of the app being
  // built (OperatorAppDetail handles the building state), not a dead row.
  return (
    <div
      className="opr-tool-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <AgentPortrait app={app} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="opr-tool-name" style={{ fontSize: "var(--text-md)" }}>
          {app.name}
        </div>
        <p className="opr-tool-summary">
          Assembling its screen, routines, and tools — open to watch it happen
        </p>
      </div>
      <span className="opr-pill opr-pill-muted">
        <span className="opr-led opr-led-draft" />
        Building
      </span>
    </div>
  );
}

function FailedRow({
  app,
  onRemove,
  removing,
}: {
  app: CustomApp;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <div className="opr-tool-row opr-tool-row-failed">
      <AgentPortrait app={app} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="opr-tool-name" style={{ fontSize: "var(--text-md)" }}>
          {app.name}
        </div>
        <p className="opr-tool-summary">
          Build failed — it stalled before publishing. Nothing was sent.
        </p>
      </div>
      <span className="opr-pill opr-pill-bad">
        <span className="opr-led opr-led-bad" />
        Failed
      </span>
      <button
        type="button"
        className="opr-icon-btn"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${app.name}`}
        title="Remove"
      >
        <Trash2 size={15} strokeWidth={1.9} aria-hidden={true} />
      </button>
    </div>
  );
}
