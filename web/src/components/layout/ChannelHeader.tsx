import { useQuery } from "@tanstack/react-query";

import { listApps } from "../../api/apps";
import { useChannels } from "../../hooks/useChannels";
import { deriveBreadcrumbs } from "../../hooks/useObjectBreadcrumb";
import { appTitle } from "../../lib/constants";
import { useCurrentRoute } from "../../routes/useCurrentRoute";
import { useAppStore } from "../../stores/app";
import { Breadcrumb } from "./Breadcrumb";
import { ThemeSwitcher } from "./ThemeSwitcher";

function headerTitleAndDesc(
  route: ReturnType<typeof useCurrentRoute>,
  channels: { slug: string; description?: string }[],
  customAppName?: string,
): { title: string; desc: string } {
  switch (route.kind) {
    case "channel": {
      const ch = channels.find((c) => c.slug === route.channelSlug);
      return {
        title: `# ${route.channelSlug}`,
        desc: ch?.description || "",
      };
    }
    case "app":
      return { title: customAppName ?? appTitle(route.appId), desc: "" };
    case "task-board":
    case "task-detail":
      return { title: appTitle("tasks"), desc: "" };
    case "wiki":
    case "wiki-article":
    case "wiki-lookup":
      return { title: appTitle("wiki"), desc: "" };
    case "article":
      return { title: "Article", desc: "" };
    case "inbox":
      return { title: "Decision Inbox", desc: "" };
    case "task-decision":
      return { title: `Task ${route.taskId}`, desc: "" };
    case "task-new":
      return { title: "New task", desc: "" };
    case "agents":
      return { title: "Bots", desc: "" };
    case "bot-detail":
      return { title: `@${route.agentSlug}`, desc: "" };
    case "skill-detail":
      return { title: `Skill: ${route.skillName}`, desc: "" };
    case "routine-detail":
      return { title: route.routineSlug, desc: "Routine" };
    case "routine-new":
      return { title: "New scheduled task", desc: "" };
    case "home":
      return { title: "", desc: "" };
    case "unknown":
      return { title: "", desc: "" };
    default: {
      const _exhaustive: never = route;
      void _exhaustive;
      return { title: "", desc: "" };
    }
  }
}

export function ChannelHeader() {
  const route = useCurrentRoute();
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const { data: channels = [] } = useChannels();
  // A custom app's breadcrumb should read "Recruiting Bot", not the
  // title-cased record id ("App_ad2f6211ad746d37"). The apps list is already
  // polled for the sidebar, so this is a cache read, not a new request.
  const { data: apps = [] } = useQuery({
    queryKey: ["apps"],
    queryFn: listApps,
    staleTime: 15_000,
  });
  const customAppName =
    route.kind === "app"
      ? apps.find((a) => a.id === route.appId)?.name
      : undefined;

  const { title, desc } = headerTitleAndDesc(route, channels, customAppName);
  // customAppName has to reach the breadcrumb too, not just `title`: on the
  // app route breadcrumbItems is non-empty, so <Breadcrumb> renders and the
  // `title` branch below never runs — the resolved name was being computed
  // and then discarded, leaving the raw "App_ad2f6211ad746d37" on screen.
  const breadcrumbItems = deriveBreadcrumbs(route, customAppName);

  return (
    <div className="channel-header">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
          flex: 1,
        }}
      >
        {breadcrumbItems.length > 0 ? (
          <Breadcrumb items={breadcrumbItems} />
        ) : (
          <>
            <span className="channel-title">{title}</span>
            {desc ? <span className="channel-desc">{desc}</span> : null}
          </>
        )}
      </div>
      <div className="channel-actions">
        <ThemeSwitcher />
        <button
          type="button"
          className="sidebar-btn"
          title="Search"
          aria-label="Search"
          onClick={() => setSearchOpen(true)}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>
      </div>
    </div>
  );
}
