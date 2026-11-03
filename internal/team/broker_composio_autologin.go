package team

// Automatic Composio sign-in on a connect attempt.
//
// The founder's instruction: "composio login should run automatically when
// logged out and attempting to connect something via it." What shipped before
// this was a sentence and a "Sign in again" button — which is still asking. A
// person who clicks Connect has already said what they want; making them click
// a second button to be allowed to want it is ceremony.
//
// So a connect that fails for want of a Composio session now starts the sign-in
// itself, through the SAME entrypoint the button uses (startComposioSignin), and
// the connect surface shows the login happening with a way to stop it.
//
// Three rules keep "automatic" from becoming "surprising":
//
//  1. It is visible. The connect surface immediately shows the sign-in in
//     progress, with the link it opened and a cancel.
//  2. It never installs software. A missing CLI stops at install_required and
//     asks. That is the destructive-action carve-out, not an exception to the
//     automation: reading and signing in are the user's own intent, installing
//     a binary on their machine is not.
//  3. It cannot stampede or loop. startComposioSignin single-flights (a second
//     start while one is pending re-joins the first), and composioSigninFlow's
//     autoBlocked latch means a cancelled or failed automatic sign-in is not
//     retried on the next click — the button comes back instead.
//
// ── Does a MISSING credential route here? Yes. ────────────────────────────
//
// The founder's words are "when logged out", which includes a first run, so a
// missing credential must reach the same recovery as a revoked one. The two
// differ only in how they are DETECTED:
//
//   - Revoked is detected from Composio's structured answer
//     (ErrComposioCredentialRevoked), and only after the silent re-mint has
//     already tried and failed.
//   - Missing is detected LOCALLY, before any request goes out
//     (ErrComposioNotConfigured, raised by ComposioREST.do).
//
// Deliberately unchanged: Auth_NoAuthProvided stays out of the revoked
// classification in internal/action/composio_auth.go. That exclusion is about
// the RE-MINT — there is no stale credential to refresh when nothing was sent,
// so marking it revoked would buy a pointless CLI invocation and a retry of a
// request that was always going to fail. Routing a missing credential to an
// interactive browser sign-in is a different question with a different answer,
// and it is answered here, on a locally-observed fact rather than on an
// unauthenticated round trip.

// Operator-facing copy for the sign-in flow.
//
// House rule, applied without exception: no status code, slug, request id,
// environment variable, or shell command reaches a person. None of it is
// actionable by whoever is reading, and all of it is already in the log for
// whoever can act on it. The install command is the one technical artefact the
// UI still shows, and it lives behind a disclosure addressed to whoever set the
// computer up — never in the sentence.
const (
	// composioSignInRequiredMessage: this office has never had a Composio
	// credential. Used for a first run.
	//
	// It states the situation and the remedy without promising that the sign-in
	// has already begun — the connect surface starts one automatically and says
	// so itself, but a surface that only reports the failure (a toast, a
	// provider row) must not claim something is happening when it is not.
	composioSignInRequiredMessage = "You are not signed in to Composio yet. Sign in to connect this app."

	// composioSigninUnavailableMessage: the CLI is present but could not
	// produce a sign-in page, so there is nothing to open and nothing the
	// reader can do except try again.
	composioSigninUnavailableMessage = "This computer could not open a Composio sign-in page. Try again in a moment."

	// composioSigninTimedOutMessage: the login window elapsed with nobody
	// finishing it.
	composioSigninTimedOutMessage = "The Composio sign-in was not finished in time. Start it again when you are ready."

	// composioInstallFailedMessage: the setup step failed after the user
	// agreed to it.
	composioInstallFailedMessage = "The one-time setup for integrations did not finish on this computer."

	// composioInstallStalledMessage: the setup step is still running well past
	// its budget, which in practice means it is stuck.
	composioInstallStalledMessage = "The one-time setup for integrations is taking longer than it should."
)

// composioSignInRequiredCode is the machine-readable code for "no Composio
// credential at all". It is a sibling of composioSignInExpiredCode: the UI
// treats both as "the sign-in panel belongs here", and only the sentence above
// it differs.
const composioSignInRequiredCode = "composio_signin_required"
