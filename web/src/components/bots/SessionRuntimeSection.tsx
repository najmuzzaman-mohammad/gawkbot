import type { OfficeMember } from "../../api/client";

// The runtime section for a member that is a terminal session on this Mac.
// Read-only by design: the tool, the model, and the folder are what the
// session's own log says, so there is nothing here to choose or save. The
// broker refuses a runtime change for these members as well.

interface SessionRuntimeSectionProps {
  agent: Pick<OfficeMember, "runtime" | "session">;
}

const NOT_KNOWN = "Not known yet";

export function SessionRuntimeSection({ agent }: SessionRuntimeSectionProps) {
  const tool = agent.runtime?.harness_name || agent.session?.tool || "";
  const model = agent.runtime?.model_label || agent.runtime?.model || "";
  const folder = agent.session?.cwd || agent.session?.project || "";
  const rows = [
    { label: "tool", value: tool },
    { label: "model", value: model },
    { label: "folder", value: folder },
  ];
  return (
    <div className="bot-profile-section" data-testid="session-runtime-section">
      <div className="bot-profile-section-title">runtime</div>
      <div className="bot-profile-permissions">
        {rows.map((row) => (
          <div className="bot-profile-perm-row" key={row.label}>
            <span className="bot-profile-perm-label">{row.label}</span>
            <span
              className="bot-profile-perm-value"
              data-testid={`session-runtime-${row.label}`}
              title={row.value || undefined}
            >
              {row.value || NOT_KNOWN}
            </span>
          </div>
        ))}
      </div>
      <p className="bot-profile-role-text">
        Read from the session in your terminal. It cannot be changed here.
      </p>
    </div>
  );
}
