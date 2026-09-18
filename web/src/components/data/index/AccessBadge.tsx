import type { SpaceAccess } from "../../../api/dataspaces";
import { describeAccess } from "../../../api/dataspacesAccess";

import "../../../styles/data-schema.css";

interface AccessBadgeProps {
  access: SpaceAccess;
}

const LEVEL_WORDS = { read: "can read", write: "can write" } as const;

/** Every grant with its level, for the "Shared with 3 bots" case. */
function accessTitle(access: SpaceAccess): string {
  if (access.scope === "global") {
    return "Every bot in the office reads and writes.";
  }
  if (access.scope === "private" || access.grants.length === 0) {
    return "Only the owner bot and you.";
  }
  return access.grants
    .map((grant) => `@${grant.bot} ${LEVEL_WORDS[grant.level]}`)
    .join(", ");
}

/**
 * Who can use a space, as text. The treatment carries meaning only: Global is
 * the accent because it is the widest reach, Shared is a neutral outline, and
 * Private is plain muted text.
 */
export function AccessBadge({ access }: AccessBadgeProps) {
  const scope =
    access.scope === "shared" && access.grants.length === 0
      ? "private"
      : access.scope;
  return (
    <span
      className={`data-access-badge data-access-badge--${scope}`}
      title={accessTitle(access)}
    >
      {describeAccess(access)}
    </span>
  );
}
