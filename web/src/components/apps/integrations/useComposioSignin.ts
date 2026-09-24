import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  type ComposioSigninState,
  cancelComposioSignin,
  getComposioSigninStatus,
  startComposioSignin,
} from "../../../api/integrations";

// The "Sign in with Composio" state machine, extracted so every surface that
// needs it drives the same one: the first-run onboarding hero, and the
// sign-in panel that replaces a raw 401 anywhere an integration call fails.
// Mirrors internal/team/broker_composio_signin.go.
//
// `autoStart` is the connect-time behaviour: a person who clicked Connect has
// already said what they want, so the sign-in begins by itself rather than
// behind a second button. Three things keep that honest, and all three are
// enforced by the broker as well as here:
//
//   - It is visible and stoppable — `cancel` is on every in-progress phase.
//   - It never installs software. A missing CLI lands on `install_required`,
//     which asks; `confirmInstall` is the yes.
//   - It fires at most once per mount, and the broker refuses a second
//     automatic start after a cancel or a failure (it answers `idle`, which
//     puts the explicit button back).

export type SigninPhase =
  | "idle"
  | "installing"
  | "install_required"
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
  /** Start the flow because the user asked for it. */
  start: () => void;
  /** Answer `install_required` with yes, which permits the one-time setup. */
  confirmInstall: () => void;
  /** Stop a flow the user did not ask for (or no longer wants). */
  cancel: () => void;
}

interface UseComposioSigninOptions {
  /** Called once when the flow reaches `done`. */
  onDone: () => void;
  /**
   * Begin the flow on mount, without waiting for a click. Set by a surface
   * that got here because the user already asked for something that needs a
   * Composio sign-in.
   */
  autoStart?: boolean;
}

const POLLING_PHASES: readonly SigninPhase[] = [
  "installing",
  "awaiting_login",
  "provisioning",
];

export function useComposioSignin({
  onDone,
  autoStart = false,
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
          // The broker is installing the Composio CLI before it can mint a
          // login URL. We must enter (and keep polling) this phase — without
          // it the page would stall on "idle" and never open the sign-in tab.
          setPhase("installing");
          setInstallCommand(state.install_command ?? "");
          break;
        case "install_required":
          setPhase("install_required");
          setInstallCommand(state.install_command ?? "");
          break;
        case "cli_missing":
          setPhase("cli_missing");
          setInstallCommand(state.install_command ?? "");
          setError(state.reason ?? "");
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
    mutationFn: (options: { auto: boolean }) => startComposioSignin(options),
    onSuccess: (state: ComposioSigninState) => {
      if (state.status === "idle") {
        // The broker declined to start one automatically: an earlier attempt
        // was cancelled or failed. Idle is what renders the explicit button,
        // which is exactly the fallback we want. Only the START answer is read
        // this way — a status poll returning idle is a flow the broker lost,
        // and the in-progress panel keeps its own cancel for that.
        setPhase("idle");
        return;
      }
      apply(state);
    },
    onError: (err: unknown) => {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Could not start sign-in");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: cancelComposioSignin,
    onSuccess: () => {
      openedRef.current = false;
      setAuthUrl("");
      setError("");
      setPhase("idle");
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

  const { mutate } = mutation;
  const start = useCallback(() => {
    openedRef.current = false;
    setError("");
    mutate({ auto: false });
  }, [mutate]);

  // Exactly one automatic start per mount. The broker is the second guard: it
  // answers `idle` rather than starting another flow once one was cancelled or
  // failed, so a broken CLI cannot spawn a login on every click.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    autoStartedRef.current = true;
    mutate({ auto: true });
  }, [autoStart, mutate]);

  return {
    phase,
    authUrl,
    installCommand,
    error,
    starting: mutation.isPending,
    start,
    // Saying yes to the one-time setup is an explicit start: that consent is
    // what permits the install the automatic path refused to do.
    confirmInstall: start,
    cancel: cancelMutation.mutate,
  };
}
