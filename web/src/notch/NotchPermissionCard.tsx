import type { NotchPermissions } from "./types";

/**
 * The two macOS grants a bot needs to work on this Mac, asked for only
 * when a bot is set to run here and one is missing. The app shows the
 * system prompt; the notch only says why, in plain words, and offers the
 * button. Nothing is captured until a bot is allowed a turn.
 */
export type PermissionKind = "accessibility" | "screen_recording";

export interface NotchPermissionCardProps {
  permissions: NotchPermissions;
  onRequest: (kind: PermissionKind) => void;
}

const GRANTS: ReadonlyArray<{
  kind: PermissionKind;
  name: string;
  why: string;
}> = [
  {
    kind: "accessibility",
    name: "Accessibility",
    why: "to read window names and press controls the way you would",
  },
  {
    kind: "screen_recording",
    name: "Screen Recording",
    why: "to see the window it is working in",
  },
];

export function permissionsMissing(
  p: NotchPermissions | undefined,
): PermissionKind[] {
  if (!p) return [];
  return GRANTS.filter((g) => !p[g.kind]).map((g) => g.kind);
}

export function NotchPermissionCard({
  permissions,
  onRequest,
}: NotchPermissionCardProps) {
  const missing = permissionsMissing(permissions);
  if (missing.length === 0) return null;
  return (
    <section className="nq nperm" aria-label="Permissions for bots on this Mac">
      <div className="nq-head">
        <strong>A bot wants to work on this Mac</strong>
      </div>
      <p className="nq-q">
        macOS asks once for each permission below. Nothing is captured or
        clicked until you allow a bot its turn, and ⌥Esc stops every bot at
        once.
      </p>
      <ul className="nperm-list">
        {GRANTS.map((g) => {
          const granted = permissions[g.kind];
          return (
            <li
              key={g.kind}
              className={`nperm-row${granted ? " is-granted" : ""}`}
            >
              <span className="nperm-name">
                {g.name}
                <small>{g.why}</small>
              </span>
              {granted ? (
                <span className="nperm-ok" aria-label={`${g.name} granted`}>
                  ✓
                </span>
              ) : (
                <button
                  type="button"
                  className="nbtn nbtn-primary"
                  onClick={() => onRequest(g.kind)}
                >
                  Allow {g.name}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
