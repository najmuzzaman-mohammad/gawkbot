/**
 * Policies API client — create, list, deactivate, and assign policies.
 *
 * Wire shapes verified against internal/team/broker_policies.go.
 * Uses the shared `get`, `post`, and `del` helpers from client.ts.
 */

import { del, get, post } from "./client";

export interface Policy {
  id: string;
  source: string;
  rule: string;
  active: boolean;
  created_at: string;
  agents?: string[];
}

interface PoliciesResponse {
  policies: Policy[];
}

/** Fetch all policies. Returns the policies array. */
export function getPolicies(): Promise<Policy[]> {
  return get<PoliciesResponse>("/policies").then((r) => r.policies ?? []);
}

/** Create a new policy scoped to specific bots, or global if `bots` is omitted. */
export function createPolicy(input: {
  rule: string;
  source?: string;
  agents?: string[];
}): Promise<Policy> {
  return post<Policy>("/policies", {
    source: input.source ?? "human_directed",
    rule: input.rule,
    agents: input.agents,
  });
}

/** Deactivate (soft-delete) a policy by id. */
export function deactivatePolicy(id: string): Promise<void> {
  return del<void>(`/policies/${encodeURIComponent(id)}`);
}

/** Assign a bot to a policy's scope (POST /policies/:id/assign). */
export function assignPolicyBot(id: string, agent: string): Promise<Policy> {
  return post<Policy>(`/policies/${encodeURIComponent(id)}/assign`, { agent });
}

/**
 * Unassign a bot from a policy's scope.
 * The server returns 409 when unassigning the last bot; callers must
 * surface the error message (it is human-readable prose).
 */
export function unassignPolicyBot(id: string, agent: string): Promise<Policy> {
  return post<Policy>(`/policies/${encodeURIComponent(id)}/unassign`, {
    agent,
  });
}

/**
 * Returns true when a policy applies to a given bot — either because
 * it is global (no `bots` list, or empty) or because the bot is
 * explicitly in the list.
 */
export function policyAppliesToBot(policy: Policy, agentSlug: string): boolean {
  if (!policy.agents || policy.agents.length === 0) return true;
  return policy.agents.includes(agentSlug);
}
