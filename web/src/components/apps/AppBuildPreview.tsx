import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { OpenNewWindow } from "iconoir-react";

import { type CustomApp, getApp, listApps } from "../../api/apps";
import { APP_BUILDER_SLUG } from "../../lib/constants";
import { router } from "../../lib/router";
import { AppLivePreview } from "./AppLivePreview";
import { TaskActivity } from "./TaskActivity";

// Poll briefly while a build is in flight so a freshly-registered app (or a new
// version) shows up in the preview within a few seconds, no reload needed.
const PREVIEW_POLL_MS = 4000;

/**
 * Parse the app name out of an App Builder task title. Both the slash-command
 * path (api/apps.ts) and the broker proposal path (broker_apps_proposal.go)
 * format the title as "<verb> app: <name>", so this is a reliable correlation
 * without a wire-shape change. Returns null when the title isn't an app task.
 */
export function parseAppNameFromTaskTitle(title: string): string | null {
  const match = title.match(
    /^\s*(?:build|improve|create|update)\s+app:\s*(.+?)\s*$/i,
  );
  return match ? match[1] : null;
}

/**
 * Pick the app a build task is producing.
 *
 * The task's CHANNEL is the exact key and is tried first: the broker binds an
 * app-build task to its app's own `editChannel`
 * (stampAppEditChannelForTaskLocked) and correlates the same way in the other
 * direction (appBuilderRunTaskID). It is stable across a rename and survives
 * the task's details being rewritten with a completion summary.
 *
 * The name is the fallback, and it is a heuristic. It holds on the IMPROVE path
 * by construction — composeAppBrief takes the name FROM the app being improved,
 * so title and manifest cannot disagree. On the CREATE path the title carries
 * the name the human asked for and the App Builder registers under whatever
 * name it picks, so any drift used to leave the pane bound to nothing forever.
 * Exact match only, newest wins; never a fuzzy match, because binding the wrong
 * app would put another tool's live preview inside this build.
 */
export function resolveAppForTask(
  apps: CustomApp[],
  appName: string | null,
  taskChannel?: string,
): CustomApp | undefined {
  const channel = taskChannel?.trim();
  if (channel) {
    // `editChannel` is absent on html-only and legacy apps, so an empty channel
    // must never match — it would hand this task an arbitrary unbound app.
    const bound = apps.find((a) => a.editChannel?.trim() === channel);
    if (bound) return bound;
  }
  if (!appName) return undefined;
  const wanted = appName.trim().toLowerCase();
  const matches = apps.filter((a) => a.name.trim().toLowerCase() === wanted);
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  )[0];
}

/** What the pane says while no app is bound to the task. */
export interface BuildPreviewPlaceholder {
  kind: "waiting" | "building" | "unbound";
  title: string;
  detail: string;
}

/**
 * Decide the honest placeholder for a task with no app bound yet.
 *
 * "building" promises a preview, so it is only used when the title actually
 * names an app that is on its way. A task that identifies no app at all — a
 * chat-born build, where a bot minted the task with a prose title and the
 * broker therefore never pre-scaffolded an app — has nothing coming, and must
 * not keep promising a first version that already shipped somewhere else.
 */
export function buildPreviewPlaceholder(
  appName: string | null,
  appsLoaded: boolean,
): BuildPreviewPlaceholder {
  if (appName) {
    return {
      kind: "building",
      title: `Building ${appName}…`,
      detail:
        "The live preview appears here the moment the App Builder publishes its first version.",
    };
  }
  if (!appsLoaded) {
    return {
      kind: "waiting",
      title: "Waiting for the App Builder…",
      detail: "Looking for the app this task is building.",
    };
  }
  return {
    kind: "unbound",
    title: "No app is linked to this task",
    detail:
      "Nothing here names the app this task built, so there is no preview to show. If the build finished, the app is in the sidebar under Apps.",
  };
}

interface AppBuildPreviewProps {
  /** The task title — the app name is parsed from it. */
  taskTitle: string;
  /** The task id — scopes the live build-activity feed to this build. */
  taskId?: string;
  /**
   * The task's conversation home. For an app-build task this IS the app's
   * `editChannel`, which is how the preview binds to the app it is building.
   */
  taskChannel?: string;
}

/**
 * AppBuildPreview is the live preview pane shown beside the chat on an App
 * Builder task. It stacks a live build-activity feed (what the bot is doing,
 * resolving ✓/✗) above a live preview of the app being built — the app is
 * resolved by name and rendered in the same hardened sandbox as the full app
 * surface, refreshing as new versions are published. Until the first version
 * lands it shows a building placeholder, so the 20–60s build is never dead air.
 */
export function AppBuildPreview({
  taskTitle,
  taskId,
  taskChannel,
}: AppBuildPreviewProps) {
  const appName = useMemo(
    () => parseAppNameFromTaskTitle(taskTitle),
    [taskTitle],
  );

  const appsQuery = useQuery({
    queryKey: ["apps"],
    queryFn: listApps,
    refetchInterval: PREVIEW_POLL_MS,
  });

  const app = useMemo(
    () => resolveAppForTask(appsQuery.data ?? [], appName, taskChannel),
    [appsQuery.data, appName, taskChannel],
  );

  const detail = useQuery({
    queryKey: ["app", app?.id],
    queryFn: () => getApp(app?.id ?? ""),
    enabled: Boolean(app?.id),
    refetchInterval: PREVIEW_POLL_MS,
  });

  const preview = (() => {
    if (!(app && detail.data)) {
      const placeholder = buildPreviewPlaceholder(appName, appsQuery.isSuccess);
      return (
        <section className="app-build-preview" aria-label="App preview">
          <div className="app-build-preview__header">
            <span className="app-build-preview__title">Preview</span>
          </div>
          <div className="app-build-preview__state" role="status">
            {/* No spinner once we know nothing is coming — a spinner IS a
                promise of progress. */}
            {placeholder.kind === "unbound" ? null : (
              <span className="app-build-preview__spinner" aria-hidden="true" />
            )}
            <p className="app-build-preview__state-title">
              {placeholder.title}
            </p>
            <p className="app-build-preview__state-detail">
              {placeholder.detail}
            </p>
          </div>
        </section>
      );
    }

    const { app: meta } = detail.data;
    return (
      <section className="app-build-preview" aria-label="App preview">
        <div className="app-build-preview__header">
          <span className="app-build-preview__icon" aria-hidden="true">
            {meta.icon || "🧩"}
          </span>
          <span className="app-build-preview__title" title={meta.name}>
            {meta.name}
          </span>
          <span className="app-build-preview__live">
            <span className="app-build-preview__live-dot" aria-hidden="true" />
            Live
          </span>
          <span
            className="app-build-preview__version"
            title={`Updated ${meta.updatedAt}`}
          >
            v{meta.version}
          </span>
          <button
            type="button"
            className="app-build-preview__open"
            aria-label="Open app full screen"
            title="Open full screen"
            onClick={() =>
              void router.navigate({
                to: "/apps/$appId",
                params: { appId: meta.id },
              })
            }
          >
            <OpenNewWindow width={14} height={14} />
          </button>
        </div>
        <div className="app-build-preview__frame">
          <AppLivePreview appId={meta.id} title={meta.name} />
        </div>
      </section>
    );
  })();

  return (
    <div className="app-build-pane">
      {taskId ? (
        <TaskActivity taskId={taskId} agentSlug={APP_BUILDER_SLUG} />
      ) : null}
      {preview}
    </div>
  );
}
