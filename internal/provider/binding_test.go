package provider

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/agentdetect"
)

// agentdetect duplicates the cli-agent kind string to stay dependency-free;
// pin the two together so a rename cannot drift silently.
func TestCLIAgentKindMatchesAgentDetect(t *testing.T) {
	t.Parallel()
	if KindCLIAgent != agentdetect.ProviderKindCLIAgent {
		t.Fatalf("KindCLIAgent=%q, agentdetect.ProviderKindCLIAgent=%q", KindCLIAgent, agentdetect.ProviderKindCLIAgent)
	}
}

func TestBindingJSONRoundTrip_CLIAgent(t *testing.T) {
	t.Parallel()
	in := ProviderBinding{Kind: KindCLIAgent, Model: "m", CLIAgent: &CLIAgentProviderBinding{Agent: "gemini"}}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"cli_agent":{"agent":"gemini"}`) {
		t.Fatalf("marshal = %s", data)
	}
	var out ProviderBinding
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if out.CLIAgent == nil || out.CLIAgent.Agent != "gemini" || out.Kind != KindCLIAgent {
		t.Fatalf("round trip = %+v", out)
	}
}

func TestBindingJSONRoundTrip_LocalSession(t *testing.T) {
	t.Parallel()
	in := ProviderBinding{Kind: KindLocalSession, Model: "claude-opus-5-5", Session: &LocalSessionBinding{
		Tool: "claude-code", SessionID: "claude-code:1a2b3c4d-0000-4000-8000-000000000001", Cwd: "/Users/me/shop",
	}}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	want := `"session":{"tool":"claude-code","session_id":"claude-code:1a2b3c4d-0000-4000-8000-000000000001","cwd":"/Users/me/shop"}`
	if !strings.Contains(string(data), want) {
		t.Fatalf("marshal = %s, want it to contain %s", data, want)
	}
	var out ProviderBinding
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if out.Kind != KindLocalSession || out.Session == nil || !reflect.DeepEqual(*out.Session, *in.Session) {
		t.Fatalf("round trip = %+v", out)
	}
	// A binding without a session writes no empty object.
	plain, _ := json.Marshal(ProviderBinding{Kind: KindCodex})
	if strings.Contains(string(plain), "session") {
		t.Fatalf("a codex binding wrote a session: %s", plain)
	}
	// The registry must not know this kind: an unregistered kind is neither
	// pane eligible nor listed as a runtime a bot can be put on.
	if Lookup(KindLocalSession) != nil {
		t.Fatal("local-session must stay out of the runtime registry")
	}
	for _, k := range LLMProviderKinds() {
		if k == KindLocalSession {
			t.Fatal("local-session must not be offered as a runtime")
		}
	}
}

func TestValidateKind(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"empty_allowed", "", false},
		{"claude_code", "claude-code", false},
		{"codex", "codex", false},
		{"opencode", "opencode", false},
		{"openclaw", "openclaw", false},
		{"openclaw_http", "openclaw-http", false},
		{"hermes_agent", "hermes-agent", false},
		{"slack", "slack", false},
		{"cli_agent", "cli-agent", false},
		{"local_session", "local-session", false},
		{"unknown", "gemini", true},
		{"typo", "claud-code", true},
		{"uppercase_rejected", "Codex", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateKind(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateKind(%q) err=%v wantErr=%v", tt.in, err, tt.wantErr)
			}
			if err != nil && !strings.Contains(err.Error(), "claude-code") {
				t.Fatalf("ValidateKind(%q) err=%v should list valid values", tt.in, err)
			}
		})
	}
}

func TestBindingJSONRoundTrip_Empty(t *testing.T) {
	t.Parallel()
	var b ProviderBinding
	data, err := json.Marshal(b)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(data) != "{}" {
		t.Fatalf("empty binding should marshal to {}, got %s", data)
	}
	var got ProviderBinding
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Kind != "" || got.Model != "" || got.Openclaw != nil {
		t.Fatalf("empty round-trip lost zero value: %+v", got)
	}
}

func TestBindingJSONRoundTrip_Claude(t *testing.T) {
	t.Parallel()
	in := ProviderBinding{Kind: "claude-code", Model: "claude-sonnet-4.6"}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), "openclaw") {
		t.Fatalf("claude binding should not emit openclaw field, got %s", data)
	}
	var got ProviderBinding
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got != in {
		t.Fatalf("round-trip mismatch: got=%+v want=%+v", got, in)
	}
}

func TestBindingJSONRoundTrip_Openclaw(t *testing.T) {
	t.Parallel()
	in := ProviderBinding{
		Kind:     "openclaw",
		Model:    "openai-codex/gpt-5.4",
		Openclaw: &OpenclawProviderBinding{SessionKey: "agent:foo:demo", BotID: "main"},
	}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got ProviderBinding
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Kind != in.Kind || got.Model != in.Model {
		t.Fatalf("round-trip lost core fields: got=%+v want=%+v", got, in)
	}
	if got.Openclaw == nil || *got.Openclaw != *in.Openclaw {
		t.Fatalf("round-trip lost openclaw block: got=%+v want=%+v", got.Openclaw, in.Openclaw)
	}
}

func TestBindingJSONRoundTrip_Slack(t *testing.T) {
	t.Parallel()
	in := ProviderBinding{
		Kind:  KindSlack,
		Slack: &SlackProviderBinding{UserID: "U0123ABCD"},
	}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got ProviderBinding
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Kind != in.Kind {
		t.Fatalf("round-trip lost kind: got=%+v want=%+v", got, in)
	}
	if got.Slack == nil || *got.Slack != *in.Slack {
		t.Fatalf("round-trip lost slack block: got=%+v want=%+v", got.Slack, in.Slack)
	}
	// A non-slack binding must not emit an empty slack object.
	plain, err := json.Marshal(ProviderBinding{Kind: KindCodex})
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	if strings.Contains(string(plain), "slack") {
		t.Fatalf("non-slack binding leaked slack key: %s", plain)
	}
}

func TestResolveKindFallsBackToGlobal(t *testing.T) {
	t.Parallel()
	// Caller-provided global resolver — tests the shape without depending on config.
	global := func() string { return "codex" }
	if got := ResolveKind(ProviderBinding{Kind: ""}, global); got != "codex" {
		t.Fatalf("empty Kind should fall back to global, got %q", got)
	}
	if got := ResolveKind(ProviderBinding{Kind: "claude-code"}, global); got != "claude-code" {
		t.Fatalf("explicit Kind should win, got %q", got)
	}
}

func TestIsGatewayKind(t *testing.T) {
	t.Parallel()
	gateways := []string{KindOpenclaw, KindOpenclawHTTP, KindHermesBot, KindSlack}
	for _, k := range gateways {
		if !IsGatewayKind(k) {
			t.Errorf("IsGatewayKind(%q) = false, want true", k)
		}
	}
	// A local session is neither a gateway nor a runtime the office drives:
	// it must not pick up the "managed by a gateway" treatment.
	llms := []string{"", KindClaudeCode, KindCodex, KindOpencode, KindMLXLM, KindOllama, KindExo, KindLocalSession}
	for _, k := range llms {
		if IsGatewayKind(k) {
			t.Errorf("IsGatewayKind(%q) = true, want false", k)
		}
	}
}

// TestLLMProviderKindsExcludesGateways locks in the picker-source contract:
// every gateway-registered kind must be excluded from LLMProviderKinds, and
// every directly-dispatchable LLM must be included. The picker-UIs read this
// list verbatim — if it leaks "openclaw-http" the SettingsApp dropdown will
// surface a gateway as a global default and the friction-gate purpose is lost.
func TestLLMProviderKindsExcludesGateways(t *testing.T) {
	// Intentionally NOT t.Parallel(): LLMProviderKinds() and GatewayKinds()
	// read the package-level registry, and another test that calls
	// RegisterTemporary in parallel could mutate the registry between the
	// two reads. Sequential execution is enough — the test is fast.
	llmKinds := LLMProviderKinds()
	gateway := GatewayKinds()
	inSet := func(s string, list []string) bool {
		for _, v := range list {
			if v == s {
				return true
			}
		}
		return false
	}
	for _, k := range gateway {
		if inSet(k, llmKinds) {
			t.Errorf("LLMProviderKinds leaked gateway kind %q: %v", k, llmKinds)
		}
	}
	mustHave := []string{KindClaudeCode, KindCodex}
	for _, k := range mustHave {
		if !inSet(k, llmKinds) {
			t.Errorf("LLMProviderKinds missing %q: %v", k, llmKinds)
		}
	}
	mustGateway := []string{KindOpenclawHTTP, KindHermesBot}
	for _, k := range mustGateway {
		if !inSet(k, gateway) {
			t.Errorf("GatewayKinds missing %q: %v", k, gateway)
		}
	}
}
