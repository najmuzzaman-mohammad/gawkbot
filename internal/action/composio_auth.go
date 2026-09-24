package action

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
)

// Composio credential failures, classified from the STRUCTURED error body
// Composio returns — never from string-matching "401".
//
// Verified live against https://backend.composio.dev/api/v3/auth_configs on
// 2026-09-23 (bodies reproduced verbatim, keys are throwaway placeholders):
//
//	x-user-api-key: uak_0000…  + x-org-id
//	  {"error":{"message":"Invalid or revoked user API key","code":2113,
//	            "slug":"UserApiKey_Unauthorized","status":401}}
//
//	x-api-key: ak_0000…
//	  {"error":{"message":"Invalid API key: ak_**0000","code":801,
//	            "slug":"APIKey_InvalidAPIKey","status":401}}
//
//	no auth headers at all
//	  {"error":{"message":"No authentication provided","code":906,
//	            "slug":"Auth_NoAuthProvided","status":401}}
//
// The project-key branch answers a revoked/rotated/unknown `ak_` key with the
// SAME code+slug as a malformed one (801 / APIKey_InvalidAPIKey) — Composio
// does not distinguish "revoked" from "never existed" for project keys, so both
// map to the same classification here.
//
// Composio's `message` is deliberately NOT retained anywhere: the project-key
// branch echoes a partially masked key back into it, and no credential material
// — masked or not — belongs in an error, a log, or a UI string.
const (
	composioCodeUserKeyUnauthorized = 2113
	composioCodeProjectKeyInvalid   = 801
	composioCodeNoAuthProvided      = 906

	composioSlugUserKeyUnauthorized = "UserApiKey_Unauthorized"
	composioSlugProjectKeyInvalid   = "APIKey_InvalidAPIKey"
	composioSlugNoAuthProvided      = "Auth_NoAuthProvided"

	// Slug namespaces. Composio has added slugs within these families over
	// time (e.g. a future `APIKey_Revoked`); treating the whole namespace as a
	// credential rejection keeps a new slug from silently degrading back into
	// a raw 401 in front of a user.
	composioSlugPrefixUserKey    = "UserApiKey_"
	composioSlugPrefixProjectKey = "APIKey_"
)

// ErrComposioCredentialRevoked reports that Composio rejected the credential
// itself — not the request. Callers branch on this cause (errors.Is) instead of
// inspecting status codes or error text, so the boundary can swap the protocol
// failure for a human sentence and a one-click re-sign-in.
var ErrComposioCredentialRevoked = errors.New("composio credential is no longer valid")

// ErrComposioNotConfigured reports that this office holds NO Composio
// credential at all — a first run, or a config that was never filled in.
//
// It is deliberately a different cause from ErrComposioCredentialRevoked. A
// revoked credential can sometimes be repaired locally by re-minting from a
// live CLI session; a missing one cannot, because there is nothing to re-mint
// from. Both, however, are fixed by the same browser sign-in, so the HTTP
// boundary routes them to the same recovery surface — see
// composioSignInRequiredMessage in internal/team/broker_integrations.go.
//
// This is also why Auth_NoAuthProvided stays out of the revoked
// classification above: "nothing was sent" is detected locally, before a
// pointless unauthenticated round trip, not inferred from Composio's answer.
var ErrComposioNotConfigured = errors.New("composio is not configured")

// ComposioCredentialKind names which of Composio's two auth modes was rejected.
type ComposioCredentialKind string

const (
	// ComposioCredentialProject is the project-scoped `ak_` key (x-api-key).
	ComposioCredentialProject ComposioCredentialKind = "project"
	// ComposioCredentialUser is the user-scoped `uak_` session key sent with
	// x-user-api-key / x-org-id / x-project-id.
	ComposioCredentialUser ComposioCredentialKind = "user"
	// ComposioCredentialNone is "no credential reached Composio at all".
	ComposioCredentialNone ComposioCredentialKind = "none"
)

// composioErrorEnvelope is the subset of Composio's error body we parse. Only
// machine-readable fields are read; `message` is skipped on purpose (see above).
type composioErrorEnvelope struct {
	Error struct {
		Code      int    `json:"code"`
		Slug      string `json:"slug"`
		Status    int    `json:"status"`
		RequestID string `json:"request_id"`
	} `json:"error"`
}

// classifyComposioAuthFailure inspects a non-2xx Composio body and reports
// whether it is a credential rejection, which credential mode it names, and the
// machine-readable code/slug/request id for support. A body that is not a
// credential rejection returns revoked=false and leaves the caller's generic
// API-error path untouched.
func classifyComposioAuthFailure(statusCode int, body []byte) (revoked bool, kind ComposioCredentialKind, code int, slug, requestID string) {
	var env composioErrorEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return false, "", 0, "", ""
	}
	code = env.Error.Code
	slug = strings.TrimSpace(env.Error.Slug)
	requestID = strings.TrimSpace(env.Error.RequestID)

	// Composio's envelope carries its own status; trust the transport status
	// when they disagree, and require an auth-shaped status either way so a
	// 500 that happens to echo a slug is not mistaken for a revoked key.
	if statusCode != 401 && statusCode != 403 {
		return false, "", code, slug, requestID
	}

	switch {
	case code == composioCodeUserKeyUnauthorized ||
		slug == composioSlugUserKeyUnauthorized ||
		strings.HasPrefix(slug, composioSlugPrefixUserKey):
		return true, ComposioCredentialUser, code, slug, requestID
	case code == composioCodeProjectKeyInvalid ||
		slug == composioSlugProjectKeyInvalid ||
		strings.HasPrefix(slug, composioSlugPrefixProjectKey):
		return true, ComposioCredentialProject, code, slug, requestID
	case code == composioCodeNoAuthProvided || slug == composioSlugNoAuthProvided:
		// Nothing was sent. A re-mint cannot help — the stored credential is
		// missing, not stale — so this is reported but not marked revoked.
		return false, ComposioCredentialNone, code, slug, requestID
	}
	return false, "", code, slug, requestID
}

// ComposioCredentials is a refreshed Composio credential set: EITHER a project
// `ak_` key, OR the user-key trio. It is the value a ComposioReauthFunc hands
// back and is never logged.
type ComposioCredentials struct {
	APIKey     string
	UserAPIKey string
	OrgID      string
	ProjectID  string
}

func (c ComposioCredentials) empty() bool {
	return strings.TrimSpace(c.APIKey) == "" &&
		(strings.TrimSpace(c.UserAPIKey) == "" || strings.TrimSpace(c.OrgID) == "")
}

// ComposioReauthFunc mints and persists a fresh Composio credential when the
// stored one has been revoked. It must be safe for concurrent use, must be
// single-flighted by its implementation (ten parallel requests hitting a dead
// key must not spawn ten CLI invocations), and must never block on interactive
// input. It returns an error when automatic recovery is impossible — the caller
// then surfaces the human-facing "sign in again" path instead of retrying.
type ComposioReauthFunc func(ctx context.Context) (ComposioCredentials, error)

// composioReauthProvider is the process-wide re-mint provider. It is registered
// once at broker startup (SetComposioReauth) rather than threaded through every
// construction site, so EVERY Composio caller — the web handlers, the capability
// registry, the action registry an agent runs through — recovers identically
// instead of only the surface that happened to wire it up.
// Atomic because tests start brokers in parallel and every request path reads
// it; a plain package var would be a data race under -race.
var composioReauthProvider atomic.Pointer[ComposioReauthFunc]

// SetComposioReauth registers the process-wide re-mint provider. Call it once,
// during startup, before any Composio request is issued. Passing nil clears it
// (used by tests to restore the default no-recovery behaviour).
func SetComposioReauth(fn ComposioReauthFunc) {
	if fn == nil {
		composioReauthProvider.Store(nil)
		return
	}
	composioReauthProvider.Store(&fn)
}

// creds returns the credentials to authenticate with: the refreshed set from a
// successful in-flight re-mint when one has landed, else the ones this client
// was constructed with. Long-lived clients (the action registry builds one at
// startup) therefore stop replaying a dead key after the first recovery.
func (c *ComposioREST) creds() ComposioCredentials {
	if refreshed := c.refreshed.Load(); refreshed != nil {
		return *refreshed
	}
	return ComposioCredentials{
		APIKey:     strings.TrimSpace(c.APIKey),
		UserAPIKey: strings.TrimSpace(c.UserAPIKey),
		OrgID:      strings.TrimSpace(c.OrgID),
		ProjectID:  strings.TrimSpace(c.ProjectID),
	}
}

// adoptCredentials stores a refreshed credential set for subsequent requests.
// It reports false when the set is unusable or identical to the one that was
// just rejected — in that case retrying would replay the same dead credential,
// so the caller must surface the failure instead.
func (c *ComposioREST) adoptCredentials(next ComposioCredentials) bool {
	next = ComposioCredentials{
		APIKey:     strings.TrimSpace(next.APIKey),
		UserAPIKey: strings.TrimSpace(next.UserAPIKey),
		OrgID:      strings.TrimSpace(next.OrgID),
		ProjectID:  strings.TrimSpace(next.ProjectID),
	}
	if next.empty() || next == c.creds() {
		return false
	}
	c.refreshed.Store(&next)
	return true
}

// reauth resolves the registered re-mint provider for this client.
func (c *ComposioREST) reauth() ComposioReauthFunc {
	if c.Reauth != nil {
		return c.Reauth
	}
	if fn := composioReauthProvider.Load(); fn != nil {
		return *fn
	}
	return nil
}
