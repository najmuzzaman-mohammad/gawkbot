// describedIntegrations — which external systems a free-text workflow
// description references, and which of those the workspace has connected.
//
// The build gate uses this to ASK before building instead of silently
// re-scoping (founder decision, 2026-08-14 QA: "audit our CRM" with no CRM
// connected must not quietly become a workspace-task audit). Detection is a
// deliberate keyword map over the operator's own words — deterministic and
// testable; no model call before the build even starts.

import { listIntegrations } from "../../api/integrations";

/** One external system the description names. `generic` marks category words
 *  ("our CRM") that name a family rather than a product. */
export interface DescribedIntegration {
  /** Display label for chat copy ("HubSpot", "a CRM"). */
  label: string;
  /** Catalog search terms that would satisfy the reference. */
  platforms: string[];
  generic?: boolean;
}

// Keyword → integration. Word-boundary, case-insensitive. Ordered: product
// names first so "HubSpot CRM" resolves to HubSpot, not the generic family.
const KEYWORD_MAP: ReadonlyArray<{ re: RegExp; hit: DescribedIntegration }> = [
  { re: /\bhubspot\b/i, hit: { label: "HubSpot", platforms: ["hubspot"] } },
  {
    re: /\bsalesforce\b/i,
    hit: { label: "Salesforce", platforms: ["salesforce"] },
  },
  {
    re: /\bpipedrive\b/i,
    hit: { label: "Pipedrive", platforms: ["pipedrive"] },
  },
  { re: /\bslack\b/i, hit: { label: "Slack", platforms: ["slack"] } },
  {
    re: /\bgmail\b|\bemail inbox\b/i,
    hit: { label: "Gmail", platforms: ["gmail"] },
  },
  { re: /\bnotion\b/i, hit: { label: "Notion", platforms: ["notion"] } },
  { re: /\bgithub\b/i, hit: { label: "GitHub", platforms: ["github"] } },
  { re: /\blinear\b/i, hit: { label: "Linear", platforms: ["linear"] } },
  { re: /\bjira\b/i, hit: { label: "Jira", platforms: ["jira"] } },
  { re: /\bstripe\b/i, hit: { label: "Stripe", platforms: ["stripe"] } },
  {
    re: /\bintercom\b/i,
    hit: { label: "Intercom", platforms: ["intercom"] },
  },
  { re: /\bzendesk\b/i, hit: { label: "Zendesk", platforms: ["zendesk"] } },
  {
    re: /\bairtable\b/i,
    hit: { label: "Airtable", platforms: ["airtable"] },
  },
  {
    re: /\bgoogle sheets?\b|\bspreadsheet\b/i,
    hit: {
      label: "Google Sheets",
      platforms: ["googlesheets", "google sheets"],
    },
  },
  {
    re: /\bgoogle calendar\b|\bcalendar invites?\b/i,
    hit: {
      label: "Google Calendar",
      platforms: ["googlecalendar", "google calendar"],
    },
  },
  // Category words LAST — only counted when no product from the family hit.
  {
    re: /\bcrm\b/i,
    hit: {
      label: "a CRM (HubSpot, Salesforce, Pipedrive…)",
      platforms: ["hubspot", "salesforce", "pipedrive"],
      generic: true,
    },
  },
];

/** External systems the description references, first-seen order, deduped by
 *  family (a generic "CRM" mention is absorbed by a named CRM product). */
export function describedIntegrations(text: string): DescribedIntegration[] {
  const out: DescribedIntegration[] = [];
  for (const { re, hit } of KEYWORD_MAP) {
    if (!re.test(text)) continue;
    if (
      hit.generic &&
      out.some((h) => h.platforms.some((p) => hit.platforms.includes(p)))
    ) {
      continue; // "HubSpot CRM": the product already covers the family
    }
    out.push(hit);
  }
  return out;
}

/** The subset of referenced systems with NO connected integration. Degrades
 *  to [] on any API failure — the gate must never block a build on a hiccup. */
export async function missingIntegrations(
  refs: DescribedIntegration[],
): Promise<DescribedIntegration[]> {
  if (refs.length === 0) return [];
  try {
    const res = await listIntegrations({ connected: "true", limit: 100 });
    const connected = new Set(
      (res.items ?? [])
        .filter(
          (i) => (i.connections?.length ?? 0) > 0 || i.state === "connected",
        )
        .flatMap((i) => [i.platform.toLowerCase(), i.name.toLowerCase()]),
    );
    return refs.filter(
      (r) => !r.platforms.some((p) => connected.has(p.toLowerCase())),
    );
  } catch {
    return [];
  }
}
