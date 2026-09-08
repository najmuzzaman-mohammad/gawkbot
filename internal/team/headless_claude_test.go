package team

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
	"github.com/nex-crm/wuphf/internal/provider"
)

// minimalLauncher builds a Launcher with a predictable two-member pack so
// officeLeadSlug() always returns "cos".
func minimalLauncher(opusCEO bool) *Launcher {
	return &Launcher{
		pack: &bot.PackDefinition{
			LeadSlug: "cos",
			Bots: []bot.BotConfig{
				{Slug: "cos", Name: "CEO"},
				{Slug: "eng", Name: "Engineer"},
				{Slug: "pm", Name: "Product Manager"},
			},
		},
		opusCEO: opusCEO,
		headless: headlessWorkerPool{
			workers: make(map[headlessLane]bool),
			active:  make(map[headlessLane]*headlessCodexActiveTurn),
			queues:  make(map[headlessLane][]headlessCodexTurn),
		},
	}
}

// ─── headlessClaudeMaxTurns ───────────────────────────────────────────────

// TestHeadlessClaudeMaxTurns_AppBuilderGetsBuildHeadroom pins the fix for the
// App Builder running out of turns mid-build: a coding/build bot needs far
// more than a chat specialist's budget.
func TestHeadlessClaudeMaxTurns_AppBuilderGetsBuildHeadroom(t *testing.T) {
	l := minimalLauncher(false)
	if got := l.headlessClaudeMaxTurns(appBuilderSlug, ""); got != "60" {
		t.Fatalf("app-builder max turns = %s, want 60 (build headroom)", got)
	}
	if got := l.headlessClaudeMaxTurns("cos", ""); got != "30" {
		t.Fatalf("lead max turns = %s, want 30", got)
	}
	if got := l.headlessClaudeMaxTurns("pm", ""); got != "15" {
		t.Fatalf("chat specialist max turns = %s, want 15", got)
	}
}

// ─── headlessClaudeModel ──────────────────────────────────────────────────

// TestHeadlessClaudeModel_SonnetByDefault verifies that every bot, including
// the lead, uses the Sonnet model when opusCEO is false.
func TestHeadlessClaudeModel_SonnetByDefault(t *testing.T) {
	l := minimalLauncher(false)
	for _, slug := range []string{"cos", "eng", "pm"} {
		t.Run(slug, func(t *testing.T) {
			if got := l.headlessClaudeModel(context.Background(), slug); got != "claude-sonnet-4-6" {
				t.Fatalf("slug=%q opusCEO=false: want claude-sonnet-4-6, got %q", slug, got)
			}
		})
	}
}

// TestHeadlessClaudeModel_OpusForLeadOnly verifies that only the lead (CEO)
// gets upgraded to Opus when opusCEO is true; non-lead bots stay on Sonnet.
func TestHeadlessClaudeModel_OpusForLeadOnly(t *testing.T) {
	l := minimalLauncher(true)
	tests := []struct {
		slug string
		want string
	}{
		{"cos", "claude-opus-4-8"},
		{"eng", "claude-sonnet-4-6"},
		{"pm", "claude-sonnet-4-6"},
	}
	for _, tc := range tests {
		t.Run(tc.slug, func(t *testing.T) {
			if got := l.headlessClaudeModel(context.Background(), tc.slug); got != tc.want {
				t.Fatalf("slug=%q opusCEO=true: want %q, got %q", tc.slug, tc.want, got)
			}
		})
	}
}

// TestHeadlessClaudeModel_CustomLeadSlug verifies model selection when the
// pack defines a non-"cos" lead slug. No broker is constructed, so
// officeMembersSnapshot() falls through to the pack definition.
func TestHeadlessClaudeModel_CustomLeadSlug(t *testing.T) {
	l := &Launcher{
		pack: &bot.PackDefinition{
			LeadSlug: "captain",
			Bots: []bot.BotConfig{
				{Slug: "captain", Name: "Captain"},
				{Slug: "crew", Name: "Crew"},
			},
		},
		opusCEO: true,
		headless: headlessWorkerPool{
			workers: make(map[headlessLane]bool),
			active:  make(map[headlessLane]*headlessCodexActiveTurn),
			queues:  make(map[headlessLane][]headlessCodexTurn),
		},
	}

	tests := []struct {
		slug string
		want string
	}{
		{"captain", "claude-opus-4-8"},
		{"crew", "claude-sonnet-4-6"},
	}
	for _, tc := range tests {
		t.Run(tc.slug, func(t *testing.T) {
			if got := l.headlessClaudeModel(context.Background(), tc.slug); got != tc.want {
				t.Fatalf("slug=%q: want %q, got %q", tc.slug, tc.want, got)
			}
		})
	}
}

// TestHeadlessClaudeModel_PerAgentBindingOverride covers the broker-driven
// override path that ships with the BotProfilePanel runtime picker. When
// a member has ProviderBinding{Kind: "claude-code", Model: "<custom>"},
// the next claude turn must dispatch against <custom>, not the hardcoded
// opus/sonnet default. The kind guard also matters: a stale Model left
// over from a brief codex sojourn must NOT be fed to claude on a
// switch-back.
//
// Three cases:
//
//  1. positive: Kind=claude-code, Model=non-empty → returns the bound model.
//  2. negative: Kind=codex with a non-empty Model → ignores the binding and
//     falls back to the default (codex models are not claude-routable).
//  3. negative: Kind=claude-code with an empty Model → falls back to the
//     default. The picker writes empty when the user selects "Use runtime
//     default" and the default must take effect.
func TestHeadlessClaudeModel_PerAgentBindingOverride(t *testing.T) {
	makeBoundLauncher := func(t *testing.T, slug string, binding provider.ProviderBinding) *Launcher {
		t.Helper()
		b := newTestBroker(t)
		b.mu.Lock()
		b.members = append(b.members, officeMember{
			Slug:     slug,
			Name:     slug,
			Provider: binding,
		})
		b.memberIndex = nil
		b.mu.Unlock()
		l := minimalLauncher(false)
		l.broker = b
		return l
	}

	tests := []struct {
		name    string
		slug    string
		binding provider.ProviderBinding
		want    string
	}{
		{
			name:    "claude_code_with_model_uses_binding",
			slug:    "eng",
			binding: provider.ProviderBinding{Kind: "claude-code", Model: "claude-opus-4-7"},
			want:    "claude-opus-4-7",
		},
		{
			name:    "non_claude_kind_falls_back_to_default",
			slug:    "eng",
			binding: provider.ProviderBinding{Kind: "codex", Model: "gpt-5.5"},
			want:    "claude-sonnet-4-6",
		},
		{
			name:    "claude_code_empty_model_falls_back_to_default",
			slug:    "eng",
			binding: provider.ProviderBinding{Kind: "claude-code", Model: ""},
			want:    "claude-sonnet-4-6",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			l := makeBoundLauncher(t, tc.slug, tc.binding)
			if got := l.headlessClaudeModel(context.Background(), tc.slug); got != tc.want {
				t.Fatalf("headlessClaudeModel(%q) with binding %+v = %q, want %q",
					tc.slug, tc.binding, got, tc.want)
			}
		})
	}
}

// ─── runHeadlessClaudeTurn: no --resume flag in fresh sessions ────────────

// TestRunHeadlessClaudeTurn_NoResumeFlag verifies that the command assembled
// for a fresh (non-resumed) session does NOT contain --resume.
//
// We intercept headlessClaudeCommandContext to record the argv before any
// process is started. The binary is pointed at /bin/true so the process exits
// cleanly; the function will fail at JSON parsing (no output), but the
// captured args are all we need.
func TestRunHeadlessClaudeTurn_NoResumeFlag(t *testing.T) {
	// Redirect broker state to an isolated temp dir.
	tmpDir := t.TempDir()

	origCommandContext := headlessClaudeCommandContext
	origLookPath := headlessClaudeLookPath
	defer func() {
		headlessClaudeCommandContext = origCommandContext
		headlessClaudeLookPath = origLookPath
	}()

	var capturedArgs []string

	// Simulate claude found on PATH.
	headlessClaudeLookPath = func(file string) (string, error) { return "/bin/true", nil }

	// Intercept command creation: record the args then delegate to a real
	// exec.Cmd pointing at /bin/true so Start()/Wait() succeed trivially.
	headlessClaudeCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		capturedArgs = append(capturedArgs, args...)
		return exec.CommandContext(ctx, "/bin/true")
	}

	b := newBrokerWithTeamRoom(filepath.Join(tmpDir, "broker-state.json"))
	l := minimalLauncher(false)
	l.broker = b
	l.cwd = tmpDir

	// Write a valid (empty) MCP config so ensureBotMCPConfig succeeds.
	mcpPath := filepath.Join(tmpDir, "mcp.json")
	_ = os.WriteFile(mcpPath, []byte(`{"mcpServers":{}}`), 0o600)
	l.mcpConfig = mcpPath

	// The function returns a parse error because /bin/true produces no JSON.
	// That is expected; we only care about capturedArgs.
	_ = l.runHeadlessClaudeTurn(t.Context(), "eng", "do the thing")

	if len(capturedArgs) == 0 {
		t.Fatal("no args captured; headlessClaudeCommandContext hook was not called")
	}
	for _, arg := range capturedArgs {
		if arg == "--resume" {
			t.Fatalf("--resume must not appear in a fresh session, got args: %v", capturedArgs)
		}
	}
}

// TestBuildMCPServerMap_NoNexExcludesNexServer verifies that when
// WUPHF_NO_NEX=true the built server map contains no "nex" entry, even if a
// non-empty API key is present.
func TestBuildMCPServerMap_GBrainCredentialsFlowThroughOffice(t *testing.T) {
	t.Setenv("WUPHF_MEMORY_BACKEND", "gbrain")
	t.Setenv("WUPHF_OPENAI_API_KEY", "openai-test-key")

	l := minimalLauncher(false)
	servers, err := l.buildMCPServerMap()
	if err != nil {
		t.Fatalf("buildMCPServerMap: %v", err)
	}
	entry, ok := servers["wuphf-office"]
	if !ok {
		t.Fatalf("'wuphf-office' server must be present when GBrain is selected, got servers: %v", mapKeys(servers))
	}
	server, ok := entry.(map[string]any)
	if !ok {
		t.Fatalf("expected wuphf-office entry to be an object, got %T", entry)
	}
	env, ok := server["env"].(map[string]string)
	if !ok {
		t.Fatalf("expected office env map, got %#v", server["env"])
	}
	if env["OPENAI_API_KEY"] != "openai-test-key" {
		t.Fatalf("expected OPENAI_API_KEY to flow through office env, got %#v", env)
	}
}

// mapKeys returns the keys of map[string]V for human-readable error messages.
func mapKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// TestBuildMCPServerMap_NeverMountsRetiredNexServer pins the removal: no
// combination of leftover environment may resurrect a "nex" MCP server. The
// legacy WUPHF_NO_NEX/WUPHF_API_KEY vars are set here precisely because they
// are still in real launchers and shells.
func TestBuildMCPServerMap_NeverMountsRetiredNexServer(t *testing.T) {
	t.Setenv("WUPHF_CONFIG_PATH", filepath.Join(t.TempDir(), "config.json"))
	t.Setenv("WUPHF_NO_NEX", "")
	t.Setenv("WUPHF_API_KEY", "test-key-12345")
	t.Setenv("WUPHF_MEMORY_BACKEND", "nex")

	l := minimalLauncher(false)
	servers, err := l.buildMCPServerMap()
	if err != nil {
		t.Fatalf("buildMCPServerMap: %v", err)
	}
	if _, ok := servers["nex"]; ok {
		t.Fatalf("a \"nex\" MCP server must never be mounted, got servers: %v", mapKeys(servers))
	}
	if _, ok := servers["wuphf-office"]; !ok {
		t.Fatalf("'wuphf-office' server must always be present, got servers: %v", mapKeys(servers))
	}
}

// TestHeadlessClaudeMaxTurns_AnyAgentMidBuildGetsHeadroom: app building is a
// system skill every agent carries, so an agent that owns an open app build
// task gets the App Builder's budget; the same agent with no build in flight
// stays on the chat budget.
func TestHeadlessClaudeMaxTurns_AnyAgentMidBuildGetsHeadroom(t *testing.T) {
	b := newTestBroker(t)
	l := minimalLauncher(false)
	l.broker = b

	if got := l.headlessClaudeMaxTurns("pm", ""); got != "15" {
		t.Fatalf("pm with no build = %s, want 15", got)
	}

	b.mu.Lock()
	b.tasks = append(b.tasks, teamTask{
		ID:      "task-build",
		Title:   "Build app: Tip Calculator",
		Owner:   "pm",
		Channel: "team",
		Details: "Bill amount and tip.\n\n" + appWorkspaceBrief("app_1", "/tmp/app_1/src"),
		status:  "in_progress",
	})
	b.mu.Unlock()
	if got := l.headlessClaudeMaxTurns("pm", ""); got != "60" {
		t.Fatalf("pm mid-build = %s, want 60 (build headroom)", got)
	}

	b.mu.Lock()
	b.tasks[len(b.tasks)-1].status = "done"
	b.mu.Unlock()
	if got := l.headlessClaudeMaxTurns("pm", ""); got != "15" {
		t.Fatalf("pm after the build is done = %s, want 15", got)
	}
}

// TestHeadlessClaudeMaxTurns_AppAskGetsHeadroom: the budget is fixed at
// launch and the build task is created during the turn, so the human's ask
// itself must unlock the build budget.
func TestHeadlessClaudeMaxTurns_AppAskGetsHeadroom(t *testing.T) {
	l := minimalLauncher(false)
	cases := map[string]string{
		"Build me a Unit Converter app: km to miles.":             "60",
		"create an app that tracks sponsor follow-ups":            "60",
		"Can you make a small internal tool for expense reports?": "60",
		"Ship the onboarding checklist app today":                 "60",
		"what pressure for espresso?":                             "15",
		"Build the landing page copy":                             "15",
		"":                                                        "15",
	}
	for ask, want := range cases {
		if got := l.headlessClaudeMaxTurns("pm", ask); got != want {
			t.Fatalf("max turns for %q = %s, want %s", ask, got, want)
		}
	}
}

// TestWithAppAskPreface: an app ask gets the order-of-operations preface in
// the message itself; anything else passes through untouched.
func TestWithAppAskPreface(t *testing.T) {
	ask := "Build me a Unit Converter app: km to miles."
	got := withAppAskPreface(ask)
	if !strings.HasPrefix(got, "APP ASK") || !strings.HasSuffix(got, ask) {
		t.Fatalf("app ask not prefaced: %q", got)
	}
	if !strings.Contains(got, "team_task action=create") || !strings.Contains(got, "register_app(") {
		t.Fatalf("preface missing the task-first / publish steps: %q", got)
	}
	plain := "what pressure for espresso?"
	if withAppAskPreface(plain) != plain {
		t.Fatalf("non-app message must pass through unchanged")
	}
}

// TestTurnParkedOnInterview_RequiresALiveTurn: a pending interview row
// alone must not hold a bot's wakes. After a restart the row survives but
// the polling turn is gone; holding on the row made the Chief of Staff
// unreachable until someone found the stale card (prod, 2026-09-07).
func TestTurnParkedOnInterview_RequiresALiveTurn(t *testing.T) {
	b := newTestBroker(t)
	l := minimalLauncher(false)
	l.broker = b

	b.mu.Lock()
	b.requests = []humanInterview{{ID: "r1", Kind: "interview", Status: "pending", From: "pm", Channel: "human__pm", Question: "q"}}
	b.mu.Unlock()
	if !b.BotAwaitingInterviewAnswer("pm") {
		t.Fatalf("precondition: pm has a pending interview")
	}
	if l.turnParkedOnInterview(notificationTarget{Slug: "pm"}) {
		t.Fatalf("no live turn: the wake must go through so the bot can re-read the chat")
	}

	lane := headlessLane{slug: "pm"}
	l.headless.mu.Lock()
	l.headless.active[lane] = &headlessCodexActiveTurn{}
	l.headless.mu.Unlock()
	if !l.turnParkedOnInterview(notificationTarget{Slug: "pm"}) {
		t.Fatalf("live turn parked in the answer poll (interview without a task): the wake must be held")
	}

	// An interview tied to a task holds only while THAT task's turn is live.
	b.mu.Lock()
	b.requests[0].IssueID = "task-9"
	b.mu.Unlock()
	l.headless.mu.Lock()
	l.headless.active[lane] = &headlessCodexActiveTurn{Turn: headlessCodexTurn{TaskID: "task-1"}}
	l.headless.mu.Unlock()
	if l.turnParkedOnInterview(notificationTarget{Slug: "pm"}) {
		t.Fatalf("a live turn on an unrelated task is real work, not a parked poll")
	}
	l.headless.mu.Lock()
	l.headless.active[lane] = &headlessCodexActiveTurn{Turn: headlessCodexTurn{TaskID: "task-9"}}
	l.headless.mu.Unlock()
	if !l.turnParkedOnInterview(notificationTarget{Slug: "pm"}) {
		t.Fatalf("the interview's own task turn is the parked one: hold")
	}
	if l.turnParkedOnInterview(notificationTarget{Slug: "eng"}) {
		t.Fatalf("another bot with no interview must never be held")
	}
}
