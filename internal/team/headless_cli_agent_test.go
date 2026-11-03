//go:build !windows

package team

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
	"github.com/nex-crm/wuphf/internal/provider"
)

// fakeAgentBinary writes a shell script standing in for an agent CLI: it
// records its argv and env, then prints a reply (or fails when exitCode != 0).
func fakeAgentBinary(t *testing.T, reply string, exitCode int) (bin, argsFile, envFile string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "gemini")
	argsFile = filepath.Join(dir, "args")
	envFile = filepath.Join(dir, "env")
	script := "#!/bin/sh\n" +
		"for a in \"$@\"; do printf '%s\\n---\\n' \"$a\"; done > '" + argsFile + "'\n" +
		"env > '" + envFile + "'\n" +
		"printf '%s\\n' '" + reply + "'\n"
	if exitCode != 0 {
		script += "echo 'not signed in' >&2\nexit 3\n"
	}
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, argsFile, envFile
}

func newCLIAgentTestLauncher(t *testing.T, bin string) *Launcher {
	t.Helper()
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WUPHF_RUNTIME_HOME", tmpHome)
	t.Setenv("WUPHF_OPENAI_API_KEY", "openai-secret-key")

	prev := headlessCLIAgentLookPath
	headlessCLIAgentLookPath = func(name string) (string, error) {
		if name == "gemini" {
			return bin, nil
		}
		return "", exec.ErrNotFound
	}
	t.Cleanup(func() { headlessCLIAgentLookPath = prev })

	stubLocalAgentScan(t, detectionFor(t, "gemini", true))
	b := newTestBroker(t)
	if resp := adoptLocalAgents(t, b, `{"ids":["gemini"]}`); len(resp.Adopted) != 1 {
		t.Fatalf("adopt gemini: %+v", resp)
	}
	return &Launcher{
		pack:     bot.GetPack("founding-team"),
		cwd:      t.TempDir(),
		broker:   b,
		headless: headlessWorkerPool{ctx: t.Context()},
	}
}

func TestRunHeadlessCLIAgentTurnPostsTheAgentsReply(t *testing.T) {
	bin, argsFile, envFile := fakeAgentBinary(t, "Shipped the fix.", 0)
	l := newCLIAgentTestLauncher(t, bin)

	if err := l.runHeadlessCLIAgentTurn(t.Context(), "gemini", "Fix the login bug.", testTeamRoom); err != nil {
		t.Fatalf("runHeadlessCLIAgentTurn: %v", err)
	}

	rawArgs, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("agent was not invoked: %v", err)
	}
	args := strings.Split(strings.TrimSuffix(string(rawArgs), "\n---\n"), "\n---\n")
	if len(args) != 2 || args[0] != "-p" {
		t.Fatalf("argv = %q, want [-p <prompt>]", args)
	}
	if !strings.Contains(args[1], "Fix the login bug.") || !strings.Contains(args[1], "RUNTIME NOTE") {
		t.Fatalf("prompt is missing the notification or the runtime note:\n%s", args[1])
	}

	env, _ := os.ReadFile(envFile)
	for _, secret := range []string{"openai-secret-key", "WUPHF_BROKER_TOKEN="} {
		if strings.Contains(string(env), secret) {
			t.Fatalf("agent env leaked %q", secret)
		}
	}

	posted := false
	for _, msg := range l.broker.AllMessages() {
		if msg.From == "gemini" && strings.Contains(msg.Content, "Shipped the fix.") {
			posted = true
		}
	}
	if !posted {
		t.Fatal("the agent's stdout was not posted as @gemini's reply")
	}
}

func TestRunHeadlessCLIAgentTurnSurfacesFailures(t *testing.T) {
	bin, _, _ := fakeAgentBinary(t, "", 3)
	l := newCLIAgentTestLauncher(t, bin)

	err := l.runHeadlessCLIAgentTurn(t.Context(), "gemini", "Do work.", testTeamRoom)
	if err == nil || !strings.Contains(err.Error(), "not signed in") {
		t.Fatalf("err = %v, want the agent's stderr", err)
	}
	warned := false
	for _, msg := range l.broker.AllMessages() {
		if msg.Kind == "error" && strings.Contains(msg.Content, "@gemini") && strings.Contains(msg.Content, "signed in") {
			warned = true
		}
	}
	if !warned {
		t.Fatal("expected a visible error telling the human the agent failed")
	}
}

func TestResolveCLIAgentBinaryRejectsBadBindings(t *testing.T) {
	cases := []provider.ProviderBinding{
		{Kind: provider.KindCLIAgent},
		{Kind: provider.KindCLIAgent, CLIAgent: &provider.CLIAgentProviderBinding{Agent: "cursor"}},
		{Kind: provider.KindCLIAgent, CLIAgent: &provider.CLIAgentProviderBinding{Agent: "not-a-thing"}},
	}
	for _, b := range cases {
		if _, _, err := resolveCLIAgentBinary(b); err == nil {
			t.Fatalf("resolveCLIAgentBinary(%+v) should fail", b)
		}
	}
}

func TestHeadlessDispatchRoutesCLIAgentKind(t *testing.T) {
	bin, argsFile, _ := fakeAgentBinary(t, "ok", 0)
	l := newCLIAgentTestLauncher(t, bin)
	if kind := l.effectiveProviderKindForBot(t.Context(), "gemini"); kind != provider.KindCLIAgent {
		t.Fatalf("effective kind = %q, want %q", kind, provider.KindCLIAgent)
	}
	if err := defaultHeadlessCodexRunTurn(l, t.Context(), "gemini", "ping", testTeamRoom); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if _, err := os.Stat(argsFile); err != nil {
		t.Fatal("dispatch did not reach the cli-agent runner")
	}
}
