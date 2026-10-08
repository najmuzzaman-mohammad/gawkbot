import type { CSSProperties } from "react";

import type { MemberOrigin, OfficeMember } from "../../api/client";

// Two tags that answer "who made this bot?" and "where does it run?".
// Data comes from /office-members (origin, runs_on, runs_on_detail,
// managed_by); see internal/team/broker_member_origin.go.

const ORIGIN_LABELS: Record<MemberOrigin, string> = {
  user: "Made by you",
  chief_of_staff: "Hired by the Chief of Staff",
  bot: "Hired by a teammate",
  built_in: "Built in",
  adopted: "Adopted from this machine",
  imported: "Imported",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

function tagStyle(
  tone: "accent" | "green" | "yellow" | "muted",
): CSSProperties {
  const palette = {
    accent: { background: "var(--accent-bg)", color: "var(--accent)" },
    green: { background: "var(--green-bg)", color: "var(--green)" },
    yellow: { background: "var(--yellow-bg)", color: "var(--text)" },
    muted: { background: "var(--bg-warm)", color: "var(--text-secondary)" },
  }[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 11,
    fontWeight: 500,
    padding: "2px 8px",
    borderRadius: "var(--radius-full)",
    whiteSpace: "nowrap",
    ...palette,
  };
}

export function originLabel(origin: MemberOrigin | undefined): string {
  return origin ? ORIGIN_LABELS[origin] : "";
}

export function runsOnLabel(
  member: Pick<OfficeMember, "runs_on" | "runs_on_detail">,
): string {
  if (!member.runs_on) return "";
  const detail = member.runs_on_detail?.trim();
  if (member.runs_on === "elsewhere") {
    return detail ? `Runs elsewhere · ${detail}` : "Runs elsewhere";
  }
  return detail && detail !== "this machine"
    ? `Runs here · ${detail.replace(/ on this machine$/, "")}`
    : "Runs on this machine";
}

interface MemberProvenanceProps {
  member: Pick<
    OfficeMember,
    "origin" | "runs_on" | "runs_on_detail" | "managed_by"
  >;
}

export function MemberProvenance({ member }: MemberProvenanceProps) {
  const origin = originLabel(member.origin);
  const runsOn = runsOnLabel(member);
  if (!(origin || runsOn || member.managed_by)) return null;
  return (
    <div style={rowStyle} data-testid="member-provenance">
      {origin ? (
        <span
          style={tagStyle(member.origin === "user" ? "accent" : "muted")}
          data-origin={member.origin}
        >
          {origin}
        </span>
      ) : null}
      {runsOn ? (
        <span
          style={tagStyle(member.runs_on === "elsewhere" ? "yellow" : "green")}
          data-runs-on={member.runs_on}
        >
          {runsOn}
        </span>
      ) : null}
      {member.managed_by ? (
        <span style={tagStyle("muted")}>Managed by @{member.managed_by}</span>
      ) : null}
    </div>
  );
}
