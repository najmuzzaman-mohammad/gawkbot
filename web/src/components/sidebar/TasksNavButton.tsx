// biome-ignore-all lint/a11y/useAriaPropsSupportedByRole: Badge mirrors AppList — aria-label on the span surfaces the pending count to assistive tech.
import { useEffect, useRef } from "react";
import { ClipboardCheck } from "lucide-react";

import { useOfficeStats } from "../../hooks/useOfficeStats";
import { needsYouCount } from "../../lib/needsYou";
import { playInboxDing } from "../../lib/notificationSound";
import { navigateToSidebarApp } from "../../lib/sidebarNav";
import { useCurrentApp } from "../../routes/useCurrentRoute";

/**
 * Tasks nav entry — the primary Work surface. Renders the same DOM/class
 * set as every other sidebar app (AppList) and carries the attention
 * badge + chime that used to live on the standalone Inbox button.
 *
 * The badge count comes from lib/needsYou — the single definition the
 * header strip and the board's Needs-human lane also use. It is NOT
 * `inbox_attention`: that counts every request kind including notices, so
 * reading it here made the badge show a number the strip called "all quiet".
 * Clicking opens the board at /tasks, where the same items live in the
 * "Needs human input" lane.
 */
export function TasksNavButton() {
  const currentApp = useCurrentApp();
  const { data: stats } = useOfficeStats();
  const count = needsYouCount(stats);

  const lastCountRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = lastCountRef.current;
    if (prev !== null && count > prev) {
      playInboxDing();
    }
    lastCountRef.current = count;
  }, [count]);

  const isActive = currentApp === "tasks";

  return (
    <button
      type="button"
      className={`sidebar-item${isActive ? " active" : ""}`}
      onClick={() => navigateToSidebarApp("tasks")}
    >
      <ClipboardCheck className="sidebar-item-icon" />
      <span style={{ flex: 1 }}>Tasks</span>
      {count > 0 ? (
        <span
          className="sidebar-badge"
          aria-label={`${count} pending`}
          data-testid="inbox-unread-badge"
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
