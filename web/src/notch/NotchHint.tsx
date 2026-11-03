import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { IntegrationConnectResult } from "../api/integrations";
import { ToolkitBrandLogo } from "../components/apps/integrations/IntegrationLogos";
import { NOTCH_QUERY_KEY } from "./api";
import {
  connectFromHint,
  dismissHint,
  hintConnectStatus,
  markHintSeen,
} from "./hintApi";
import type { NotchHint as NotchHintData } from "./types";

/** The full-view page where sign-in and every connection lives. */
export const INTEGRATIONS_PATH = "/apps/integrations";

export interface NotchHintProps {
  hint: NotchHintData;
  /** Opens the full view at a path: where the hint sends what it cannot do itself. */
  onOpen: (path: string) => void;
}

/**
 * One quiet line under the headline when the app or page in front belongs
 * to an integration the office does not have yet: Connect, or Not now.
 * Connect opens the sign-in page in the browser and waits for it to land;
 * when the office is not signed in to integrations at all, or the platform
 * needs typed credentials, it opens the full view where those live.
 */
export function NotchHint({ hint, onOpen }: NotchHintProps) {
  const queryClient = useQueryClient();
  const [gone, setGone] = useState<string | null>(null);
  const [pending, setPending] = useState<IntegrationConnectResult | null>(null);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (seen.current === hint.platform) return;
    seen.current = hint.platform;
    void markHintSeen(hint.platform).catch(() => undefined);
  }, [hint.platform]);

  const connect = useMutation({
    mutationFn: () => connectFromHint(hint.platform),
    onSuccess: (result) => {
      if (result.status === "needs_fields" || !result.auth_url) {
        // Typed credentials, or nothing to open: the full view has the form.
        onOpen(INTEGRATIONS_PATH);
        return;
      }
      setPending(result);
    },
    onError: () => {
      // Not signed in to integrations yet, or the provider is down: the full
      // view explains and signs in; the hint has said what it can.
      onOpen(INTEGRATIONS_PATH);
    },
  });

  const status = useQuery({
    queryKey: ["notch-hint-connect", hint.platform, pending?.connect_id ?? ""],
    queryFn: () => hintConnectStatus(hint.platform, pending?.connect_id),
    enabled: pending !== null,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "connected" || s === "failed" ? false : 3_000;
    },
  });
  const landed = status.data?.status === "connected";

  useEffect(() => {
    if (!landed) return;
    // The broker now knows; the next poll drops the hint on its own.
    void queryClient.invalidateQueries({ queryKey: NOTCH_QUERY_KEY });
  }, [landed, queryClient]);

  if (gone === hint.platform) return null;

  const busy = connect.isPending || (pending !== null && !landed);
  return (
    <div className="nhint" data-testid="notch-hint" role="status">
      <span className="nhint-logo" aria-hidden="true">
        {hint.logo_url ? (
          <img src={hint.logo_url} alt="" width={18} height={18} />
        ) : (
          <ToolkitBrandLogo platform={hint.platform} />
        )}
      </span>
      <span className="nhint-line">
        {landed ? `${hint.name} connected.` : hint.line}
      </span>
      {landed ? null : (
        <span className="nhint-actions">
          <button
            type="button"
            className="nbtn is-primary"
            disabled={busy}
            onClick={() => connect.mutate()}
          >
            {busy ? "Waiting for the browser…" : "Connect"}
          </button>
          <button
            type="button"
            className="nbtn is-quiet"
            disabled={busy}
            onClick={() => {
              setGone(hint.platform);
              void dismissHint(hint.platform).catch(() => undefined);
            }}
          >
            Not now
          </button>
        </span>
      )}
    </div>
  );
}
