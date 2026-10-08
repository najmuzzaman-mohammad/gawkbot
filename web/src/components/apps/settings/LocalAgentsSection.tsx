import type { CSSProperties } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  adoptBlocker,
  adoptLocalAgents,
  canAdoptNow,
  getLocalAgents,
  LOCAL_AGENTS_QUERY_KEY,
  type LocalAgent,
  type LocalAgentAdoptResponse,
  type LocalAgentsResponse,
} from "../../../api/localAgents";
import { showNotice } from "../../ui/Toast";
import { styles } from "./styles";

// ─── Agents on this machine ─────────────────────────────────────────────
//
// Lists every agent CLI the broker found installed or running here (Claude
// Code, Codex, Opencode, Gemini CLI, Aider, Goose, ...) and turns the ones
// gawkbot can drive into office bots that the Chief of Staff manages.

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-card)",
};

const nameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
};

const vendorStyle: CSSProperties = {
  fontWeight: 400,
  color: "var(--text-tertiary)",
};

const metaStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--text-tertiary)",
  lineHeight: 1.5,
  marginTop: 2,
  wordBreak: "break-all",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 6,
};

function chipStyle(tone: "green" | "accent" | "muted"): CSSProperties {
  const palette = {
    green: { background: "var(--green-bg)", color: "var(--green)" },
    accent: { background: "var(--accent-bg)", color: "var(--accent)" },
    muted: { background: "var(--bg-warm)", color: "var(--text-tertiary)" },
  }[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 11,
    fontWeight: 500,
    padding: "2px 8px",
    borderRadius: "var(--radius-full)",
    whiteSpace: "nowrap",
    ...palette,
  };
}

function buttonStyle(primary: boolean, disabled: boolean): CSSProperties {
  return {
    flexShrink: 0,
    height: 30,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "var(--font-sans)",
    borderRadius: "var(--radius-sm)",
    border: primary ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: primary ? "var(--accent)" : "var(--bg-card)",
    color: primary ? "var(--accent-fg)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function runningLabel(agent: LocalAgent): string | null {
  const n = agent.running?.length ?? 0;
  if (n === 0) return null;
  return n === 1 ? "Running" : `Running ×${n}`;
}

function detailLine(agent: LocalAgent): string {
  const cwds = (agent.running ?? [])
    .map((p) => p.cwd)
    .filter((cwd): cwd is string => !!cwd);
  if (cwds.length > 0) {
    return `Working in ${Array.from(new Set(cwds)).join(", ")}`;
  }
  return agent.binary_path || agent.config_path || "";
}

function summarize(result: LocalAgentAdoptResponse, lead: string): string {
  const adopted = result.adopted.map((a) => `@${a.slug}`);
  const skipped = result.skipped ?? [];
  if (adopted.length === 0) {
    return skipped.length > 0
      ? `Nothing adopted: ${skipped.map((s) => `${s.id} — ${s.reason}`).join("; ")}`
      : "Nothing to adopt.";
  }
  const manager = lead ? `@${lead}` : "the Chief of Staff";
  let text = `Adopted ${adopted.join(", ")}. ${manager} now routes work to them.`;
  if (skipped.length > 0) {
    text += ` Skipped: ${skipped.map((s) => s.id).join(", ")}.`;
  }
  return text;
}

interface AgentRowProps {
  agent: LocalAgent;
  busy: boolean;
  onAdopt: (id: string) => void;
}

function AgentChips({ agent }: { agent: LocalAgent }) {
  const running = runningLabel(agent);
  return (
    <div style={chipRowStyle}>
      {running ? <span style={chipStyle("green")}>{running}</span> : null}
      {agent.installed ? (
        <span style={chipStyle("muted")}>Installed</span>
      ) : null}
      {agent.adopted_as ? (
        <span style={chipStyle("accent")}>Teammate @{agent.adopted_as}</span>
      ) : null}
    </div>
  );
}

function AgentRow({ agent, busy, onAdopt }: AgentRowProps) {
  const blocker = adoptBlocker(agent);
  const detail = detailLine(agent);
  return (
    <div style={rowStyle} data-testid={`local-agent-${agent.id}`}>
      <div style={{ minWidth: 0 }}>
        <div style={nameStyle}>
          {agent.name}
          {agent.vendor ? (
            <span style={vendorStyle}> · {agent.vendor}</span>
          ) : null}
        </div>
        {detail ? <div style={metaStyle}>{detail}</div> : null}
        {blocker ? <div style={metaStyle}>{blocker}</div> : null}
        <AgentChips agent={agent} />
      </div>
      {canAdoptNow(agent) ? (
        <button
          type="button"
          style={buttonStyle(false, busy)}
          disabled={busy}
          onClick={() => onAdopt(agent.id)}
          aria-label={`Adopt ${agent.name}`}
        >
          Adopt
        </button>
      ) : null}
    </div>
  );
}

interface AgentListProps {
  query: UseQueryResult<LocalAgentsResponse>;
  busy: boolean;
  onAdopt: (id: string) => void;
}

function AgentList({ query, busy, onAdopt }: AgentListProps) {
  if (query.isLoading) {
    return <p style={styles.sectionDesc}>Scanning this machine…</p>;
  }
  if (query.isError) {
    const message =
      query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <p style={styles.sectionDesc} role="alert">
        Could not scan this machine: {message}
      </p>
    );
  }
  const agents = query.data?.agents ?? [];
  if (agents.length === 0) {
    return (
      <p style={styles.sectionDesc}>
        No agent CLIs found. Install Claude Code, Codex, Opencode, Gemini CLI,
        or another supported agent, then rescan.
      </p>
    );
  }
  return (
    <div style={listStyle} data-testid="local-agents-list">
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} busy={busy} onAdopt={onAdopt} />
      ))}
    </div>
  );
}

export function LocalAgentsSection() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LOCAL_AGENTS_QUERY_KEY,
    queryFn: getLocalAgents,
    staleTime: 5_000,
  });
  const lead = query.data?.lead ?? "";
  const adoptable = (query.data?.agents ?? []).filter(canAdoptNow);

  const adopt = useMutation({
    mutationFn: (ids: string[]) => adoptLocalAgents(ids),
    onSuccess: (result) => {
      showNotice(
        summarize(result, result.lead ?? lead),
        result.adopted.length > 0 ? "success" : "error",
      );
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["office-members"] });
    },
    onError: (err: unknown) => {
      showNotice(
        err instanceof Error ? err.message : "Failed to adopt agents",
        "error",
      );
    },
  });
  const busy = adopt.isPending;
  const manager = lead ? `@${lead}` : "the Chief of Staff";
  const nothingToAdopt = adoptable.length === 0;

  return (
    <div>
      <h2 style={styles.sectionTitle}>Agents on this machine</h2>
      <p style={styles.sectionDesc}>
        Every coding and agent CLI found installed or running here. Adopt one
        and it becomes a gawkbot on its own sign-in, managed by {manager}, who
        delegates work to it and reports back. Nothing is launched by the scan.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          style={buttonStyle(true, busy || nothingToAdopt)}
          disabled={busy || nothingToAdopt}
          onClick={() => adopt.mutate(adoptable.map((a) => a.id))}
          data-testid="local-agents-adopt-all"
        >
          {nothingToAdopt
            ? "Nothing new to adopt"
            : `Adopt all (${adoptable.length})`}
        </button>
        <button
          type="button"
          style={buttonStyle(false, query.isFetching)}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          data-testid="local-agents-rescan"
        >
          {query.isFetching ? "Scanning…" : "Rescan"}
        </button>
      </div>

      <AgentList
        query={query}
        busy={busy}
        onAdopt={(id) => adopt.mutate([id])}
      />
    </div>
  );
}
