package team

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/action"
	"github.com/nex-crm/wuphf/internal/config"
)

// These tests cover the silent re-mint (broker_composio_remint.go) and the
// human-facing boundary it falls back to. They follow the fixture conventions
// in broker_composio_signin_test.go: a fake `composio` shell script on a
// stripped-down PATH, an isolated HOME for user_data.json and config.json, so
// the whole recovery runs without the real CLI or network.
//
// The revoked-user-key body is Composio's real one, captured live on
// 2026-09-23. The keys in every fixture are throwaway placeholders.
const composioRevokedBodyFixture = `{"error":{"message":"Invalid or revoked user API key","code":2113,` +
	`"slug":"UserApiKey_Unauthorized","status":401,"request_id":"9466302c-0000-0000-0000-000000000000"}}`

// resetComposioRemintState clears the cross-test residue: the process-wide
// reauth provider and this broker's single-flight cache.
func resetComposioRemintState(t *testing.T, b *Broker) {
	t.Helper()
	t.Cleanup(func() { action.SetComposioReauth(nil) })
	flow := &b.composioSignin
	flow.mu.Lock()
	flow.remintDone, flow.remintCreds, flow.remintErr, flow.remintAt = nil, action.ComposioCredentials{}, nil, time.Time{}
	flow.mu.Unlock()
}

// writeComposioUserData seeds the CLI session file the re-mint reads.
func writeComposioUserData(t *testing.T, apiKey, orgID string) {
	t.Helper()
	home := os.Getenv("HOME")
	if err := os.MkdirAll(filepath.Join(home, ".composio"), 0o700); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]string{"api_key": apiKey, "org_id": orgID})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".composio", "user_data.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestComposioRemintPersistsAProjectKeyAndPrefersIt is the recovery the founder
// asked for: the CLI still has a session, `composio dev init` mints a project
// ak_ key, and it is persisted as the office's credential. The revoked uak_
// trio is cleared in the same write so a dead session key cannot come back.
func TestComposioRemintPersistsAProjectKeyAndPrefersIt(t *testing.T) {
	dir := t.TempDir()
	// `dev init` writes the project key into .env.local in its working dir,
	// exactly as composio CLI 0.2.31 does.
	writeFakeComposioCLI(t, dir, `
if [ "$1" = "dev" ] && [ "$2" = "init" ]; then
  echo "COMPOSIO_API_KEY=`+testComposioProjectKey+`" > .env.local
  exit 0
fi
exit 1
`)
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	writeComposioUserData(t, "uak_revoked_session", "ok_1")
	seedComposioUserKeyConfig(t, "uak_revoked_session", "ok_1")

	creds, err := b.composioReauth(context.Background())
	if err != nil {
		t.Fatalf("re-mint failed: %v", err)
	}
	if creds.APIKey != testComposioProjectKey {
		t.Fatalf("want the project key, got %+v", redactCreds(creds))
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ComposioAPIKey != testComposioProjectKey {
		t.Fatalf("project key was not persisted")
	}
	if cfg.ComposioUserAPIKey != "" || cfg.ComposioOrgID != "" {
		t.Fatalf("the revoked user-key trio must be cleared, got user_key_set=%v org=%q",
			cfg.ComposioUserAPIKey != "", cfg.ComposioOrgID)
	}
}

// TestComposioRemintSingleFlight: ten parallel callers against a dead
// credential must cost exactly one CLI invocation, and all ten must get the
// same fresh credential.
func TestComposioRemintSingleFlight(t *testing.T) {
	dir := t.TempDir()
	counter := filepath.Join(t.TempDir(), "devinit.count")
	writeFakeComposioCLI(t, dir, `
if [ "$1" = "dev" ] && [ "$2" = "init" ]; then
  echo x >> `+counter+`
  sleep 0.2
  echo "COMPOSIO_API_KEY=`+testComposioProjectKey+`" > .env.local
  exit 0
fi
exit 1
`)
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	writeComposioUserData(t, "uak_revoked_session", "ok_1")
	seedComposioUserKeyConfig(t, "uak_revoked_session", "ok_1")

	const callers = 10
	var wg sync.WaitGroup
	results := make([]action.ComposioCredentials, callers)
	errs := make([]error, callers)
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = b.composioReauth(context.Background())
		}()
	}
	wg.Wait()

	for i := range callers {
		if errs[i] != nil {
			t.Fatalf("caller %d failed: %v", i, errs[i])
		}
		if results[i].APIKey != testComposioProjectKey {
			t.Fatalf("caller %d got %+v, want the shared fresh key", i, redactCreds(results[i]))
		}
	}
	raw, err := os.ReadFile(counter)
	if err != nil {
		t.Fatalf("the fake CLI never ran: %v", err)
	}
	if runs := len(strings.Fields(string(raw))); runs != 1 {
		t.Fatalf("`composio dev init` ran %d times for %d concurrent callers, want exactly 1", runs, callers)
	}
}

// TestComposioRemintRefusesWithoutACLISession is the founder's actual case: the
// CLI session is revoked too (here: absent), so no local machinery can recover
// and the provider must fail rather than shell out or hang.
func TestComposioRemintRefusesWithoutACLISession(t *testing.T) {
	dir := t.TempDir()
	// A CLI that would block forever if it were ever invoked. It must not be.
	writeFakeComposioCLI(t, dir, "sleep 600")
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	seedComposioUserKeyConfig(t, "uak_revoked_session", "ok_1")

	done := make(chan error, 1)
	go func() {
		_, err := b.composioReauth(context.Background())
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("want an error when the CLI has no session")
		}
		assertNoComposioCredential(t, err.Error())
	case <-time.After(5 * time.Second):
		t.Fatal("re-mint blocked without a CLI session — it must never run the CLI in that state")
	}
}

// TestComposioRemintRejectsTheSameDeadUserKey: if `dev init` cannot mint and the
// CLI session file still holds the very key Composio just rejected, the
// fallback must refuse instead of re-storing it for a pointless retry.
func TestComposioRemintRejectsTheSameDeadUserKey(t *testing.T) {
	dir := t.TempDir()
	writeFakeComposioCLI(t, dir, "exit 1")
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	writeComposioUserData(t, "uak_revoked_session", "ok_1")
	seedComposioUserKeyConfig(t, "uak_revoked_session", "ok_1")

	if _, err := b.composioReauth(context.Background()); err == nil {
		t.Fatal("want a refusal when the CLI holds the same revoked key")
	}
}

// TestComposioRemintAdoptsANewerCLISession covers the user who ran
// `composio login` in their own terminal: `dev init` still cannot mint, but the
// session file now holds a DIFFERENT key, which is a genuine recovery.
func TestComposioRemintAdoptsANewerCLISession(t *testing.T) {
	dir := t.TempDir()
	writeFakeComposioCLI(t, dir, "exit 1")
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	writeComposioUserData(t, "uak_fresh_session", "ok_1")
	seedComposioUserKeyConfig(t, "uak_revoked_session", "ok_1")

	orig := composioResolveProjectID
	composioResolveProjectID = func(string, string, string) string { return "pr_1" }
	t.Cleanup(func() { composioResolveProjectID = orig })

	creds, err := b.composioReauth(context.Background())
	if err != nil {
		t.Fatalf("re-mint failed: %v", err)
	}
	if creds.UserAPIKey != "uak_fresh_session" || creds.OrgID != "ok_1" {
		t.Fatalf("unexpected creds %+v", redactCreds(creds))
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ComposioUserAPIKey != "uak_fresh_session" || cfg.ComposioAPIKey != "" {
		t.Fatalf("the newer session key was not persisted as the sole credential")
	}
}

// TestIntegrationConnectShowsHumanCopyWhenRecoveryIsImpossible is the outcome
// the user sees. It runs the REAL handler against a Composio stub that answers
// the real revoked body, with a re-mint provider that cannot recover — and
// asserts the browser gets a sentence and a machine-readable action, never the
// 401, the request id, the slug, or the credential.
func TestIntegrationConnectShowsHumanCopyWhenRecoveryIsImpossible(t *testing.T) {
	composio := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(composioRevokedBodyFixture))
	}))
	defer composio.Close()

	dir := t.TempDir()
	writeFakeComposioCLI(t, dir, "exit 1")
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	seedComposioUserKeyConfig(t, "uak_revoked_session", "ok_1")
	t.Setenv("WUPHF_COMPOSIO_BASE_URL", composio.URL)
	t.Setenv("WUPHF_COMPOSIO_USER_ID", "operator@example.com")

	body := strings.NewReader(`{"provider":"composio","platform":"gmail"}`)
	req, _ := http.NewRequest(http.MethodPost, "http://"+b.addr+"/integrations/connect", body)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	text := string(raw)

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", resp.StatusCode, text)
	}
	var decoded integrationErrorBody
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("response is not the error envelope: %s", text)
	}
	if decoded.Error != composioSignInExpiredCode {
		t.Fatalf("error code = %q, want %q", decoded.Error, composioSignInExpiredCode)
	}
	if decoded.Message != composioSignInExpiredMessage {
		t.Fatalf("message = %q, want the human sentence", decoded.Message)
	}
	// The whole point: none of the protocol debris reaches the user's sentence.
	for _, banned := range []string{"401", "Unauthorized", "UserApiKey_Unauthorized", "auth_configs", "composio API failed", "2113"} {
		if strings.Contains(decoded.Message, banned) {
			t.Fatalf("user-facing copy contains %q: %q", banned, decoded.Message)
		}
	}
	if strings.Contains(decoded.Message, decoded.RequestID) && decoded.RequestID != "" {
		t.Fatalf("the request id must stay out of the sentence: %q", decoded.Message)
	}
	// The request id is still available for support, just not in the prose.
	if decoded.RequestID != "9466302c-0000-0000-0000-000000000000" {
		t.Fatalf("request id = %q, want it preserved for the details affordance", decoded.RequestID)
	}
	assertNoComposioCredential(t, text)
}

// TestIntegrationConnectKeepsNonCredentialErrorsAsIs: only the credential case
// is rewritten. A genuine upstream failure must keep its diagnostic text.
func TestIntegrationConnectKeepsNonCredentialErrorsAsIs(t *testing.T) {
	composio := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom","code":5000,"slug":"Internal_Error","status":500}}`))
	}))
	defer composio.Close()

	dir := t.TempDir()
	writeFakeComposioCLI(t, dir, "exit 1")
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	seedComposioUserKeyConfig(t, "uak_session", "ok_1")
	t.Setenv("WUPHF_COMPOSIO_BASE_URL", composio.URL)
	t.Setenv("WUPHF_COMPOSIO_USER_ID", "operator@example.com")

	body := strings.NewReader(`{"provider":"composio","platform":"gmail"}`)
	req, _ := http.NewRequest(http.MethodPost, "http://"+b.addr+"/integrations/connect", body)
	req.Header.Set("Authorization", "Bearer test-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for a genuine upstream failure; body=%s", resp.StatusCode, raw)
	}
	if strings.Contains(string(raw), composioSignInExpiredCode) {
		t.Fatalf("a server error must not be reported as an expired sign-in: %s", raw)
	}
}

// seedComposioUserKeyConfig writes the exact credential shape the reporting
// user had: an empty composio_api_key and a populated uak_ trio.
func seedComposioUserKeyConfig(t *testing.T, userAPIKey, orgID string) {
	t.Helper()
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.ComposioAPIKey = ""
	cfg.ComposioUserAPIKey = userAPIKey
	cfg.ComposioOrgID = orgID
	if err := config.Save(cfg); err != nil {
		t.Fatal(err)
	}
}

// redactCreds renders a credential set for a failure message without printing
// any key material.
func redactCreds(c action.ComposioCredentials) map[string]bool {
	return map[string]bool{
		"project_key_set": strings.TrimSpace(c.APIKey) != "",
		"user_key_set":    strings.TrimSpace(c.UserAPIKey) != "",
		"org_set":         strings.TrimSpace(c.OrgID) != "",
	}
}

// assertNoComposioCredential fails if any credential material reached text.
func assertNoComposioCredential(t *testing.T, text string) {
	t.Helper()
	for _, prefix := range []string{"uak_", "ak_"} {
		if strings.Contains(text, prefix) {
			t.Fatalf("a %s-prefixed credential appears in %q", prefix, text)
		}
	}
}
