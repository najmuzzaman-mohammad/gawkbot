package team

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/computer"
	"github.com/nex-crm/wuphf/internal/config"
)

// noRuntime is a Runner for a machine with no container CLI at all.
func noRuntime(_ context.Context, name string, args []string, _ time.Duration) (string, string, error) {
	return "", "", &computer.CommandError{Name: name, Args: args, Err: exec.ErrNotFound}
}

func newComputerTestBroker(t *testing.T, run computer.Runner) *Broker {
	t.Helper()
	t.Setenv("WUPHF_COMPUTERS_DIR", filepath.Join(t.TempDir(), "computers"))
	b := newBrokerWithTeamRoom(filepath.Join(t.TempDir(), "broker-state.json"))
	b.mu.Lock()
	b.members = append(b.members, officeMember{Slug: "cos", Name: "Chief of Staff"})
	b.rebuildMemberIndexLocked()
	b.mu.Unlock()
	svc := b.computers()
	svc.allowRuntime = true
	svc.runner = run
	svc.inspector = &computer.Inspector{Run: run, Platform: "darwin"}
	svc.manager = &computer.Manager{Run: run, Inspector: svc.inspector, Platform: "darwin"}
	return b
}

func computerMux(b *Broker) *http.ServeMux {
	mux := http.NewServeMux()
	b.registerComputerRoutes(mux)
	mux.HandleFunc("/office-members", b.requireAuth(b.handleOfficeMembers))
	return mux
}

func authedJSON(t *testing.T, srv *httptest.Server, token, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		payload, _ := json.Marshal(body)
		reader = bytes.NewReader(payload)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, srv.URL+path, reader)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestComputerStatusWithoutRuntimeIsHonest(t *testing.T) {
	b := newComputerTestBroker(t, noRuntime)
	srv := httptest.NewServer(computerMux(b))
	defer srv.Close()

	status, body := authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/cos", nil)
	if status != http.StatusOK {
		t.Fatalf("status %d %v", status, body)
	}
	// No explicit choice and no runtime: auto resolves to off, and the
	// payload says so instead of promising a machine.
	if body["destination"] != "off" || body["state"] != "off" {
		t.Fatalf("expected auto→off without a runtime, got %v", body)
	}
	status, body = authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/runtime", nil)
	if status != http.StatusOK || body["available"] != false || body["install_hint"] == "" {
		t.Fatalf("runtime payload must explain the missing runtime: %v", body)
	}
	// Choose sandbox explicitly: the status now names the missing runtime.
	status, body = authedJSON(t, srv, b.Token(), http.MethodPost, "/office-members", map[string]any{"action": "update", "slug": "cos", "computer": "sandbox"})
	if status != http.StatusOK {
		t.Fatalf("update: %d %v", status, body)
	}
	_, body = authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/cos", nil)
	if body["destination"] != "sandbox" || body["state"] != "runtime_missing" {
		t.Fatalf("expected runtime_missing, got %v", body)
	}
	if problem, _ := body["problem"].(string); !strings.Contains(problem, "Install") {
		t.Fatalf("problem must tell the person what to install: %v", body["problem"])
	}
	// Invalid destinations are refused.
	status, _ = authedJSON(t, srv, b.Token(), http.MethodPost, "/office-members", map[string]any{"action": "update", "slug": "cos", "computer": "mainframe"})
	if status != http.StatusBadRequest {
		t.Fatalf("bad destination must 400, got %d", status)
	}
	// Persisted on the member record.
	if m, ok := b.computers().member("cos"); !ok || m.Computer != "sandbox" {
		t.Fatalf("member must carry computer=sandbox, got %+v", m)
	}
}

func TestComputerRoutesRequireAuthAndJSON(t *testing.T) {
	b := newComputerTestBroker(t, noRuntime)
	srv := httptest.NewServer(computerMux(b))
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/computer/cos", nil)
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no bearer must 401, got %d", res.StatusCode)
	}
	res.Body.Close()
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/computer/cos/provision", strings.NewReader("action=provision"))
	req.Header.Set("Authorization", "Bearer "+b.Token())
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("form posts must be refused with 415, got %d", res.StatusCode)
	}
	res.Body.Close()
	status, _ := authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/ghost", nil)
	if status != http.StatusNotFound {
		t.Fatalf("unknown bot must 404, got %d", status)
	}
}

func TestComputerControlFlowAndEvents(t *testing.T) {
	b := newComputerTestBroker(t, noRuntime)
	srv := httptest.NewServer(computerMux(b))
	defer srv.Close()
	events, unsubscribe := b.computers().subscribe(16)
	defer unsubscribe()

	// The bot asks for hands through the bridge endpoint.
	status, body := authedJSON(t, srv, b.Token(), http.MethodPost, "/computer-control/cos", map[string]any{"action": "request-help", "reason": "log in to Xero"})
	if status != http.StatusOK || body["request_id"] == "" || body["help_open"] != true {
		t.Fatalf("request-help: %d %v", status, body)
	}
	_, body = authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/cos", nil)
	control, _ := body["control"].(map[string]any)
	if control["help_reason"] != "log in to Xero" || control["held"] != false {
		t.Fatalf("status must surface the plea: %v", control)
	}
	// The person takes the wheel; the bridge now sees held.
	status, body = authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/cos/control", map[string]any{"action": "take"})
	if status != http.StatusOK || body["held"] != true || body["help_reason"] != nil {
		t.Fatalf("take: %d %v", status, body)
	}
	_, body = authedJSON(t, srv, b.Token(), http.MethodGet, "/computer-control/cos", nil)
	if body["held"] != true {
		t.Fatalf("bridge view must be held: %v", body)
	}
	status, body = authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/cos/control", map[string]any{"action": "release"})
	if status != http.StatusOK || body["held"] != false {
		t.Fatalf("release: %d %v", status, body)
	}
	status, _ = authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/cos/control", map[string]any{"action": "steal"})
	if status != http.StatusBadRequest {
		t.Fatalf("unknown control action must 400, got %d", status)
	}
	// Every change reached SSE subscribers with the held flag.
	var seen []string
	deadline := time.After(2 * time.Second)
	for len(seen) < 3 {
		select {
		case evt := <-events:
			if evt.Held != nil {
				seen = append(seen, evt.Slug+":"+boolWord(*evt.Held))
			}
		case <-deadline:
			t.Fatalf("expected three control events, saw %v", seen)
		}
	}
	if strings.Join(seen, ",") != "cos:false,cos:true,cos:false" {
		t.Fatalf("unexpected control events %v", seen)
	}
}

func boolWord(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func TestMountForTurnSkipsWhenOffOrRuntimeMissing(t *testing.T) {
	b := newComputerTestBroker(t, noRuntime)
	svc := b.computers()
	events, unsubscribe := svc.subscribe(8)
	defer unsubscribe()
	mount, err := svc.mountForTurn(context.Background(), "cos", "turn-1", "", "http://x/computer-control/cos", "tok")
	if err != nil || mount != nil {
		t.Fatalf("auto with no runtime must mount nothing: %v %v", mount, err)
	}
	b.mu.Lock()
	b.members[len(b.members)-1].Computer = computerSandbox
	b.mu.Unlock()
	mount, err = svc.mountForTurn(context.Background(), "cos", "turn-1", "", "http://x/computer-control/cos", "tok")
	if err != nil || mount != nil {
		t.Fatalf("sandbox with no runtime must mount nothing and not fail the turn: %v %v", mount, err)
	}
	select {
	case evt := <-events:
		if evt.State != "runtime_missing" {
			t.Fatalf("expected runtime_missing event, got %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatalf("expected a runtime_missing event")
	}
	// Nil mounts are no-ops for the runners.
	var nilMount *computerMount
	if nilMount.mcpServers() != nil || nilMount.promptHint() != "" || nilMount.envPairs() != nil || nilMount.codexOverrides() != nil {
		t.Fatalf("nil mount must contribute nothing")
	}
}

func TestMountShapesForRunners(t *testing.T) {
	target := computer.TargetFor("cos", t.TempDir())
	launch := computer.ContainerMCPLaunch("/usr/local/bin/gawkbot", computer.RuntimeDocker, target, computer.ControlEndpoint{URL: "http://127.0.0.1:1/computer-control/cos", Token: "tok"})
	m := &computerMount{slug: "cos", turnID: "t", target: target, Launch: launch}
	servers := m.mcpServers()
	entry, _ := servers["computer"].(map[string]any)
	if entry["command"] != "/usr/local/bin/gawkbot" {
		t.Fatalf("unexpected command %v", entry)
	}
	args, _ := entry["args"].([]string)
	if strings.Join(args, " ") != "computer-mcp docker "+target.ContainerName+" "+computer.CuaSocket {
		t.Fatalf("unexpected args %v", args)
	}
	env, _ := entry["env"].(map[string]string)
	if env["WUPHF_COMPUTER_CONTROL_TOKEN"] != "tok" {
		t.Fatalf("control token must ride in env: %v", env)
	}
	if !strings.Contains(m.promptHint(), "mcp__computer__") || !strings.Contains(m.promptHint(), computer.WorkspaceGuest) {
		t.Fatalf("prompt hint must name the tools and the durable dir: %s", m.promptHint())
	}
	pairs := m.envPairs()
	if len(pairs) != 2 || !strings.HasPrefix(pairs[0], "WUPHF_COMPUTER_CONTROL_TOKEN=") {
		t.Fatalf("env pairs must be sorted KEY=VALUE: %v", pairs)
	}
	overrides := m.codexOverrides()
	joined := strings.Join(overrides, "\n")
	for _, want := range []string{`mcp_servers.computer.command="/usr/local/bin/gawkbot"`, `mcp_servers.computer.args=["computer-mcp","docker","` + target.ContainerName + `","` + computer.CuaSocket + `"]`, `mcp_servers.computer.env_vars=` + tomlStringArray([]string{"WUPHF_COMPUTER_CONTROL_TOKEN", "WUPHF_COMPUTER_CONTROL_URL"})} {
		if !strings.Contains(joined, want) {
			t.Fatalf("codex overrides missing %q in\n%s", want, joined)
		}
	}
	if !isComputerTool("mcp__computer__click") || isComputerTool("mcp__wuphf-office__team_broadcast") {
		t.Fatalf("isComputerTool must key on the computer prefix")
	}
}

func TestLifecycleErrorsMapToStatusCodes(t *testing.T) {
	rec := httptest.NewRecorder()
	writeComputerError(rec, &computer.LifecycleError{Status: http.StatusConflict, Message: "busy"})
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "busy") {
		t.Fatalf("lifecycle errors must keep their status: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	writeComputerError(rec, errors.New("boom"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("plain errors must 500, got %d", rec.Code)
	}
}

func TestConfigRefusesABadBoxKeyBeforeSaving(t *testing.T) {
	t.Setenv("WUPHF_CONFIG_PATH", filepath.Join(t.TempDir(), "config.json"))
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer box_good" {
			_, _ = w.Write([]byte(`{"ok":true,"boxes":[]}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer fake.Close()
	t.Setenv("WUPHF_BOX_API", fake.URL)
	b := newComputerTestBroker(t, noRuntime)
	mux := http.NewServeMux()
	mux.HandleFunc("/config", b.requireAuth(b.handleConfig))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	status, _ := authedJSON(t, srv, b.Token(), http.MethodPost, "/config", map[string]any{"box_api_key": "sk-not-a-box-key"})
	if status != http.StatusBadRequest {
		t.Fatalf("a rejected key must 400, got %d", status)
	}
	_, body := authedJSON(t, srv, b.Token(), http.MethodGet, "/config", nil)
	if body["box_key_set"] != false {
		t.Fatalf("a rejected key must not be saved: %v", body["box_key_set"])
	}
	status, _ = authedJSON(t, srv, b.Token(), http.MethodPost, "/config", map[string]any{"box_api_key": "box_good"})
	if status != http.StatusOK {
		t.Fatalf("a verified key must save, got %d", status)
	}
	_, body = authedJSON(t, srv, b.Token(), http.MethodGet, "/config", nil)
	if body["box_key_set"] != true {
		t.Fatalf("expected box_key_set after save: %v", body)
	}
}

// A fake `box` CLI: login prints the login_url event and exits, status
// reports signed in once a marker file exists, api-key create prints the
// secret. The marker lets the test flip the account state mid-flow.
func writeFakeBoxCLI(t *testing.T, dir string) string {
	t.Helper()
	marker := filepath.Join(dir, "signed-in")
	script := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  login) echo '{\"event\":\"login_url\",\"url\":\"https://ascii.dev/api/box/auth/github?state=abc\"}'; exit 0 ;;\n" +
		"  onboard) sleep 0.2; echo '{\"event\":\"login_complete\"}'; touch " + marker + "; exit 0 ;;\n" +
		"  status) if [ -f " + marker + " ]; then echo '{\"account\":{\"loginState\":\"signed in\"}}'; else echo '{\"account\":{\"loginState\":\"signed out\"}}'; fi ;;\n" +
		"  api-key) case \"$2\" in list) echo '{\"apiKeys\":[{\"id\":\"k1\",\"name\":\"gawkbot\"},{\"id\":\"k2\",\"name\":\"other\"}]}' ;; revoke) echo \"$3\" >> " + filepath.Join(dir, "revoked") + " ;; *) echo '{\"id\":\"k1\",\"secret\":\"box_minted\"}' ;; esac ;;\n" +
		"  logout) rm -f " + marker + "; echo '{\"event\":\"logged_out\"}' ;;\n" +
		"  limits) echo '{\"event\":\"limits\",\"limits\":{\"canStart\":false,\"blockedReason\":\"subscription_required\",\"planName\":null,\"accessTier\":\"trial\",\"trialLine\":\"2 boxes, 25h compute\"}}' ;;\n" +
		"  *) exit 2 ;;\n" +
		"esac\n"
	path := filepath.Join(dir, "box")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBoxSigninFlowMintsAndStoresAKey(t *testing.T) {
	t.Setenv("WUPHF_CONFIG_PATH", filepath.Join(t.TempDir(), "config.json"))
	t.Setenv("WUPHF_BOX_CLI", writeFakeBoxCLI(t, t.TempDir()))
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer box_minted" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/me":
			_, _ = w.Write([]byte(`{"ok":true,"user":{"login":"sam","email":"sam@example.com"}}`))
		case "/limits":
			_, _ = w.Write([]byte(`{"ok":true,"accessTier":"trial","blockedReason":"subscription_required","trialLine":"2 boxes, 25h compute"}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true,"boxes":[]}`))
		}
	}))
	defer fake.Close()
	t.Setenv("WUPHF_BOX_API", fake.URL)
	b := newComputerTestBroker(t, noRuntime)
	srv := httptest.NewServer(computerMux(b))
	defer srv.Close()

	status, body := authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/box/signin/start", map[string]any{})
	if status != http.StatusOK || body["status"] != "installing" {
		t.Fatalf("start: %d %v", status, body)
	}
	deadline := time.Now().Add(10 * time.Second)
	var last map[string]any
	for time.Now().Before(deadline) {
		_, last = authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/box/signin/status", nil)
		if last["status"] == "done" || last["status"] == "error" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if last["status"] != "done" {
		t.Fatalf("expected done, got %v", last)
	}
	if got := config.ResolveBoxAPIKey(); got != "box_minted" {
		t.Fatalf("minted key must be stored, got %q", got)
	}
	_, cfg := authedJSON(t, srv, b.Token(), http.MethodGet, "/config", nil)
	_ = cfg
	// A second start with a key present is done immediately.
	status, body = authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/box/signin/start", map[string]any{})
	if status != http.StatusOK || body["status"] != "done" {
		t.Fatalf("restart with key: %d %v", status, body)
	}
	_, account := authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/box/account?fresh=1", nil)
	if account["key_set"] != true || account["signed_in"] != true {
		t.Fatalf("account must report key and session: %v", account)
	}
	if account["can_start"] != false || account["blocked_reason"] != "subscription_required" || account["billing_url"] != boxBillingURL {
		t.Fatalf("account must surface the plan gate with a billing link: %v", account)
	}
	if account["identifier"] != "sam@example.com" {
		t.Fatalf("identity must come from the key via /me: %v", account)
	}
	// Sign out: revokes only the gawkbot key, ends the session, forgets the key.
	status, body = authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/box/signout", map[string]any{})
	if status != http.StatusOK || body["revoked_keys"] != float64(1) || body["logged_out"] != true {
		t.Fatalf("signout: %d %v", status, body)
	}
	if config.ResolveBoxAPIKey() != "" {
		t.Fatalf("signout must forget the key")
	}
	revoked, _ := os.ReadFile(filepath.Join(filepath.Dir(os.Getenv("WUPHF_BOX_CLI")), "revoked"))
	if strings.TrimSpace(string(revoked)) != "k1" {
		t.Fatalf("only the gawkbot key must be revoked, got %q", revoked)
	}
	_, account = authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/box/account?fresh=1", nil)
	if account["key_set"] != false || account["signed_in"] != false {
		t.Fatalf("account must be clear after signout: %v", account)
	}
	// And signing in again starts a fresh flow.
	status, body = authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/box/signin/start", map[string]any{})
	if status != http.StatusOK || body["status"] != "installing" {
		t.Fatalf("re-signin: %d %v", status, body)
	}
}

func TestBoxSigninReportsMissingCLIWhenInstallFails(t *testing.T) {
	t.Setenv("WUPHF_CONFIG_PATH", filepath.Join(t.TempDir(), "config.json"))
	t.Setenv("WUPHF_BOX_CLI", filepath.Join(t.TempDir(), "absent"))
	prev := boxInstaller
	boxInstaller = func(context.Context) error { return errors.New("offline") }
	t.Cleanup(func() { boxInstaller = prev })
	b := newComputerTestBroker(t, noRuntime)
	srv := httptest.NewServer(computerMux(b))
	defer srv.Close()
	status, body := authedJSON(t, srv, b.Token(), http.MethodPost, "/computer/box/signin/start", map[string]any{})
	if status != http.StatusOK || body["status"] != "installing" {
		t.Fatalf("start: %d %v", status, body)
	}
	deadline := time.Now().Add(5 * time.Second)
	var last map[string]any
	for time.Now().Before(deadline) {
		_, last = authedJSON(t, srv, b.Token(), http.MethodGet, "/computer/box/signin/status", nil)
		if last["status"] == "cli_missing" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if last["status"] != "cli_missing" || last["install_command"] == "" {
		t.Fatalf("expected cli_missing with the manual command, got %v", last)
	}
}

func TestComputerRuntimeGuardIsOffUnderGoTest(t *testing.T) {
	if computerRuntimeAllowed.Load() {
		t.Fatalf("computerRuntimeAllowed must be false in test binaries")
	}
	b := newRawTestBroker(t)
	if b.computers().allowRuntime {
		t.Fatalf("a broker built under go test must not touch a real runtime")
	}
	if rt := b.computers().runtimeStatus(t.Context(), true); rt.DaemonUp || rt.Available {
		t.Fatalf("runtime must be unavailable under tests: %+v", rt)
	}
}
