// The gate-style connect rows: one row per catalog-resolved integration —
// logo, name, and a live Connect button (the full ConnectIntegrationCard
// flow: Composio sign-in gate → OAuth → status polling). Shared between the
// build gate (AppBuilderChat) and the app-detail integration banner so both
// surfaces offer the fix, not just the observation.

import type { BotRequest } from "../../api/client";
import { ConnectIntegrationCard } from "../../components/messages/ConnectIntegrationCard";
import type { GateConnectTarget } from "../builder/describedIntegrations";

// A synthetic `connect` request so ConnectIntegrationCard can drive the real
// connect flow for one row. Local id — never answers a real broker request.
function connectRequest(target: GateConnectTarget): BotRequest {
  return {
    id: `connect-row-${target.provider}-${target.platform}`,
    from: "",
    question: "",
    title: `Connect ${target.label}`,
    platform: target.platform,
    kind: "connect",
  };
}

export function IntegrationConnectRows({
  targets,
}: {
  targets: GateConnectTarget[];
}) {
  if (targets.length === 0) return null;
  return (
    <ul className="opr-gate-connect-list">
      {targets.map((t) => (
        <li
          key={`${t.provider}:${t.platform}`}
          className="opr-gate-connect-row"
        >
          <ConnectIntegrationCard
            request={connectRequest(t)}
            submitting={false}
            logoUrl={t.logoUrl}
            onSkip={() => {}}
            onDismiss={() => {}}
          />
        </li>
      ))}
    </ul>
  );
}
