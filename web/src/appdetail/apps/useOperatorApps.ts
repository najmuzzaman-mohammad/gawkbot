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
 * bot stalled — so the operator should see a failure it can clear, not a
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

/** Uniquify a derived bot name against the existing roster: a second
 * workflow that derives the same name must not LOOK like the same bot —
 * and the broker refuses to hand a published bot's id to a new build
 * (2026-08-16 VP-RevOps QA). "Pipeline Bot" -> "Pipeline Bot 2". */
export function uniquifyAppName(
  name: string,
  existing: readonly { name: string }[],
): string {
  const taken = new Set(existing.map((a) => a.name.trim().toLowerCase()));
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let n = 2; n <= 20; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
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
 * present before the build began. Robust to the bot tweaking the display name
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
 * (the brief instructs the bot to register under it). Take the first clause,
 * strip filler lead-ins, title-case, and cap to a handful of words.
 */
// Bots are named for their PURPOSE — a role, not an app title: "Sales Bot",
// "CRM Hygiene Bot", "Support Triage Bot". A domain table catches the common
// operator jobs; anything else becomes "<Lead words> Bot".
const AGENT_ROLES: ReadonlyArray<[RegExp, string]> = [
  [
    // NOT "crm": a bare CRM mention (or a HubSpot/Salesforce endpoint like
    // /crm/v3/... in the captured build seed) means the workflow USES a CRM,
    // not that it cleans one. Hygiene is signalled by dedupe/cleanup terms.
    /\b(hygiene|dedupe|duplicate|clean[- ]?up|data quality)\b/i,
    "CRM Hygiene Bot",
  ],
  // Deal desk outranks pipeline: approval workflows mention deals constantly
  // ("deal desk", "discount approvals") but they are not pipeline reporting.
  // Bare "approval(s)" is too generic (a "refund-approval form" is a form
  // app, not a deal desk) — the desk needs its own nouns.
  [/\b(deal desk|discounts?)\b/i, "Deal Desk Bot"],
  // Recruiting outranks lead routing: hiring language ("score fit", "inbound
  // applicants") reuses scoring/routing verbs, so the noun cues must win.
  [
    /\b(hiring|recruit(?:ing|er)?|candidates?|interviews?|applicants?|job applications?)\b/i,
    "Recruiting Bot",
  ],
  // Nouns accept plurals; bare verbs ("score", "route", "inbound") are gone —
  // they collide with every other domain ("score a task", "inbound tickets").
  [/\b(leads?|lead routing|demo requests?)\b/i, "Lead Routing Bot"],
  // Forecast discipline is its own job — commits, quota, accuracy — not
  // pipeline reporting.
  [/\b(forecasts?|commits?|quotas?)\b/i, "Forecast Bot"],
  [/\b(pipelines?|deals?)\b/i, "Pipeline Bot"],
  [/\b(sales|quotas?|outreach|prospects?)\b/i, "Sales Bot"],
  // Engineering-team rituals get their own names, not a generic bucket.
  [/\b(stand-?ups?)\b/i, "Standup Bot"],
  [/\b(sprints?|velocity|story points?)\b/i, "Sprint Planning Bot"],
  [/\b(retros?|retrospectives?)\b/i, "Retro Bot"],
  // Inventory/reorder vocabulary — stock levels, reorder points, purchase
  // orders — is its own job, distinct from generic "track" workflows.
  [
    /\b(inventory|reorders?|stock levels?|reorder points?|purchase orders?|restock)\b/i,
    "Inventory Bot",
  ],
  // Facilities vocabulary ("tenant maintenance requests") reuses request/
  // ticket verbs, so its nouns must outrank support triage.
  [/\b(maintenance|tenants?|work orders?|facilities)\b/i, "Maintenance Bot"],
  // Incident management (SRE vocabulary) is not support triage.
  // "on-call" deliberately absent: rotation staffing shows up in sprint
  // planning too, and the strong nouns below carry incident management.
  [/\b(incidents?|postmortems?|outages?|mttr)\b/i, "Incident Bot"],
  [/\b(support|tickets?|escalations?)\b/i, "Support Triage Bot"],
  // Renewals outrank follow-up: a renewals radar drafts check-ins, but the
  // job is the renewal book, not the email.
  [/\b(renewals?|churn)\b/i, "Renewals Bot"],
  [/\b(invoices?|billing|receivables?|dunning)\b/i, "Invoice Bot"],
  [/\b(expenses?|reimburse|spend)\b/i, "Expense Bot"],
  [/\b(email|inbox|follow[- ]?ups?|replies|nurture)\b/i, "Follow-up Bot"],
  [
    /\b(reports?|summar|digests?|dashboards?|recaps?|kpis?|metrics?)\b/i,
    "Reporting Bot",
  ],
  [/\b(onboard|welcome|signups?|sign-ups?)\b/i, "Onboarding Bot"],
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

// Leading imperative verbs a description often opens with ("Track our stock…",
// "Handle our tickets…"). When the first word is one of these AND the next word
// is a possessive/article, the plain word-cap collapses to a verb-only name
// ("Track Bot") — so skip the verb (and one following our/the/my/all/any) and
// let the noun phrase name the bot. The high-confidence AGENT_ROLES table
// still wins first; this only improves the generic fallback.
const NAME_LEADING_VERBS = new Set([
  "track",
  "handle",
  "manage",
  "run",
  "process",
  "chase",
  "monitor",
  "log",
  "review",
  "organize",
  "coordinate",
  "sort",
  "watch",
  "check",
  "update",
  "maintain",
  "oversee",
]);
const NAME_SKIP_AFTER_VERB = new Set([
  "our",
  "the",
  "my",
  "all",
  "any",
  "your",
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
  let allWords = firstClause.split(/\s+/).filter(Boolean);
  // Drop a leading imperative verb (and one following possessive/article) so
  // "Track our store inventory" names by the noun phrase, not the verb. Only
  // when real noun words follow — a bare "Track it" keeps the plain behavior.
  if (
    allWords.length >= 2 &&
    NAME_LEADING_VERBS.has(allWords[0].toLowerCase())
  ) {
    let start = 1;
    if (
      allWords.length > start + 1 &&
      NAME_SKIP_AFTER_VERB.has(allWords[start].toLowerCase())
    ) {
      start += 1;
    }
    // Only skip if a non-function noun word actually remains to name it.
    if (
      start < allWords.length &&
      !NAME_FUNCTION_WORDS.has(allWords[start].toLowerCase())
    ) {
      allWords = allWords.slice(start);
    }
  }
  // Cut before the first function word (never at position 0) and cap the cut
  // at 4 words; with no function word, keep the plain 3-word cap.
  const cut = allWords.findIndex(
    (w, i) => i > 0 && NAME_FUNCTION_WORDS.has(w.toLowerCase()),
  );
  const words =
    cut > 0 ? allWords.slice(0, Math.min(cut, 4)) : allWords.slice(0, 3);
  if (words.length === 0) return "Untitled Bot";
  const titled = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return `${titled.slice(0, 100)} Bot`;
}
