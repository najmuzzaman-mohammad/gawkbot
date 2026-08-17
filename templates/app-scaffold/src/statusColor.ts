// statusColor — map a workflow status/severity to a Mantine color name, so
// state reads at a glance (a chip, a badge, a dot) instead of as plain text.
// DESIGN.md §7 points at this as the pattern; use it for every status you
// render rather than hardcoding colors per component.
//
// Extend the map for your domain's own states — the point is ONE place that
// decides "approved is green, blocked is red", not a scatter of inline colors.

const STATUS_COLORS: Record<string, string> = {
  // good / done
  approved: "green",
  done: "green",
  complete: "green",
  active: "green",
  paid: "green",
  ready: "green",
  // attention / in-progress
  pending: "yellow",
  review: "yellow",
  waiting: "yellow",
  "in progress": "blue",
  building: "blue",
  // bad / blocked
  rejected: "red",
  blocked: "red",
  failed: "red",
  overdue: "red",
  churn: "red",
  // neutral
  draft: "gray",
  archived: "gray",
  inactive: "gray",
};

export function statusColor(status: string | null | undefined): string {
  const key = (status ?? "").trim().toLowerCase();
  return STATUS_COLORS[key] ?? "gray";
}
