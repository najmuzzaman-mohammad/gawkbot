// AppIntegrationBanner — the host-side answer to an app that says "No CRM
// connected" with nowhere to click. The sandboxed app iframe cannot reach the
// host's connect flow, so when a READY bot's own description references
// external systems that are not connected, the UI tab shows this banner above
// the frame: what the bot wants, and gate-style connect rows (logo + name +
// live Connect) to fix it in place. It disappears on its own the moment the
// referenced systems are live — or stays hidden for this app if dismissed.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";

import type { CustomApp } from "../../api/apps";
import {
  describedIntegrations,
  type GateConnectTarget,
  missingIntegrations,
  resolveGateTargets,
} from "../builder/describedIntegrations";
import { IntegrationConnectRows } from "./IntegrationConnectRows";

const DISMISS_KEY_PREFIX = "wuphf.operator.integrationBanner.dismissed.";

function isDismissed(appId: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY_PREFIX + appId) === "1";
  } catch {
    return false;
  }
}

export function AppIntegrationBanner({ app }: { app: CustomApp }) {
  const [dismissed, setDismissed] = useState(() => isDismissed(app.id));
  const queryClient = useQueryClient();

  // What the bot's own words say it wants, minus what is connected. Polled
  // gently so connecting (here or anywhere else) clears the banner without a
  // reload. Resolves [] on any API failure — the banner never blocks the app.
  const refs = describedIntegrations(
    `${app.summary ?? ""} ${app.description ?? ""}`,
  );
  const wanted = useQuery({
    queryKey: ["app-integration-banner", app.id],
    enabled: !dismissed && refs.length > 0,
    queryFn: async (): Promise<GateConnectTarget[]> => {
      const missing = await missingIntegrations(refs);
      if (missing.length === 0) return [];
      const targets = await resolveGateTargets(missing);
      return targets.filter((t) => !t.connected);
    },
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) > 0 ? 5_000 : false,
    staleTime: 0,
  });

  const targets = wanted.data ?? [];

  // The moment everything lands, refresh the app frame's dependents so the
  // app itself can pick up the new connections on its next data read.
  useEffect(() => {
    if (wanted.isSuccess && targets.length === 0) {
      void queryClient.invalidateQueries({
        queryKey: ["operator-app", app.id],
      });
    }
  }, [wanted.isSuccess, targets.length, queryClient, app.id]);

  if (dismissed || refs.length === 0 || targets.length === 0) return null;

  const labels = refs.map((r) => r.label);
  const joined =
    labels.length <= 1
      ? labels.join("")
      : labels.length === 2
        ? labels.join(" and ")
        : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  // "Any one is enough" applies when the refs are a family — either the
  // generic word ("a CRM") or several named products from the same family.
  const CRM_FAMILY = new Set(["hubspot", "salesforce", "pipedrive"]);
  const familyOnly =
    refs.some((r) => r.generic) ||
    (refs.length > 1 &&
      refs.every((r) => r.platforms.some((p) => CRM_FAMILY.has(p))));
  return (
    <div className="opr-app-int-banner">
      <div className="opr-app-int-banner-head">
        <span className="opr-app-int-banner-lead">
          This app wants {joined} — connect below and it runs on live data.
          {familyOnly ? " Any one CRM is enough." : ""}
        </span>
        <button
          type="button"
          className="opr-icon-btn"
          aria-label="Dismiss — keep running on workspace data"
          title="Dismiss — keep running on workspace data"
          onClick={() => {
            setDismissed(true);
            try {
              window.localStorage.setItem(DISMISS_KEY_PREFIX + app.id, "1");
            } catch {
              // Session-only dismiss is fine.
            }
          }}
        >
          <X size={14} strokeWidth={1.9} aria-hidden={true} />
        </button>
      </div>
      <IntegrationConnectRows targets={targets} />
    </div>
  );
}
