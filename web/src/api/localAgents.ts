import { get, post } from "./client";

// Agent CLIs found on this machine. Mirrors localAgentEntry /
// agentdetect.Detection in internal/team/broker_local_agents.go.

export type LocalAgentRuntime = "native" | "cli" | "gateway" | "app";

export interface LocalAgentProcess {
  pid: number;
  /** Working directory of the session, when the OS exposes it (Linux). */
  cwd?: string;
}

export interface LocalAgent {
  id: string;
  name: string;
  vendor?: string;
  runtime: LocalAgentRuntime;
  installed: boolean;
  binary_path?: string;
  config_path?: string;
  running?: LocalAgentProcess[];
  adoptable: boolean;
  provider_kind?: string;
  install_url?: string;
  note?: string;
  /** Slug of the office bot already running this agent. */
  adopted_as?: string;
}

export interface LocalAgentsResponse {
  agents: LocalAgent[];
  /** The Chief of Staff slug adopted bots report to. */
  lead?: string;
}

export interface LocalAgentAdoptResponse {
  adopted: { id: string; slug: string; name: string }[];
  skipped?: { id: string; reason: string }[];
  lead?: string;
}

export const LOCAL_AGENTS_QUERY_KEY = ["local-agents"] as const;

export function getLocalAgents() {
  return get<LocalAgentsResponse>("/agents/local");
}

export function adoptLocalAgents(ids: string[]) {
  return post<LocalAgentAdoptResponse>("/agents/local/adopt", { ids });
}

/** True when the office can turn this agent into a bot right now. */
export function canAdoptNow(agent: LocalAgent): boolean {
  return agent.adoptable && agent.installed && !agent.adopted_as;
}

/** One-line reason an agent cannot be adopted, or "" when it can. */
export function adoptBlocker(agent: LocalAgent): string {
  if (agent.adopted_as) return "";
  if (!agent.adoptable) {
    return agent.note || "No headless mode gawkbot can drive.";
  }
  if (!agent.installed) {
    return "Seen on this machine, but its binary is not on PATH.";
  }
  return "";
}
