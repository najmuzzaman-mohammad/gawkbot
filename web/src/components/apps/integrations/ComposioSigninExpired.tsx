import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ComposioSigninPanel } from "./ComposioSigninPanel";
import { useComposioSignin } from "./useComposioSignin";

/**
 * What a user sees when Composio has revoked this office's credential and the
 * broker's silent re-mint could not replace it — the only case where a human
 * has to do something.
 *
 * It replaces what used to reach the screen here: "start composio connection:
 * composio API failed GET /auth_configs 401 Unauthorized request_id=9466302c…".
 * That sentence named a protocol, a path, a status code, and an identifier, and
 * told the reader nothing they could act on. This one says what happened and
 * gives them the single button that fixes it.
 */

/** The one sentence. Mirrors composioSignInExpiredMessage in the broker. */
export const COMPOSIO_SIGNIN_EXPIRED_MESSAGE =
  "Your Composio sign-in has expired. Sign in again to reconnect your apps.";

interface ComposioSigninExpiredProps {
  /**
   * The upstream request id, when there is one. Kept OUT of the sentence and
   * behind a details affordance: useless to the user, occasionally useful to
   * support.
   */
  requestId?: string | null;
  /** Called after a successful re-sign-in so the caller can retry its work. */
  onSignedIn?: () => void;
}

export function ComposioSigninExpired({
  requestId,
  onSignedIn,
}: ComposioSigninExpiredProps) {
  const queryClient = useQueryClient();
  const handleDone = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["config"] });
    void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    onSignedIn?.();
  }, [queryClient, onSignedIn]);

  const signin = useComposioSignin({ onDone: handleDone });

  return (
    <section className="composio-expired" aria-label="Composio sign-in expired">
      <p className="composio-expired-message" role="alert">
        {COMPOSIO_SIGNIN_EXPIRED_MESSAGE}
      </p>
      <ComposioSigninPanel
        phase={signin.phase}
        authUrl={signin.authUrl}
        installCommand={signin.installCommand}
        starting={signin.starting}
        onStart={signin.start}
        ctaLabel="Sign in again"
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
