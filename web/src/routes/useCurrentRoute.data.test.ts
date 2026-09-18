import { describe, expect, it } from "vitest";

import {
  dataIndexRoute,
  dataRecordRoute,
  dataSpaceRoute,
  dataTypeRoute,
  dataTypeSettingsRoute,
  router,
} from "../lib/router";
import { navigateToSidebarApp } from "../lib/sidebarNav";
import {
  isFirstClassAppId,
  ROUTE_CONTRACTS,
  SIDEBAR_TOOLS,
} from "./routeRegistry";
import { type CurrentRoute, deriveCurrentRoute } from "./useCurrentRoute";

// Pins the URL→state mapping for the Data section so a route-id refactor
// cannot silently drop a Data screen into kind: "unknown".
describe("deriveCurrentRoute: data section", () => {
  it.each<
    [
      string,
      string,
      Record<string, string | undefined>,
      Record<string, unknown>,
      CurrentRoute,
    ]
  >([
    ["index", dataIndexRoute.id, {}, {}, { kind: "data-index" }],
    [
      "space",
      dataSpaceRoute.id,
      { spaceId: "space_seed_raise" },
      {},
      { kind: "data-space", spaceId: "space_seed_raise" },
    ],
    [
      "records table ignores table search state",
      dataTypeRoute.id,
      { spaceId: "space_seed_raise", typeSlug: "investor" },
      { sort: "stage", dir: "asc", peek: "rec_seed_1" },
      { kind: "data-type", spaceId: "space_seed_raise", typeSlug: "investor" },
    ],
    [
      "settings defaults to the general tab",
      dataTypeSettingsRoute.id,
      { spaceId: "s", typeSlug: "investor" },
      {},
      {
        kind: "data-type-settings",
        spaceId: "s",
        typeSlug: "investor",
        tab: "general",
      },
    ],
    [
      "settings attributes tab",
      dataTypeSettingsRoute.id,
      { spaceId: "s", typeSlug: "investor" },
      { tab: "attributes" },
      {
        kind: "data-type-settings",
        spaceId: "s",
        typeSlug: "investor",
        tab: "attributes",
      },
    ],
    [
      "settings garbage tab falls back to general",
      dataTypeSettingsRoute.id,
      { spaceId: "s", typeSlug: "investor" },
      { tab: 7 },
      {
        kind: "data-type-settings",
        spaceId: "s",
        typeSlug: "investor",
        tab: "general",
      },
    ],
    [
      "record",
      dataRecordRoute.id,
      { spaceId: "s", recordId: "rec_seed_1" },
      {},
      { kind: "data-record", spaceId: "s", recordId: "rec_seed_1" },
    ],
  ])("%s", (_label, routeId, params, search, expected) => {
    expect(deriveCurrentRoute(routeId, params, search)).toEqual(expected);
  });
});

describe("data section registry wiring", () => {
  it("is a first-class sidebar destination", () => {
    expect(isFirstClassAppId("data")).toBe(true);
    expect(SIDEBAR_TOOLS.find((tool) => tool.id === "data")).toMatchObject({
      label: "Data",
      kind: "first-class",
    });
  });

  it("documents table state as URL search on the records route", () => {
    const contract = ROUTE_CONTRACTS.find((c) => c.key === "dataType");
    expect(contract?.search).toEqual([
      "sort",
      "dir",
      "q",
      "page",
      "size",
      "peek",
      "filter",
    ]);
  });

  it("matches the settings path ahead of the records table path", () => {
    const matches = router.matchRoutes(
      "/data/space_seed_raise/t/investor/settings",
    );
    expect(matches.at(-1)?.routeId).toBe(dataTypeSettingsRoute.id);
  });

  it("keeps a type slugged like a static segment out of the record route", () => {
    const matches = router.matchRoutes("/data/space_seed_raise/t/r");
    expect(matches.at(-1)?.routeId).toBe(dataTypeRoute.id);
  });

  it("navigates the sidebar entry to /data", async () => {
    navigateToSidebarApp("data");
    await router.load();
    expect(router.state.location.pathname).toBe("/data");
  });
});
