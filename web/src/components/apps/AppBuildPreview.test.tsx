import { describe, expect, it } from "vitest";

import type { CustomApp } from "../../api/apps";
import {
  buildPreviewPlaceholder,
  parseAppNameFromTaskTitle,
  resolveAppForTask,
} from "./AppBuildPreview";

function makeApp(overrides: Partial<CustomApp>): CustomApp {
  return {
    id: "app_0000000000000000",
    slug: "app",
    name: "App",
    icon: "🧩",
    entry: "index.html",
    version: 1,
    createdBy: "app-builder",
    createdAt: "2026-06-15T00:00:00Z",
    updatedAt: "2026-06-15T00:00:00Z",
    contentHash: "abc",
    ...overrides,
  };
}

describe("parseAppNameFromTaskTitle", () => {
  it("parses the App Builder task title verbs", () => {
    expect(parseAppNameFromTaskTitle("Build app: Daily Bot Digest")).toBe(
      "Daily Bot Digest",
    );
    expect(parseAppNameFromTaskTitle("Improve app: Lead Scorer")).toBe(
      "Lead Scorer",
    );
    // Case-insensitive verb + trims surrounding whitespace.
    expect(parseAppNameFromTaskTitle("  improve APP:  Lead Scorer  ")).toBe(
      "Lead Scorer",
    );
  });

  it("returns null for non-app task titles", () => {
    expect(parseAppNameFromTaskTitle("Fix the login bug")).toBeNull();
    expect(parseAppNameFromTaskTitle("appify the dashboard")).toBeNull();
    expect(parseAppNameFromTaskTitle("")).toBeNull();
  });
});

describe("resolveAppForTask", () => {
  it("matches the app by name, case-insensitively", () => {
    const apps = [
      makeApp({ id: "app_a", name: "Lead Scorer" }),
      makeApp({ id: "app_b", name: "Daily Bot Digest" }),
    ];
    expect(resolveAppForTask(apps, "daily bot digest")?.id).toBe("app_b");
  });

  it("prefers the most recently updated app when names collide", () => {
    const apps = [
      makeApp({
        id: "app_old",
        name: "Digest",
        updatedAt: "2026-06-15T00:00:00Z",
      }),
      makeApp({
        id: "app_new",
        name: "Digest",
        updatedAt: "2026-06-15T02:00:00Z",
      }),
    ];
    expect(resolveAppForTask(apps, "Digest")?.id).toBe("app_new");
  });

  it("returns undefined when nothing matches or the name is null", () => {
    const apps = [makeApp({ name: "Lead Scorer" })];
    expect(resolveAppForTask(apps, "Daily Bot Digest")).toBeUndefined();
    expect(resolveAppForTask(apps, null)).toBeUndefined();
    expect(resolveAppForTask([], "Anything")).toBeUndefined();
  });

  // ── The CREATE path specifically ──────────────────────────────────────────
  // An IMPROVE task always name-matches: composeAppBrief takes the name FROM
  // the app it is improving, so title and manifest agree by construction. A
  // BUILD task's name is whatever the human typed, and the App Builder
  // registers under whatever name it picks — so on the create path, and only
  // there, the name drifts and the preview binds to nothing. The task's channel
  // is the app's own `editChannel` (stampAppEditChannelForTaskLocked), which is
  // the same key the broker correlates on in appBuilderRunTaskID.
  it("binds a build task to its app by edit channel when the name drifted", () => {
    const apps = [
      makeApp({
        id: "app_bound",
        name: "Standup Digest Dashboard",
        editChannel: "app-3318caab6fd1a80e",
      }),
    ];
    expect(
      resolveAppForTask(apps, "Standup Digest", "app-3318caab6fd1a80e")?.id,
    ).toBe("app_bound");
  });

  it("prefers the channel-bound app over a same-named different app", () => {
    const apps = [
      makeApp({
        id: "app_other",
        name: "Digest",
        updatedAt: "2026-06-15T09:00:00Z",
      }),
      makeApp({
        id: "app_bound",
        name: "Digest",
        editChannel: "app-dbed400bfc9f5e49",
        updatedAt: "2026-06-15T01:00:00Z",
      }),
    ];
    expect(resolveAppForTask(apps, "Digest", "app-dbed400bfc9f5e49")?.id).toBe(
      "app_bound",
    );
  });

  it("still falls back to the name when the task has no app channel", () => {
    const apps = [makeApp({ id: "app_a", name: "Lead Scorer" })];
    // An improve task routed through the App Builder DM, plus the owner's DM
    // channel of a task that was never bound: neither names an app, so the
    // title is all there is.
    expect(
      resolveAppForTask(apps, "Lead Scorer", "app-builder__human")?.id,
    ).toBe("app_a");
    expect(resolveAppForTask(apps, "Lead Scorer", undefined)?.id).toBe("app_a");
  });

  it("does not bind on an empty channel, which every unbound app shares", () => {
    // `editChannel` is absent for html-only and legacy apps. An empty task
    // channel must not match them — that would hand a task some arbitrary
    // unbound app's live preview.
    const apps = [makeApp({ id: "app_a", name: "Lead Scorer" })];
    expect(resolveAppForTask(apps, null, "")).toBeUndefined();
  });
});

describe("buildPreviewPlaceholder", () => {
  // Regression: a chat-born build task ("hey, build me a fundraising CRM" ->
  // the Chief of Staff mints "Build a fundraising CRM app") never gets an app
  // pre-scaffolded, so nothing links it to the app the build published. The
  // pane used to sit on "the live preview appears here the moment the App
  // Builder publishes its first version" FOREVER — still promising a first
  // version 40 minutes after that version shipped and the app went live.
  it("does not promise a preview for a task no app is linked to", () => {
    const state = buildPreviewPlaceholder(null, true);
    expect(state.kind).toBe("unbound");
    expect(state.detail).not.toMatch(/first version/i);
  });

  it("keeps the building promise while the named app is still publishing", () => {
    const state = buildPreviewPlaceholder("Standup Digest", true);
    expect(state.kind).toBe("building");
    expect(state.title).toMatch(/Standup Digest/);
  });

  it("stays neutral until the app list has loaded", () => {
    // Mid-load there is no evidence either way; claiming "not linked" would be
    // a worse lie than saying nothing.
    expect(buildPreviewPlaceholder(null, false).kind).toBe("waiting");
  });
});
