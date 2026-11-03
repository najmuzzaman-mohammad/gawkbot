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
import { PageHeader, SettingsGroup } from "./components";

// ─── Agents on this machine ─────────────────────────────────────────────
//
// Lists every agent CLI the broker found installed or running here (Claude
// Code, Codex, Opencode, Gemini CLI, Aider, Goose, ...) and turns the ones
// gawkbot can drive into office bots that the Chief of Staff manages.

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
    <div className="settings-chip-row">
      {running ? (
        <span className="settings-chip settings-chip--green">{running}</span>
      ) : null}
      {agent.installed ? (
        <span className="settings-chip">Installed</span>
      ) : null}
      {agent.adopted_as ? (
        <span className="settings-chip settings-chip--accent">
          Teammate @{agent.adopted_as}
        </span>
      ) : null}
    </div>
  );
}

function AgentRow({ agent, busy, onAdopt }: AgentRowProps) {
  const blocker = adoptBlocker(agent);
  const detail = detailLine(agent);
  return (
    <div
      className="settings-row settings-row--tall"
      data-testid={`local-agent-${agent.id}`}
    >
      <div className="settings-row-main">
        <div className="settings-row-title">
          <span>{agent.name}</span>
          {agent.vendor ? (
            <span className="settings-row-title-muted">· {agent.vendor}</span>
          ) : null}
        </div>
        {detail ? (
          <div className="settings-row-meta settings-row-meta--quiet">
            {detail}
          </div>
        ) : null}
        {blocker ? (
          <div className="settings-row-meta settings-row-meta--quiet">
            {blocker}
          </div>
        ) : null}
        <AgentChips agent={agent} />
      </div>
      {canAdoptNow(agent) ? (
        <div className="settings-row-control">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => onAdopt(agent.id)}
            aria-label={`Adopt ${agent.name}`}
          >
            Adopt
          </button>
        </div>
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
    return <p className="settings-page-desc">Scanning this machine…</p>;
  }
  if (query.isError) {
    const message =
      query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <p className="settings-page-desc" role="alert">
        Could not scan this machine: {message}
      </p>
    );
  }
  const agents = query.data?.agents ?? [];
  if (agents.length === 0) {
    return (
      <p className="settings-page-desc">
        No agent CLIs found. Install Claude Code, Codex, Opencode, Gemini CLI,
        or another supported agent, then rescan.
      </p>
    );
  }
  return (
    <SettingsGroup
      title="Found on this machine"
      data-testid="local-agents-list"
    >
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} busy={busy} onAdopt={onAdopt} />
      ))}
    </SettingsGroup>
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
    <div className="settings-page">
      <PageHeader title="Agents on this machine">
        Every coding and agent CLI found installed or running here. Adopt one
        and it becomes a gawkbot on its own sign-in, managed by {manager}, who
        delegates work to it and reports back. Nothing is launched by the scan.
      </PageHeader>

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
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
          className="btn btn-secondary btn-sm"
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
