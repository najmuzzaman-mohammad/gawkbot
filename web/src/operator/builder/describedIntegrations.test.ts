// The pre-build integration gate's detector: names in, families deduped,
// nothing detected → nothing asked.

import { describe, expect, it } from "vitest";

import { describedIntegrations } from "./describedIntegrations";

describe("describedIntegrations", () => {
  it("detects product names", () => {
    const refs = describedIntegrations(
      "Score demo requests in HubSpot and post the winners to Slack",
    );
    expect(refs.map((r) => r.label)).toEqual(["HubSpot", "Slack"]);
  });

  it("detects the generic CRM family", () => {
    const refs = describedIntegrations(
      "Audit our CRM for duplicate accounts and stale deals",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].generic).toBe(true);
    expect(refs[0].platforms).toContain("hubspot");
  });

  it("a named CRM absorbs the generic mention", () => {
    const refs = describedIntegrations("Clean up our Salesforce CRM records");
    expect(refs.map((r) => r.label)).toEqual(["Salesforce"]);
  });

  it("plain workspace workflows reference nothing", () => {
    expect(
      describedIntegrations("Every Monday write a recap of open tasks"),
    ).toEqual([]);
  });
});
