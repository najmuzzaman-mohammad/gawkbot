// Operator apps data layer — thin React Query hooks over the existing app
// builder client (web/src/api/apps.ts). The backend, persistence, build
// pipeline, and Bridge v2 are reused unchanged; the operator surface only adds
// its own hooks + skin. Pure resolvers live here too so the build→appear
// correlation is unit-testable without a network.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type AppBuildRequest,
  type AppCapabilities,
  type CustomApp,
  type CustomAppDetail,
  getApp,
  getAppCapabilities,
  listApps,
  requestAppBuild,
} from "../../api/apps";
import { del } from "../../api/client";

/** A freshly-registered app shows up within a few seconds; poll while waiting. */
const APPS_POLL_MS = 4000;

/**
 * How long a "building" app may sit unpublished before we treat the build as
 * FAILED rather than still in progress. A real build publishes in ~6 min (warm
 * builds are seconds); past this it is not actually building anymore — the
 * agent stalled — so the operator should see a failure it can clear, not a
 * forever-spinning "building" row.
 */
// The broker's build budget is 25 minutes per attempt with up to two
// resume-requeues (WUPHF_BUILD_TIMEOUT + the recovery carve-out), and a
// terminally failed build is stamped status="failed" on the wire now — this
// client-side window is only the backstop for a broker that died mid-build.
const BUILD_STALL_MS = 80 * 60 * 1000;

/** App ids carry an `app_<hex>` prefix; the operator uses it to tell a real
 * built app apart from a mock tool id. */
export const APP_ID_PREFIX = "app_";

export function isRealAppId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(APP_ID_PREFIX);
}

export type AppBuildState = "ready" | "building" | "failed";

/**
 * Resolve an app's effective build state. "building" only while it is plausibly
 * still building; a building app whose pre-scaffold is older than BUILD_STALL_MS
 * has stalled and is reported "failed".
 */
export function appBuildState(
  app: CustomApp,
  now: number = Date.now(),
): AppBuildState {
  if (app.status === "failed") return "failed";
  if (app.status !== "building") return "ready";
  const created = Date.parse(app.createdAt ?? "");
  if (Number.isFinite(created) && now - created > BUILD_STALL_MS) {
    return "failed";
  }
  return "building";
}

/**
 * List the workspace's built apps. Polls while any app is GENUINELY building
 * (not stalled/failed) so a freshly-published app appears without a reload, then
 * settles — a failed build no longer keeps the list polling.
 */
export function useOperatorApps() {
  return useQuery({
    queryKey: ["operator-apps"],
    queryFn: listApps,
    refetchInterval: (query) => {
      const apps = query.state.data ?? [];
      return apps.some((a) => appBuildState(a) === "building")
        ? APPS_POLL_MS
        : false;
    },
  });
}

/**
 * Load one app's manifest + sealed HTML. Polls while the app is genuinely
 * building; stops once it is ready OR has failed (a stalled build won't publish,
 * so polling it forever is pointless).
 */
export function useOperatorApp(id: string | null) {
  return useQuery({
    queryKey: ["operator-app", id],
    queryFn: () => getApp(id ?? ""),
    enabled: isRealAppId(id),
    refetchInterval: (query) => {
      const detail = query.state.data as CustomAppDetail | undefined;
      if (!detail) return APPS_POLL_MS;
      return appBuildState(detail.app) === "building" || !detail.html
        ? APPS_POLL_MS
        : false;
    },
  });
}

/**
 * Read the app's deterministic capability map (what it reads/writes), the real
 * basis for its Data tab. Only meaningful once the app is ready (an html-only or
 * still-building app returns an empty map), so it is gated on a real app id.
 */
export function useAppCapabilities(id: string | null) {
  return useQuery({
    queryKey: ["operator-app-capabilities", id],
    queryFn: () => getAppCapabilities(id ?? ""),
    enabled: isRealAppId(id),
  });
}

/** Kick off an app-builder build/improve. Returns the created Task. */
export function useBuildApp() {
  return useMutation({
    mutationFn: (req: AppBuildRequest) => requestAppBuild(req),
  });
}

/** Remove an app (used to clear a failed/stalled build). Authorized via the
 * App Builder writer path — the operator removes a failed build the same way the
 * builder that owns it would. */
export function useDeleteApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      del(`/apps/${encodeURIComponent(id)}`, undefined, {
        "X-WUPHF-Agent": "app-builder",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operator-apps"] }),
  });
}

// ── Pure resolvers (unit-tested) ────────────────────────────────────────────

/**
 * Pick the app a just-started build produced: the newest app whose id was NOT
 * present before the build began. Robust to the agent tweaking the display name
 * (a name-only match would miss "Open tasks" vs "Open Tasks dashboard"); the
 * only app that can appear after we snapshot the existing ids is the one we just
 * asked to build. Newest-first by updatedAt, then createdAt, as a tiebreak.
 */
export function resolveNewAppId(
  beforeIds: ReadonlySet<string>,
  apps: readonly CustomApp[],
): string | null {
  const fresh = apps.filter((a) => !beforeIds.has(a.id));
  if (fresh.length === 0) return null;
  const newest = [...fresh].sort((a, b) => {
    const byUpdated = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    if (byUpdated !== 0) return byUpdated;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  })[0];
  return newest.id;
}

/**
 * Derive a short, stable app name from the operator's free-text description, so
 * a chat-first "describe it" flow still gives requestAppBuild an explicit name
 * (the brief instructs the agent to register under it). Take the first clause,
 * strip filler lead-ins, title-case, and cap to a handful of words.
 */
// Agents are named for their PURPOSE — a role, not an app title: "Sales Agent",
// "CRM Hygiene Agent", "Support Triage Agent". A domain table catches the common
// operator jobs; anything else becomes "<Lead words> Agent".
const AGENT_ROLES: ReadonlyArray<[RegExp, string]> = [
  [
    // NOT "crm": a bare CRM mention (or a HubSpot/Salesforce endpoint like
    // /crm/v3/... in the captured build seed) means the workflow USES a CRM,
    // not that it cleans one. Hygiene is signalled by dedupe/cleanup terms.
    /\b(hygiene|dedupe|duplicate|clean[- ]?up|data quality)\b/i,
    "CRM Hygiene Agent",
  ],
  // Recruiting outranks lead routing: hiring language ("score fit", "inbound
  // applicants") reuses scoring/routing verbs, so the noun cues must win.
  [
    /\b(hiring|recruit(?:ing|er)?|candidates?|interviews?|applicants?|job applications?)\b/i,
    "Recruiting Agent",
  ],
  // Nouns accept plurals; bare verbs ("score", "route", "inbound") are gone —
  // they collide with every other domain ("score a task", "inbound tickets").
  [/\b(leads?|lead routing|demo requests?)\b/i, "Lead Routing Agent"],
  [/\b(pipelines?|deals?|forecasts?)\b/i, "Pipeline Agent"],
  [/\b(sales|quotas?|outreach|prospects?)\b/i, "Sales Agent"],
  [/\b(support|tickets?|escalations?|incidents?)\b/i, "Support Triage Agent"],
  [/\b(invoices?|billing|receivables?|dunning)\b/i, "Invoice Agent"],
  [/\b(expenses?|reimburse|spend)\b/i, "Expense Agent"],
  [/\b(email|inbox|follow[- ]?ups?|replies|nurture)\b/i, "Follow-up Agent"],
  [
    /\b(reports?|summar|digests?|dashboards?|recaps?|kpis?|metrics?)\b/i,
    "Reporting Agent",
  ],
  [/\b(onboard|welcome|signups?|sign-ups?)\b/i, "Onboarding Agent"],
];

// Relative pronouns, prepositions, and other connectives that must never land
// in a synthesized name ("refund-approval form THAT posts…" → cut before
// "that"). A clause head — position 0 — is exempt so a degenerate clause that
// starts with one of these keeps the plain word-cap behavior.
const NAME_FUNCTION_WORDS = new Set([
  "that",
  "which",
  "who",
  "to",
  "for",
  "of",
  "with",
  "so",
  "and",
  "i",
  "you",
  "we",
  "my",
  "our",
  "their",
  "it",
]);

export function deriveAppName(description: string): string {
  const role = AGENT_ROLES.find(([test]) => test.test(description));
  if (role) return role[1];
  const leadIn =
    /^\s*(please|build|make|create|set up|give me|i want|i need|a|an|the)\s+/i;
  let firstClause = description.split(/[.\n,;:]/)[0].trim();
  // Strip a chain of lead-ins ("build a dashboard" → "dashboard"), not just one.
  let prev = "";
  while (prev !== firstClause) {
    prev = firstClause;
    firstClause = firstClause.replace(leadIn, "").trim();
  }
  const allWords = firstClause.split(/\s+/).filter(Boolean);
  // Cut before the first function word (never at position 0) and cap the cut
  // at 4 words; with no function word, keep the plain 3-word cap.
  const cut = allWords.findIndex(
    (w, i) => i > 0 && NAME_FUNCTION_WORDS.has(w.toLowerCase()),
  );
  const words =
    cut > 0 ? allWords.slice(0, Math.min(cut, 4)) : allWords.slice(0, 3);
  if (words.length === 0) return "Untitled Agent";
  const titled = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return `${titled.slice(0, 100)} Agent`;
}
