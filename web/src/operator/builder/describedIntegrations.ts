// describedIntegrations — which external systems a free-text workflow
// description references, and which of those the workspace has connected.
//
// The build gate uses this to ASK before building instead of silently
// re-scoping (founder decision, 2026-08-14 QA: "audit our CRM" with no CRM
// connected must not quietly become a workspace-task audit). Detection is a
// deliberate keyword map over the operator's own words — deterministic and
// testable; no model call before the build even starts.

import {
  type IntegrationCatalogItem,
  listIntegrations,
} from "../../api/integrations";

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

/** One concrete, catalog-resolved thing the gate can offer to connect. A
 *  product ref maps to itself; a generic ref ("a CRM") expands to its family
 *  products, any one of which satisfies the ref. */
export interface GateConnectTarget {
  /** Display label ("HubSpot"). */
  label: string;
  /** Canonical catalog platform slug the connect flow needs. */
  platform: string;
  provider: string;
  /** The catalog's brand logo, when it has one. */
  logoUrl?: string;
  connected: boolean;
  /** Which described ref this target satisfies (index into the refs array). */
  refIndex: number;
  /** True when the ref is a family word — the UI says "any one works". */
  generic: boolean;
}

/** Family-word refs expand to these product labels for the connect rows. */
const FAMILY_PRODUCTS: Record<string, string[]> = {
  "a CRM (HubSpot, Salesforce, Pipedrive…)": [
    "HubSpot",
    "Salesforce",
    "Pipedrive",
  ],
};

function bestCatalogMatch(
  label: string,
  items: IntegrationCatalogItem[],
): IntegrationCatalogItem | null {
  if (items.length === 0) return null;
  const needle = label.trim().toLowerCase();
  return (
    items.find(
      (i) =>
        i.name.trim().toLowerCase() === needle ||
        i.platform.trim().toLowerCase() === needle,
    ) ?? items[0]
  );
}

/**
 * Resolve the gate's connect rows against the live catalog: canonical
 * platform slug, provider, brand logo, and current connected state per
 * offerable product. Unresolvable labels are dropped (the workspace-data
 * path still covers them); any API failure yields [] so the gate can fall
 * back to its two-button form rather than block.
 */
export async function resolveGateTargets(
  refs: DescribedIntegration[],
): Promise<GateConnectTarget[]> {
  const out: GateConnectTarget[] = [];
  await Promise.all(
    refs.map(async (ref, refIndex) => {
      const labels = ref.generic
        ? (FAMILY_PRODUCTS[ref.label] ?? ref.platforms)
        : [ref.label];
      await Promise.all(
        labels.map(async (label) => {
          try {
            const res = await listIntegrations({ search: label, limit: 5 });
            const match = bestCatalogMatch(label, res.items ?? []);
            if (!match) return;
            out.push({
              label: match.name || label,
              platform: match.platform,
              provider: match.provider || "composio",
              logoUrl: match.logo_url,
              connected:
                match.state === "connected" ||
                (match.connections?.length ?? 0) > 0,
              refIndex,
              generic: Boolean(ref.generic),
            });
          } catch {
            // Dropped — see above.
          }
        }),
      );
    }),
  );
  // Stable order: by ref, then label, so rows don't jump between resolves.
  return out.sort(
    (a, b) => a.refIndex - b.refIndex || a.label.localeCompare(b.label),
  );
}
