import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ComposioSigninPanel } from "./ComposioSigninPanel";
import { type SigninPhase, useComposioSignin } from "./useComposioSignin";

/**
 * What a user sees when connecting an app needs a Composio sign-in this office
 * does not have — either because Composio revoked the credential and the
 * broker's silent re-mint could not replace it, or because there has never been
 * one (a first run).
 *
 * It replaces what used to reach the screen here: "start composio connection:
 * composio API failed GET /auth_configs 401 Unauthorized request_id=9466302c…".
 * That sentence named a protocol, a path, a status code, and an identifier, and
 * told the reader nothing they could act on.
 *
 * With `autoStart`, it does not even ask for the click: the person already
 * clicked Connect, so the sign-in begins by itself and this panel is the "show,
 * don't surprise" half — the link it opened, a way to copy it, and a cancel.
 * When the sign-in lands, `onSignedIn` fires and the caller resumes the connect
 * the person originally asked for, so the whole thing reads as one action.
 */

/** The one sentence for a credential that went stale, when nothing is running. */
export const COMPOSIO_SIGNIN_EXPIRED_MESSAGE =
  "Your Composio sign-in has expired. Sign in again to reconnect your apps.";

/** The same, for an office that has never signed in. */
export const COMPOSIO_SIGNIN_REQUIRED_MESSAGE =
  "You are not signed in to Composio yet. Sign in to connect this app.";

/** And the versions that describe a sign-in already under way. */
const COMPOSIO_SIGNIN_EXPIRED_RUNNING =
  "Your Composio sign-in has expired. Signing you back in now.";
const COMPOSIO_SIGNIN_REQUIRED_RUNNING =
  "You are not signed in to Composio yet. Signing you in now.";

/** Phases where a sign-in is genuinely under way, so the copy may say so. */
const RUNNING_PHASES: readonly SigninPhase[] = [
  "installing",
  "awaiting_login",
  "provisioning",
  "done",
];

interface ComposioSigninExpiredProps {
  /**
   * The upstream request id, when there is one. Kept OUT of the sentence and
   * behind a details affordance: useless to the user, occasionally useful to
   * support.
   */
  requestId?: string | null;
  /** Called after a successful sign-in so the caller can resume its work. */
  onSignedIn?: () => void;
  /**
   * True when the office has never signed in, rather than having a credential
   * that expired. Only the sentence differs; the recovery is identical.
   */
  neverSignedIn?: boolean;
  /**
   * Begin the sign-in without waiting for a click. Set by a surface the user
   * reached by asking for something that needs one.
   */
  autoStart?: boolean;
  /** Called when the user stops an automatic sign-in. */
  onCancel?: () => void;
}

export function ComposioSigninExpired({
  requestId,
  onSignedIn,
  neverSignedIn = false,
  autoStart = false,
  onCancel,
}: ComposioSigninExpiredProps) {
  const queryClient = useQueryClient();
  const handleDone = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["config"] });
    void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    onSignedIn?.();
  }, [queryClient, onSignedIn]);

  const signin = useComposioSignin({ onDone: handleDone, autoStart });

  const running = RUNNING_PHASES.includes(signin.phase);
  const message = neverSignedIn
    ? running
      ? COMPOSIO_SIGNIN_REQUIRED_RUNNING
      : COMPOSIO_SIGNIN_REQUIRED_MESSAGE
    : running
      ? COMPOSIO_SIGNIN_EXPIRED_RUNNING
      : COMPOSIO_SIGNIN_EXPIRED_MESSAGE;

  // Cancelling returns the flow to idle, which is the explicit button. Telling
  // the caller as well lets it drop the panel entirely when it prefers to.
  const handleCancel = useCallback(() => {
    signin.cancel();
    onCancel?.();
  }, [signin, onCancel]);

  return (
    <section className="composio-expired" aria-label="Composio sign-in">
      <p className="composio-expired-message" role="alert">
        {message}
      </p>
      <ComposioSigninPanel
        phase={signin.phase}
        authUrl={signin.authUrl}
        installCommand={signin.installCommand}
        starting={signin.starting}
        onStart={signin.start}
        onConfirmInstall={signin.confirmInstall}
        onCancel={handleCancel}
        ctaLabel={neverSignedIn ? "Sign in to Composio" : "Sign in again"}
      />
      {signin.phase === "error" && signin.error ? (
        <p className="composio-onb-error" role="alert">
          {signin.error}
        </p>
      ) : null}
      {requestId ? (
        <details className="composio-expired-details">
          <summary>Details for support</summary>
          <code className="composio-expired-request-id">{requestId}</code>
        </details>
      ) : null}
    </section>
  );
}
