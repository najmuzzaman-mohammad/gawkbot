package team

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/config"
)

// Automatic sign-in on connect (broker_composio_autologin.go). Same fixture
// precedent as broker_composio_signin_test.go: a fake `composio` shell script
// on a stripped PATH, an isolated HOME, no network, and no real credential
// anywhere.

// composioSigninPost posts to the start endpoint with an optional body, so a
// test can exercise the automatic path ({"auto":true}) and the button path
// (no body) through the one entrypoint both use.
func composioSigninPost(t *testing.T, b *Broker, path string, body any) composioSigninState {
	t.Helper()
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(http.MethodPost, "http://"+b.addr+path, payload)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var state composioSigninState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatalf("decode %s: %v (body %q)", path, err, string(raw))
	}
	return state
}

// stopComposioSigninOnCleanup cancels whatever flow the test left running, so
// its background goroutines cannot outlive the test and act on the NEXT test's
// isolated HOME. Cleanups run last-registered-first, so this lands before the
// broker shutdown registered by newComposioSigninBroker.
func stopComposioSigninOnCleanup(t *testing.T, b *Broker) {
	t.Helper()
	t.Cleanup(func() {
		composioSigninPost(t, b, "/integrations/composio/signin/cancel", nil)
	})
}

func autoStart(t *testing.T, b *Broker) composioSigninState {
	t.Helper()
	return composioSigninPost(t, b, "/integrations/composio/signin/start", map[string]bool{"auto": true})
}

// fakeComposioLoginCLI writes a CLI whose `login --no-wait` prints a session
// URL and counts its invocations, and whose `login --poll` blocks on a gate
// file before recording a session.
func fakeComposioLoginCLI(t *testing.T, dir, counter, gate string) {
	t.Helper()
	writeFakeComposioCLI(t, dir, `
case "$1 $2" in
  "login --no-wait")
    echo started >> "`+counter+`"
    echo 'Open this URL in your browser to log in:'
    echo '  https://platform.composio.dev/?cliKey=sess_auto123'
    ;;
  "login --poll")
    i=0
    while [ ! -f "`+gate+`" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
    mkdir -p "$HOME/.composio"
    printf '{"api_key":"uak_cli_only_session_key"}' > "$HOME/.composio/user_data.json"
    ;;
  "dev init")
    printf 'COMPOSIO_API_KEY=`+testComposioProjectKey+`\n' > .env.local
    ;;
  *) exit 1 ;;
esac`)
}

// TestComposioAutoSignin_StartsWithNoSession: a connect-triggered sign-in with
// no stored session opens the login itself — the user sees awaiting_login and a
// URL, not a button to press.
func TestComposioAutoSignin_StartsWithNoSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell script requires a POSIX shell")
	}
	dir := t.TempDir()
	counter := filepath.Join(dir, "no-wait-count")
	gate := filepath.Join(dir, "poll-gate")
	fakeComposioLoginCLI(t, dir, counter, gate)
	b := newComposioSigninBroker(t, dir)
	stopComposioSigninOnCleanup(t, b)

	state := autoStart(t, b)
	if state.Status != composioSigninStatusAwaitingLogin {
		t.Fatalf("expected an automatic sign-in to reach awaiting_login, got %+v", state)
	}
	if state.AuthURL != "https://platform.composio.dev/?cliKey=sess_auto123" {
		t.Fatalf("expected the login URL to be surfaced for the UI to show and copy, got %q", state.AuthURL)
	}
}

// TestComposioAutoSignin_ConcurrentConnectsProduceOneLogin: several connects
// racing each other must join ONE login, through the existing single-flight —
// not mint one browser session each.
func TestComposioAutoSignin_ConcurrentConnectsProduceOneLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell script requires a POSIX shell")
	}
	dir := t.TempDir()
	counter := filepath.Join(dir, "no-wait-count")
	gate := filepath.Join(dir, "poll-gate")
	fakeComposioLoginCLI(t, dir, counter, gate)
	b := newComposioSigninBroker(t, dir)
	stopComposioSigninOnCleanup(t, b)

	const racers = 6
	var wg sync.WaitGroup
	states := make([]composioSigninState, racers)
	wg.Add(racers)
	for i := range racers {
		go func() {
			defer wg.Done()
			states[i] = autoStart(t, b)
		}()
	}
	wg.Wait()

	data, err := os.ReadFile(counter)
	if err != nil {
		t.Fatalf("read invocation counter: %v", err)
	}
	if got := strings.Count(string(data), "started"); got != 1 {
		t.Fatalf("expected exactly one login session for %d concurrent connects, got %d", racers, got)
	}
	for i, state := range states {
		switch state.Status {
		case composioSigninStatusAwaitingLogin, composioSigninStatusProvisioning, composioSigninStatusDone:
		default:
			t.Fatalf("racer %d saw %+v; every concurrent connect must observe the shared flow", i, state)
		}
	}
}

// TestComposioAutoSignin_DoesNotRestartAfterCancel: the user stopped it once.
// The next connect must offer the button (idle), not start another login.
func TestComposioAutoSignin_DoesNotRestartAfterCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell script requires a POSIX shell")
	}
	dir := t.TempDir()
	counter := filepath.Join(dir, "no-wait-count")
	gate := filepath.Join(dir, "poll-gate")
	fakeComposioLoginCLI(t, dir, counter, gate)
	b := newComposioSigninBroker(t, dir)
	stopComposioSigninOnCleanup(t, b)

	if state := autoStart(t, b); state.Status != composioSigninStatusAwaitingLogin {
		t.Fatalf("expected the first automatic sign-in to start, got %+v", state)
	}
	cancelled := composioSigninPost(t, b, "/integrations/composio/signin/cancel", nil)
	if cancelled.Status != composioSigninStatusIdle {
		t.Fatalf("expected cancel to return the flow to idle, got %+v", cancelled)
	}

	second := autoStart(t, b)
	if second.Status != composioSigninStatusIdle {
		t.Fatalf("expected no second automatic sign-in after a cancel, got %+v", second)
	}
	if data, _ := os.ReadFile(counter); strings.Count(string(data), "started") != 1 {
		t.Fatalf("a cancelled automatic sign-in must not be retried on the next connect; invocations: %q", string(data))
	}

	// The explicit button still works, and clears the latch.
	if state := composioSigninPost(t, b, "/integrations/composio/signin/start", nil); state.Status != composioSigninStatusAwaitingLogin {
		t.Fatalf("expected the explicit sign-in button to still start a flow, got %+v", state)
	}
}

// TestComposioAutoSignin_CancelStopsProvisioning: a cancel that lands while the
// flow is finishing must not store a credential behind the user's back.
func TestComposioAutoSignin_CancelStopsProvisioning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell script requires a POSIX shell")
	}
	dir := t.TempDir()
	devInitGate := filepath.Join(dir, "dev-init-gate")
	devInitDone := filepath.Join(dir, "dev-init-done")
	writeFakeComposioCLI(t, dir, `
case "$1 $2" in
  "dev init")
    i=0
    while [ ! -f "`+devInitGate+`" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
    printf 'COMPOSIO_API_KEY=`+testComposioProjectKey+`\n' > .env.local
    echo done > "`+devInitDone+`"
    ;;
  *) exit 1 ;;
esac`)
	b := newComposioSigninBroker(t, dir)
	markComposioLoggedIn(t) // CLI session present → start goes straight to provisioning

	if state := autoStart(t, b); state.Status != composioSigninStatusProvisioning {
		t.Fatalf("expected provisioning with a live CLI session, got %+v", state)
	}
	if state := composioSigninPost(t, b, "/integrations/composio/signin/cancel", nil); state.Status != composioSigninStatusIdle {
		t.Fatalf("expected idle after cancel, got %+v", state)
	}
	// Let the subprocess finish AFTER the cancel, and wait for it to actually
	// finish — so this asserts on a completed mint that was discarded, not on
	// a race the test happened to win.
	if err := os.WriteFile(devInitGate, []byte("go"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !testTickUntil(t, 10*time.Second, func() bool {
		_, err := os.Stat(devInitDone)
		return err == nil
	}) {
		t.Fatal("the fake CLI never finished; the assertion below would prove nothing")
	}
	_, state, _ := composioSigninRequest(t, b, http.MethodGet, "/integrations/composio/signin/status")
	if state.Status != composioSigninStatusIdle {
		t.Fatalf("a cancelled flow must not finish behind the user, got %+v", state)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config load: %v", err)
	}
	if strings.TrimSpace(cfg.ComposioAPIKey) != "" {
		t.Fatal("a cancelled sign-in must not store a credential")
	}
}

// TestComposioAutoSignin_MissingCLIAsksBeforeInstalling is the destructive-action
// carve-out: an automatic sign-in that finds no CLI must stop and ask, and must
// NOT run the installer. The explicit answer then installs.
func TestComposioAutoSignin_MissingCLIAsksBeforeInstalling(t *testing.T) {
	dir := t.TempDir() // empty PATH dir — no composio binary
	var mu sync.Mutex
	installs := 0
	restore := composioInstaller
	composioInstaller = func(context.Context) error {
		mu.Lock()
		installs++
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { composioInstaller = restore })
	b := newComposioSigninBroker(t, dir)

	state := autoStart(t, b)
	if state.Status != composioSigninStatusInstallRequired {
		t.Fatalf("expected an automatic sign-in to ASK before installing, got %+v", state)
	}
	mu.Lock()
	ran := installs
	mu.Unlock()
	if ran != 0 {
		t.Fatalf("an automatic sign-in must not install software; installer ran %d times", ran)
	}

	// Answering yes is an explicit start, which is allowed to install.
	if state := composioSigninPost(t, b, "/integrations/composio/signin/start", nil); state.Status != composioSigninStatusInstalling {
		t.Fatalf("expected the confirmed install to run, got %+v", state)
	}
	testTickUntil(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return installs > 0
	})
	mu.Lock()
	ran = installs
	mu.Unlock()
	if ran == 0 {
		t.Fatal("expected the installer to run once the human confirmed it")
	}
}

// TestComposioSigninCopy_NoProtocolDebris pins the honesty rule for every
// sentence this flow can put in front of an operator: no status code, slug,
// request id, environment variable, or shell command. The install command is
// carried in its own field and rendered behind a disclosure — never inside a
// sentence.
func TestComposioSigninCopy_NoProtocolDebris(t *testing.T) {
	sentences := map[string]string{
		"signin_required":    composioSignInRequiredMessage,
		"signin_expired":     composioSignInExpiredMessage,
		"signin_unavailable": composioSigninUnavailableMessage,
		"signin_timed_out":   composioSigninTimedOutMessage,
		"install_failed":     composioInstallFailedMessage,
		"install_stalled":    composioInstallStalledMessage,
	}
	// Shell-command shapes, credential/slug prefixes, env var names, status
	// codes, and identifier-ish tokens.
	banned := []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bcomposio (login|dev init|install)\b`),
		regexp.MustCompile(`(?i)\b(curl|npm|brew|bash|sh)\b`),
		regexp.MustCompile(`[A-Z][A-Z0-9]*_[A-Z0-9_]+`), // COMPOSIO_API_KEY, UserApiKey_Unauthorized
		regexp.MustCompile(`\b(ak_|uak_|pr_)`),
		regexp.MustCompile(`\b(401|403|2113|801|906)\b`),
		regexp.MustCompile(`(?i)request[ _]id`),
		regexp.MustCompile("`"), // no inline code spans
	}
	for name, sentence := range sentences {
		if strings.TrimSpace(sentence) == "" {
			t.Fatalf("%s: empty operator copy", name)
		}
		for _, re := range banned {
			if re.MatchString(sentence) {
				t.Fatalf("%s: operator copy must not contain protocol debris (%s matched): %q", name, re, sentence)
			}
		}
		if !strings.HasSuffix(strings.TrimSpace(sentence), ".") {
			t.Fatalf("%s: operator copy should be a sentence: %q", name, sentence)
		}
	}
}

// TestIntegrationConnect_NeverSignedInRoutesToSignin is the first-run half of
// the founder's "when logged out": an office with NO Composio credential at all
// must reach the same recovery as one whose credential was revoked, and must
// never be shown the configuration hint the underlying error carries.
func TestIntegrationConnect_NeverSignedInRoutesToSignin(t *testing.T) {
	dir := t.TempDir()
	writeFakeComposioCLI(t, dir, "exit 1")
	b := newComposioSigninBroker(t, dir)
	resetComposioRemintState(t, b)
	// Isolated HOME already means no stored credential; be explicit about the
	// env overrides a developer box may carry.
	for _, key := range []string{
		"WUPHF_COMPOSIO_API_KEY", "COMPOSIO_API_KEY",
		"WUPHF_COMPOSIO_USER_API_KEY", "WUPHF_COMPOSIO_ORG_ID",
	} {
		t.Setenv(key, "")
	}
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
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 so the UI routes to sign-in; body=%s", resp.StatusCode, raw)
	}
	var decoded integrationErrorBody
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("response is not the error envelope: %s", raw)
	}
	if decoded.Error != composioSignInRequiredCode {
		t.Fatalf("error code = %q, want %q", decoded.Error, composioSignInRequiredCode)
	}
	if decoded.Message != composioSignInRequiredMessage {
		t.Fatalf("message = %q, want the first-run sentence", decoded.Message)
	}
	// The raw error names an environment variable. It must not survive here.
	if strings.Contains(string(raw), "COMPOSIO_API_KEY") {
		t.Fatalf("configuration hints must not reach the browser: %s", raw)
	}
}
