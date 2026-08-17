import { describe, expect, it } from "vitest";

import type { CustomApp } from "../../api/apps";
import { capturePromptSeed, demoCaptureFromDraft } from "./demoCapture";
import {
  APP_ID_PREFIX,
  appBuildState,
  deriveAppName,
  isRealAppId,
  resolveNewAppId,
  uniquifyAppName,
} from "./useOperatorApps";

function app(over: Partial<CustomApp>): CustomApp {
  return {
    id: "app_0001",
    slug: "x",
    name: "X",
    icon: "🧩",
    entry: "index.html",
    version: 1,
    createdBy: "app-builder",
    createdAt: "2026-06-29T10:00:00Z",
    updatedAt: "2026-06-29T10:00:00Z",
    contentHash: "h",
    ...over,
  };
}

describe("isRealAppId", () => {
  it("accepts app_ ids and rejects mock tool ids", () => {
    expect(isRealAppId(`${APP_ID_PREFIX}abc`)).toBe(true);
    expect(isRealAppId("inbound-routing")).toBe(false);
    expect(isRealAppId(null)).toBe(false);
    expect(isRealAppId(undefined)).toBe(false);
  });
});

describe("resolveNewAppId", () => {
  it("returns null when no app is new", () => {
    const apps = [app({ id: "app_a" }), app({ id: "app_b" })];
    const before = new Set(["app_a", "app_b"]);
    expect(resolveNewAppId(before, apps)).toBeNull();
  });

  it("picks the app whose id was not present before the build", () => {
    const before = new Set(["app_a"]);
    const apps = [app({ id: "app_a" }), app({ id: "app_new" })];
    expect(resolveNewAppId(before, apps)).toBe("app_new");
  });

  it("prefers the newest by updatedAt when several are new", () => {
    const before = new Set<string>();
    const apps = [
      app({ id: "app_old", updatedAt: "2026-06-29T09:00:00Z" }),
      app({ id: "app_new", updatedAt: "2026-06-29T12:00:00Z" }),
    ];
    expect(resolveNewAppId(before, apps)).toBe("app_new");
  });

  it("ignores a renamed existing app (matches by id, not name)", () => {
    // The agent may register under a tweaked display name; id-based correlation
    // must not be fooled into treating the rename as a new app.
    const before = new Set(["app_a"]);
    const apps = [app({ id: "app_a", name: "Open Tasks Dashboard" })];
    expect(resolveNewAppId(before, apps)).toBeNull();
  });
});

describe("appBuildState", () => {
  const now = Date.parse("2026-06-29T12:00:00Z");

  it("reports ready for a published app", () => {
    expect(appBuildState(app({ status: "ready" }), now)).toBe("ready");
    expect(appBuildState(app({ status: undefined }), now)).toBe("ready");
  });

  it("reports building for a recently-started build", () => {
    const a = app({ status: "building", createdAt: "2026-06-29T11:58:00Z" });
    expect(appBuildState(a, now)).toBe("building");
  });

  it("reports failed for a build stalled past the backstop window", () => {
    // The backstop is 80 minutes now (the broker stamps real failures on the
    // wire); a build 90 minutes old with no status flip means the broker died.
    const a = app({ status: "building", createdAt: "2026-06-29T10:35:00Z" });
    expect(appBuildState(a, now)).toBe("failed");
  });

  it("reads a broker-stamped failed status straight off the wire", () => {
    const a = app({ status: "failed", createdAt: "2026-06-29T12:04:00Z" });
    expect(appBuildState(a, now)).toBe("failed");
  });

  it("keeps a 20-minute-old build honest — still building, not failed", () => {
    // Regression (2026-08-16 audit): the old 10-minute window declared
    // legitimately-running first builds failed while the broker's own
    // budget was 25 minutes.
    const a = app({ status: "building", createdAt: "2026-06-29T11:45:00Z" });
    expect(appBuildState(a, now)).toBe("building");
  });
});

describe("uniquifyAppName", () => {
  it("appends a counter when the roster already has the name", () => {
    expect(
      uniquifyAppName("Pipeline Agent", [{ name: "Pipeline Agent" }]),
    ).toBe("Pipeline Agent 2");
    expect(
      uniquifyAppName("Pipeline Agent", [
        { name: "Pipeline Agent" },
        { name: "Pipeline Agent 2" },
      ]),
    ).toBe("Pipeline Agent 3");
    expect(uniquifyAppName("Deal Desk Agent", [])).toBe("Deal Desk Agent");
  });
});

describe("deriveAppName", () => {
  it("names an agent for its role when the domain is recognizable", () => {
    expect(deriveAppName("score inbound leads and route hot ones")).toBe(
      "Lead Routing Agent",
    );
    expect(deriveAppName("keep the CRM clean, dedupe contacts")).toBe(
      "CRM Hygiene Agent",
    );
    expect(deriveAppName("a weekly pipeline summary I can glance at")).toBe(
      "Pipeline Agent",
    );
  });

  it("names a lead-scoring/routing demo for its role, not CRM hygiene", () => {
    // The narrated goal for the inbound demo-request scenario. Scoring and
    // routing is the job; a CRM is merely one of the systems it touches.
    const goal =
      "When a demo request comes in, look up the company in HubSpot, score " +
      "fit 0 to 100 from company size and industry, route 70 and up to an AE " +
      "in Slack #ae-handoffs with the reason, and nurture the rest.";
    expect(deriveAppName(goal)).not.toBe("CRM Hygiene Agent");
    expect(deriveAppName(goal)).toBe("Lead Routing Agent");
  });

  it("does not read a CRM API endpoint in the build seed as a hygiene job", () => {
    // The demo handoff derives the name from the FULL capture seed, which
    // embeds the observed HubSpot endpoint /crm/v3/objects/companies/search.
    // A bare "crm" mention means the workflow USES a CRM, not that it cleans
    // one — the name must follow the actual work (lead scoring + routing).
    const seed = capturePromptSeed(
      demoCaptureFromDraft(
        {
          goal: "When a demo request comes in, score the lead and route hot ones to an AE.",
          summary: "Lead routing",
          apiCalls: [
            {
              method: "post",
              endpoint: "/crm/v3/objects/companies/search",
              integration: "HubSpot",
            },
          ],
        },
        { mode: "build", transcript: [] },
      ),
    );
    expect(seed).toContain("/crm/v3/objects/companies/search");
    expect(deriveAppName(seed)).not.toBe("CRM Hygiene Agent");
    expect(deriveAppName(seed)).toBe("Lead Routing Agent");
  });

  // 2026-08-16 fresh-workspace QA: "Chase our unpaid invoices" was named
  // "Chase Agent" (plural nouns missed the role table), and a recruiting
  // description using scoring verbs was claimed by Lead Routing.
  it("names engineering rituals by their own nouns", () => {
    expect(deriveAppName("Prep our standup every weekday at 9")).toBe(
      "Standup Agent",
    );
    expect(
      deriveAppName("Plan sprint capacity against historical velocity"),
    ).toBe("Sprint Planning Agent");
  });

  it("names a renewals radar Renewals Agent, not Follow-up", () => {
    expect(
      deriveAppName(
        "Watch our renewals: flag accounts renewing inside 90 days and draft a check-in email",
      ),
    ).toBe("Renewals Agent");
  });

  it("names incident tracking Incident Agent, not Support Triage", () => {
    expect(
      deriveAppName(
        "Track our incidents with severity and owners, nag for postmortems, keep MTTR stats",
      ),
    ).toBe("Incident Agent");
  });

  it("names forecast-accuracy tracking Forecast Agent", () => {
    expect(
      deriveAppName(
        "Track rep forecast accuracy: compare each commit against pipeline coverage",
      ),
    ).toBe("Forecast Agent");
  });

  it("names a discount approval workflow Deal Desk, not Pipeline", () => {
    // 2026-08-16 VP-RevOps QA: "deal desk" hit the pipeline row and collided
    // with an existing Pipeline Agent — briefing the build to republish over
    // the live agent.
    expect(
      deriveAppName(
        "Run our deal desk discount approvals: apply our rules and draft escalation notes",
      ),
    ).toBe("Deal Desk Agent");
  });

  it("names invoice chasing and applicant screening by their nouns", () => {
    expect(
      deriveAppName(
        "Chase our unpaid invoices: find anything past its due date and draft a reminder",
      ),
    ).toBe("Invoice Agent");
    expect(
      deriveAppName(
        "Screen inbound job applicants for our warehouse role, score fit 0-100, keep a shortlist",
      ),
    ).toBe("Recruiting Agent");
    expect(deriveAppName("Triage inbound support tickets by urgency")).toBe(
      "Support Triage Agent",
    );
  });

  it("synthesizes <lead words> Agent for an unknown domain", () => {
    // "for" is a function word — the clause is cut before it, so the
    // preposition never lands in the name.
    expect(deriveAppName("a refund form for vendors")).toBe(
      "Refund Form Agent",
    );
  });

  it("cuts the synthesized name before a relative pronoun", () => {
    expect(
      deriveAppName(
        "A refund-approval form that posts approved refunds to Slack",
      ),
    ).toBe("Refund-approval Form Agent");
  });

  it("cuts the synthesized name before other function words", () => {
    // "of" right after the head noun: cut leaves a single word.
    expect(deriveAppName("a checklist of vendor contracts")).toBe(
      "Checklist Agent",
    );
    // "with" mid-clause.
    expect(deriveAppName("a vendor portal with login")).toBe(
      "Vendor Portal Agent",
    );
  });

  it("routes role-keyword descriptions through the role table, not the clause cut", () => {
    // "dashboard" is a reporting keyword — the role table wins before any
    // clause parsing ("Dashboard Of Our Agent" must never appear).
    expect(
      deriveAppName("A dashboard of our open tasks with their status"),
    ).toBe("Reporting Agent");
    // "escalation" is a support keyword, so the role table names it even
    // though the clause cut alone would give "Escalation Queue Agent".
    expect(deriveAppName("an escalation queue for our support team")).toBe(
      "Support Triage Agent",
    );
  });

  it("caps a function-word cut at four words", () => {
    expect(
      deriveAppName("a vendor security questionnaire response tool for legal"),
    ).toBe("Vendor Security Questionnaire Response Agent");
  });

  it("caps the synthesized lead at three words when no function word appears", () => {
    expect(
      deriveAppName("create one two three four five six seven eight nine"),
    ).toBe("One Two Three Agent");
  });

  it("falls back when empty", () => {
    expect(deriveAppName("   ")).toBe("Untitled Agent");
  });
});
