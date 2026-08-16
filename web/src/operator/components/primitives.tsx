// Shared visual primitives for the operator shell. Token-driven, presentational
// only — no data fetching. See operator-shell.css for the matching styles.

import { type KeyboardEvent, type ReactNode, useRef } from "react";

import type {
  IntegrationStatus,
  RequestStatus,
  ToolStatus,
} from "../mock/data";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="opr-eyebrow">{children}</div>;
}

// Two-letter monospace sigil derived from a name — the terminal-aesthetic
// stand-in for an icon/emoji (e.g. "Inbound demo-request routing" → "ID").
export function sigil(name: string): string {
  const words = name
    .replace(/[^a-zA-Z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "··";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// ── Fit score chip (the hero signal) ────────────────────────────────────

function scoreTier(score: number): "hot" | "mid" | "low" {
  if (score >= 70) return "hot";
  if (score >= 50) return "mid";
  return "low";
}

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="opr-score opr-score-low">n/a</span>;
  }
  return (
    <span className={`opr-score opr-score-${scoreTier(score)}`}>{score}</span>
  );
}

// ── Request status pill ─────────────────────────────────────────────────

const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: string }> = {
  new: { label: "New", tone: "opr-pill-muted" },
  scored: { label: "Scored", tone: "opr-pill-info" },
  routed: { label: "Routed", tone: "opr-pill-good" },
  nurturing: { label: "Nurturing", tone: "opr-pill-muted" },
  "needs-you": { label: "Needs you", tone: "opr-pill-warn" },
};

export function RequestStatusPill({ status }: { status: RequestStatus }) {
  const s = REQUEST_STATUS[status];
  return <span className={`opr-pill ${s.tone}`}>{s.label}</span>;
}

// ── Tool status (LED + label) ───────────────────────────────────────────

const TOOL_STATUS: Record<ToolStatus, { label: string; led: string }> = {
  enabled: { label: "Enabled", led: "opr-led-live" },
  disabled: { label: "Disabled", led: "opr-led-draft" },
  draft: { label: "Draft", led: "opr-led-draft" },
  suggested: { label: "Suggested", led: "opr-led-suggested" },
};

export function ToolStatusBadge({ status }: { status: ToolStatus }) {
  const s = TOOL_STATUS[status];
  return (
    <span className="opr-pill opr-pill-muted">
      <span className={`opr-led ${s.led}`} />
      {s.label}
    </span>
  );
}

// ── Integration status pill ─────────────────────────────────────────────

const INT_STATUS: Record<IntegrationStatus, { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "opr-pill-good" },
  available: { label: "Available", tone: "opr-pill-muted" },
  "needs-attention": { label: "Needs attention", tone: "opr-pill-warn" },
};

export function IntegrationStatusPill({
  status,
}: {
  status: IntegrationStatus;
}) {
  const s = INT_STATUS[status];
  return <span className={`opr-pill ${s.tone}`}>{s.label}</span>;
}

// ── Tabs ────────────────────────────────────────────────────────────────

export interface TabDef<T extends string> {
  id: T;
  label: string;
}

interface TabsProps<T extends string> {
  tabs: readonly TabDef<T>[];
  active: T;
  onSelect: (id: T) => void;
  hint?: string;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onSelect,
  hint,
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  // Roving tabindex per the ARIA tabs contract: the strip is ONE Tab stop;
  // ArrowLeft/ArrowRight (wrapping) and Home/End move selection and focus.
  // Selection follows focus: every panel renders local data, so switching is
  // free. A stale `active` id falls back to the first tab so the strip never
  // becomes keyboard-unreachable.
  const activeIndex = tabs.findIndex((t) => t.id === active);

  function moveTo(next: TabDef<T> | undefined) {
    if (!next) return;
    onSelect(next.id);
    // Scoped lookup (not document-global): generic ids like "data" would
    // collide if two Tabs instances ever mount at once.
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`opr-tab-${next.id}`)}`)
      ?.focus();
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const from = activeIndex === -1 ? 0 : activeIndex;
      moveTo(tabs[(from + dir + tabs.length) % tabs.length]);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(tabs[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(tabs[tabs.length - 1]);
    }
  }

  return (
    <div className="opr-tabs" role="tablist" ref={listRef}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`opr-tab-${t.id}`}
          aria-controls={`opr-panel-${t.id}`}
          aria-selected={t.id === active}
          tabIndex={t.id === active || (activeIndex === -1 && i === 0) ? 0 : -1}
          className={`opr-tab${t.id === active ? " is-active" : ""}`}
          onClick={() => onSelect(t.id)}
          onKeyDown={onTabKeyDown}
        >
          {t.label}
        </button>
      ))}
      {hint ? <span className="opr-tab-hint">{hint}</span> : null}
    </div>
  );
}

// ── Surface header ──────────────────────────────────────────────────────

interface SurfaceHeaderProps {
  eyebrow: string;
  title: string;
  lede?: string;
  actions?: ReactNode;
}

export function SurfaceHeader({
  eyebrow,
  title,
  lede,
  actions,
}: SurfaceHeaderProps) {
  return (
    <div className="opr-surface-head">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="opr-surface-title">{title}</h1>
        {lede ? <p className="opr-surface-lede">{lede}</p> : null}
      </div>
      {actions ? <div className="opr-detail-actions">{actions}</div> : null}
    </div>
  );
}
