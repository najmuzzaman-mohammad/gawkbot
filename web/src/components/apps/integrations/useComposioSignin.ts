import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  type ComposioSigninState,
  getComposioSigninStatus,
  startComposioSignin,
} from "../../../api/integrations";

// The "Sign in with Composio" state machine, extracted so every surface that
// needs it drives the same one: the first-run onboarding hero, and the
// sign-in-expired panel that replaces a raw 401 anywhere an integration call
// fails. Mirrors internal/team/broker_composio_signin.go.

export type SigninPhase =
  | "idle"
  | "installing"
  | "cli_missing"
  | "awaiting_login"
  | "provisioning"
  | "done"
  | "error";

export interface UseComposioSigninResult {
  phase: SigninPhase;
  authUrl: string;
  installCommand: string;
  /** Broker-supplied reason for a failed flow. Never a raw protocol error. */
  error: string;
  /** True while the start request itself is in flight. */
  starting: boolean;
  start: () => void;
}

interface UseComposioSigninOptions {
  /** Called once when the flow reaches `done`. */
  onDone: () => void;
}

const POLLING_PHASES: readonly SigninPhase[] = [
  "installing",
  "awaiting_login",
  "provisioning",
];

export function useComposioSignin({
  onDone,
}: UseComposioSigninOptions): UseComposioSigninResult {
  const [phase, setPhase] = useState<SigninPhase>("idle");
  const [authUrl, setAuthUrl] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [error, setError] = useState("");
  // Auto-open the login URL once per flow; re-renders and status polls must
  // not spawn extra tabs.
  const openedRef = useRef(false);

  const apply = useCallback(
    (state: ComposioSigninState) => {
      switch (state.status) {
        case "installing":
          // The broker is auto-installing the Composio CLI before it can mint
          // a login URL. We must enter (and keep polling) this phase — without
          // it the page would stall on "idle" and never open the sign-in tab.
          setPhase("installing");
          setInstallCommand(state.install_command ?? "");
          break;
        case "cli_missing":
          setPhase("cli_missing");
          setInstallCommand(state.install_command ?? "");
          break;
        case "awaiting_login":
          setPhase("awaiting_login");
          setAuthUrl(state.auth_url ?? "");
          if (state.auth_url && !openedRef.current) {
            openedRef.current = true;
            window.open(state.auth_url, "_blank", "noopener");
          }
          break;
        case "provisioning":
          setPhase("provisioning");
          break;
        case "done":
          setPhase("done");
          onDone();
          break;
        case "error":
          setPhase("error");
          setError(state.reason ?? "Sign-in failed. Try again.");
          break;
        default:
          break;
      }
    },
    [onDone],
  );

  const mutation = useMutation({
    mutationFn: startComposioSignin,
    onSuccess: apply,
    onError: (err: unknown) => {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Could not start sign-in");
    },
  });

  const polling = POLLING_PHASES.includes(phase);
  const statusQuery = useQuery({
    queryKey: ["composio-signin-status"],
    queryFn: getComposioSigninStatus,
    enabled: polling,
    refetchInterval: polling ? 1500 : false,
  });
  const statusState = statusQuery.data;
  useEffect(() => {
    if (polling && statusState) apply(statusState);
  }, [polling, statusState, apply]);

  const start = useCallback(() => {
    openedRef.current = false;
    setError("");
    mutation.mutate();
  }, [mutation]);

  return {
    phase,
    authUrl,
    installCommand,
    error,
    starting: mutation.isPending,
    start,
  };
}
