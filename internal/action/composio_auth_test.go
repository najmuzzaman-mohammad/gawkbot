package action

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// The exact bodies Composio returns, captured live on 2026-09-23 against
// https://backend.composio.dev/api/v3/auth_configs. The keys in them are
// throwaway zeros, never real credentials. These literals are the contract the
// detection is written against — if Composio changes the shape, these tests are
// where it shows up, not a user's Gmail connect button.
const (
	composioRevokedUserKeyBody = `{"error":{"message":"Invalid or revoked user API key","code":2113,` +
		`"slug":"UserApiKey_Unauthorized","status":401,"request_id":"9466302c-0000-0000-0000-000000000000","suggested_fix":""}}`
	composioInvalidProjectKeyBody = `{"error":{"message":"Invalid API key: ak_**0000","code":801,` +
		`"slug":"APIKey_InvalidAPIKey","status":401,"request_id":"fe1cc6da-0000-0000-0000-000000000000",` +
		`"suggested_fix":"Please check you are using a valid API key."}}`
	composioNoAuthBody = `{"error":{"message":"No authentication provided","code":906,` +
		`"slug":"Auth_NoAuthProvided","status":401,"request_id":"8d89ac05-0000-0000-0000-000000000000","suggested_fix":""}}`
)

func TestClassifyComposioAuthFailure(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		wantRevoke bool
		wantKind   ComposioCredentialKind
		wantCode   int
		wantSlug   string
	}{
		{
			name:       "revoked user session key",
			status:     http.StatusUnauthorized,
			body:       composioRevokedUserKeyBody,
			wantRevoke: true,
			wantKind:   ComposioCredentialUser,
			wantCode:   2113,
			wantSlug:   "UserApiKey_Unauthorized",
		},
		{
			// Composio answers a revoked, rotated, or never-existed project key
			// with the same code+slug as a malformed one.
			name:       "invalid or revoked project key",
			status:     http.StatusUnauthorized,
			body:       composioInvalidProjectKeyBody,
			wantRevoke: true,
			wantKind:   ComposioCredentialProject,
			wantCode:   801,
			wantSlug:   "APIKey_InvalidAPIKey",
		},
		{
			// Nothing was sent: a re-mint cannot help, so this must NOT be
			// classified as revoked or the client would burn a pointless retry.
			name:       "no auth provided is not a revocation",
			status:     http.StatusUnauthorized,
			body:       composioNoAuthBody,
			wantRevoke: false,
			wantKind:   ComposioCredentialNone,
			wantCode:   906,
			wantSlug:   "Auth_NoAuthProvided",
		},
		{
			// Forward compatibility: a slug Composio has not shipped yet still
			// lands in the right family rather than degrading to a raw 401.
			name:       "unknown slug in the user-key family",
			status:     http.StatusUnauthorized,
			body:       `{"error":{"code":9999,"slug":"UserApiKey_Expired","status":401}}`,
			wantRevoke: true,
			wantKind:   ComposioCredentialUser,
			wantCode:   9999,
			wantSlug:   "UserApiKey_Expired",
		},
		{
			name:       "unknown slug in the project-key family",
			status:     http.StatusUnauthorized,
			body:       `{"error":{"code":9998,"slug":"APIKey_Revoked","status":401}}`,
			wantRevoke: true,
			wantKind:   ComposioCredentialProject,
			wantCode:   9998,
			wantSlug:   "APIKey_Revoked",
		},
		{
			// A 401-shaped body on a non-auth status must not be treated as a
			// credential problem: detection is on the structure, not on "401".
			name:       "auth slug on a 500 is not a revocation",
			status:     http.StatusInternalServerError,
			body:       composioRevokedUserKeyBody,
			wantRevoke: false,
			wantKind:   "",
			wantCode:   2113,
			wantSlug:   "UserApiKey_Unauthorized",
		},
		{
			name:       "403 rate-limit style body is not a revocation",
			status:     http.StatusForbidden,
			body:       `{"error":{"code":1200,"slug":"Team_QuotaExceeded","status":403}}`,
			wantRevoke: false,
			wantKind:   "",
			wantCode:   1200,
			wantSlug:   "Team_QuotaExceeded",
		},
		{
			name:       "non-json body",
			status:     http.StatusUnauthorized,
			body:       "Unauthorized",
			wantRevoke: false,
			wantKind:   "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			revoked, kind, code, slug, _ := classifyComposioAuthFailure(tc.status, []byte(tc.body))
			if revoked != tc.wantRevoke {
				t.Fatalf("revoked = %v, want %v", revoked, tc.wantRevoke)
			}
			if kind != tc.wantKind {
				t.Fatalf("kind = %q, want %q", kind, tc.wantKind)
			}
			if code != tc.wantCode {
				t.Fatalf("code = %d, want %d", code, tc.wantCode)
			}
			if slug != tc.wantSlug {
				t.Fatalf("slug = %q, want %q", slug, tc.wantSlug)
			}
		})
	}
}

// TestComposioAPIErrorUnwrapsRevoked pins the typed-cause contract: callers
// branch with errors.Is on the CAUSE, never on the message or the status code.
func TestComposioAPIErrorUnwrapsRevoked(t *testing.T) {
	revoked := &ComposioAPIError{StatusCode: 401, Code: 2113, Slug: "UserApiKey_Unauthorized", credentialRevoked: true}
	if !errors.Is(revoked, ErrComposioCredentialRevoked) {
		t.Fatal("a credential rejection must unwrap to ErrComposioCredentialRevoked")
	}
	if !errors.Is(wrapForCauseTest(revoked), ErrComposioCredentialRevoked) {
		t.Fatal("the cause must survive wrapping")
	}
	other := &ComposioAPIError{StatusCode: 500, Status: "500 Internal Server Error"}
	if errors.Is(other, ErrComposioCredentialRevoked) {
		t.Fatal("a server error must not claim to be a credential rejection")
	}
}

// wrapForCauseTest simulates a caller several layers up wrapping the error.
func wrapForCauseTest(err error) error { return errors.Join(errors.New("connect gmail"), err) }

// newRevokingComposioServer serves the revoked-user-key body until the client
// presents a different credential, then serves 200. It records every auth
// header it saw so a test can prove which credential was used on which attempt.
type revokingComposioServer struct {
	*httptest.Server
	acceptKey  string
	mu         sync.Mutex
	seenAPIKey []string
	hits       atomic.Int32
}

func newRevokingComposioServer(t *testing.T, acceptKey string) *revokingComposioServer {
	t.Helper()
	srv := &revokingComposioServer{acceptKey: acceptKey}
	srv.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		srv.hits.Add(1)
		got := r.Header.Get("x-api-key")
		srv.mu.Lock()
		srv.seenAPIKey = append(srv.seenAPIKey, got)
		srv.mu.Unlock()
		if got != "" && got == srv.acceptKey {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(composioRevokedUserKeyBody))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestComposioDoRemintsAndRetries is the happy path the founder asked for: the
// stored credential is dead, the CLI can still mint one, and the request
// succeeds without the user being told anything happened.
func TestComposioDoRemintsAndRetries(t *testing.T) {
	srv := newRevokingComposioServer(t, "ak_fresh_project_key")
	var calls atomic.Int32
	client := &ComposioREST{
		UserAPIKey: "uak_revoked_session",
		OrgID:      "ok_1",
		UserID:     "operator@example.com",
		BaseURL:    srv.URL,
		Client:     srv.Client(),
		Reauth: func(context.Context) (ComposioCredentials, error) {
			calls.Add(1)
			return ComposioCredentials{APIKey: "ak_fresh_project_key"}, nil
		},
	}

	raw, err := client.get(context.Background(), "/auth_configs", nil)
	if err != nil {
		t.Fatalf("expected the retry to succeed, got %v", err)
	}
	if string(raw) != `{"items":[]}` {
		t.Fatalf("unexpected body %q", raw)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("re-mint ran %d times, want exactly 1", got)
	}
	if got := srv.hits.Load(); got != 2 {
		t.Fatalf("server saw %d requests, want exactly 2 (original + one retry)", got)
	}
	// The refreshed credential sticks, so the next request does not replay the
	// dead one — a long-lived client must not re-mint on every call.
	if _, err := client.get(context.Background(), "/auth_configs", nil); err != nil {
		t.Fatalf("second request after re-mint failed: %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("re-mint ran %d times across two requests, want 1", got)
	}
}

// TestComposioDoSurfacesTypedErrorWhenRemintFails is the case the founder
// actually hit: the CLI session is revoked too, so nothing local can recover.
// The caller must get the typed cause (which the HTTP boundary turns into a
// sentence), and the error text must not contain the credential.
func TestComposioDoSurfacesTypedErrorWhenRemintFails(t *testing.T) {
	srv := newRevokingComposioServer(t, "ak_never_offered")
	var calls atomic.Int32
	client := &ComposioREST{
		UserAPIKey: "uak_revoked_session",
		OrgID:      "ok_1",
		UserID:     "operator@example.com",
		BaseURL:    srv.URL,
		Client:     srv.Client(),
		Reauth: func(context.Context) (ComposioCredentials, error) {
			calls.Add(1)
			return ComposioCredentials{}, errors.New("composio CLI session cannot mint a credential")
		},
	}

	_, err := client.get(context.Background(), "/auth_configs", nil)
	if err == nil {
		t.Fatal("expected an error when recovery is impossible")
	}
	if !errors.Is(err, ErrComposioCredentialRevoked) {
		t.Fatalf("error must carry the revoked cause, got %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("re-mint ran %d times, want exactly 1 (no retry loop)", got)
	}
	if got := srv.hits.Load(); got != 1 {
		t.Fatalf("server saw %d requests, want 1 (no retry after a failed re-mint)", got)
	}
	assertNoCredentialInText(t, err.Error(), "uak_revoked_session", "ak_never_offered")
}

// TestComposioDoDoesNotRetryOnAnIdenticalCredential guards the loop: a provider
// that hands back the credential Composio just rejected must not cause a second
// identical round trip.
func TestComposioDoDoesNotRetryOnAnIdenticalCredential(t *testing.T) {
	srv := newRevokingComposioServer(t, "ak_never_offered")
	client := &ComposioREST{
		UserAPIKey: "uak_revoked_session",
		OrgID:      "ok_1",
		UserID:     "operator@example.com",
		BaseURL:    srv.URL,
		Client:     srv.Client(),
		Reauth: func(context.Context) (ComposioCredentials, error) {
			return ComposioCredentials{UserAPIKey: "uak_revoked_session", OrgID: "ok_1"}, nil
		},
	}
	if _, err := client.get(context.Background(), "/auth_configs", nil); !errors.Is(err, ErrComposioCredentialRevoked) {
		t.Fatalf("want the revoked cause, got %v", err)
	}
	if got := srv.hits.Load(); got != 1 {
		t.Fatalf("server saw %d requests, want 1 — replaying a dead credential is not a retry", got)
	}
}

// TestComposioDoDoesNotRemintOnANonCredentialFailure keeps the recovery narrow:
// a 500, a 429, or a 400 is not a reason to shell out to the CLI.
func TestComposioDoDoesNotRemintOnANonCredentialFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom","code":5000,"slug":"Internal_Error","status":500}}`))
	}))
	defer srv.Close()
	var calls atomic.Int32
	client := &ComposioREST{
		APIKey:  "ak_live",
		UserID:  "operator@example.com",
		BaseURL: srv.URL,
		Client:  srv.Client(),
		Reauth: func(context.Context) (ComposioCredentials, error) {
			calls.Add(1)
			return ComposioCredentials{APIKey: "ak_other"}, nil
		},
	}
	if _, err := client.get(context.Background(), "/auth_configs", nil); err == nil {
		t.Fatal("expected the 500 to surface")
	} else if errors.Is(err, ErrComposioCredentialRevoked) {
		t.Fatalf("a 500 must not be classified as a credential rejection: %v", err)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("re-mint ran %d times on a server error, want 0", got)
	}
}

// TestComposioDoReplaysTheRequestBodyOnRetry: the retry must send the same
// payload, not an empty body, or a POSTed connect would silently change shape.
func TestComposioDoReplaysTheRequestBodyOnRetry(t *testing.T) {
	var bodies []string
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 512)
		n, _ := r.Body.Read(buf)
		mu.Lock()
		bodies = append(bodies, string(buf[:n]))
		mu.Unlock()
		if r.Header.Get("x-api-key") == "ak_fresh" {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(composioRevokedUserKeyBody))
	}))
	defer srv.Close()
	client := &ComposioREST{
		UserAPIKey: "uak_dead",
		OrgID:      "ok_1",
		UserID:     "operator@example.com",
		BaseURL:    srv.URL,
		Client:     srv.Client(),
		Reauth: func(context.Context) (ComposioCredentials, error) {
			return ComposioCredentials{APIKey: "ak_fresh"}, nil
		},
	}
	if _, err := client.post(context.Background(), "/connected_accounts/link", map[string]any{"auth_config_id": "ac_1"}); err != nil {
		t.Fatalf("post after re-mint failed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 {
		t.Fatalf("want 2 attempts, got %d", len(bodies))
	}
	if bodies[0] != bodies[1] {
		t.Fatalf("retry body %q differs from the original %q", bodies[1], bodies[0])
	}
	if !strings.Contains(bodies[1], "ac_1") {
		t.Fatalf("retry lost the payload: %q", bodies[1])
	}
}

// assertNoCredentialInText is the hard rule for this whole feature: no
// credential, whole or masked, may appear in anything a human or a log can see.
func assertNoCredentialInText(t *testing.T, text string, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(text, secret) {
			t.Fatalf("credential leaked into %q", text)
		}
	}
	for _, prefix := range []string{"uak_", "ak_"} {
		if strings.Contains(text, prefix) {
			t.Fatalf("a %s-prefixed credential appears in %q", prefix, text)
		}
	}
}
