package team

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/nex-crm/wuphf/internal/provider"
)

func TestModelLabelIsParsedFromTheID(t *testing.T) {
	cases := []struct{ id, label, family string }{
		{"claude-opus-5-5[1m]", "Opus 5.5", "claude"},
		{"claude-fable-5-1", "Fable 5.1", "claude"},
		{"claude-sonnet-4-6", "Sonnet 4.6", "claude"},
		{"claude-opus-4-8", "Opus 4.8", "claude"},
		{"claude-haiku-5-5-20260301", "Haiku 5.5", "claude"},
		{"claude-3-5-sonnet-20241022", "Sonnet 3.5", "claude"},
		{"claude-opus-4", "Opus 4", "claude"},
		{"anthropic/claude-sonnet-5-5", "Sonnet 5.5", "claude"},
		{"gpt-6-astra", "GPT-6 Astra", "gpt"},
		{"gpt-5.5", "GPT-5.5", "gpt"},
		{"gpt-5-codex", "GPT-5 Codex", "gpt"},
		{"gpt-4o", "GPT-4o", "gpt"},
		{"o3", "o3", "gpt"},
		{"gemini-2.5-pro", "Gemini 2.5 Pro", "gemini"},
		{"qwen2.5-coder:32b", "qwen2.5-coder:32b", ""},
		{"a-model-with-a-very-long-identifier-indeed", "a-model-with-a-very-lon…", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		label, family := modelLabel(c.id)
		if label != c.label || family != c.family {
			t.Errorf("modelLabel(%q) = (%q, %q), want (%q, %q)", c.id, label, family, c.label, c.family)
		}
	}
}

func TestMemberRuntimeNamesTheToolForEveryKind(t *testing.T) {
	defaults := runtimeDefaults{
		Kind:   provider.KindCodex,
		Models: map[string]string{provider.KindClaudeCode: defaultClaudeModel, provider.KindCodex: "gpt-6-astra"},
	}
	cli := provider.ProviderBinding{Kind: provider.KindCLIAgent, CLIAgent: &provider.CLIAgentProviderBinding{Agent: "gemini"}}
	cases := []struct {
		name        string
		binding     provider.ProviderBinding
		observed    string
		harness     string
		harnessName string
		model       string
		source      string
	}{
		{"empty binding follows the install default", provider.ProviderBinding{}, "", provider.KindCodex, "Codex CLI", "gpt-6-astra", runtimeSourceDefault},
		{"bound tool without a model takes that tool's default", provider.ProviderBinding{Kind: provider.KindClaudeCode}, "", provider.KindClaudeCode, "Claude Code", defaultClaudeModel, runtimeSourceDefault},
		{"pinned model wins over the default", provider.ProviderBinding{Kind: provider.KindClaudeCode, Model: "claude-opus-5-5"}, "", provider.KindClaudeCode, "Claude Code", "claude-opus-5-5", runtimeSourceBinding},
		{"what the last turn ran on wins over the pin", provider.ProviderBinding{Kind: provider.KindClaudeCode, Model: "claude-opus-5-5"}, "claude-fable-5-1", provider.KindClaudeCode, "Claude Code", "claude-fable-5-1", runtimeSourceObserved},
		{"cli agent is named by its agent, with no model", cli, "", provider.KindCLIAgent, "Gemini CLI", "", ""},
		{"opencode with no default has no model", provider.ProviderBinding{Kind: provider.KindOpencode}, "", provider.KindOpencode, "Opencode", "", ""},
		{"ollama keeps its pinned model", provider.ProviderBinding{Kind: provider.KindOllama, Model: "qwen2.5-coder:32b"}, "", provider.KindOllama, "Ollama", "qwen2.5-coder:32b", runtimeSourceBinding},
		{"mlx-lm", provider.ProviderBinding{Kind: provider.KindMLXLM}, "", provider.KindMLXLM, "", "", ""},
		{"exo", provider.ProviderBinding{Kind: provider.KindExo}, "", provider.KindExo, "", "", ""},
		{"openclaw gateway", provider.ProviderBinding{Kind: provider.KindOpenclaw}, "", provider.KindOpenclaw, "OpenClaw", "", ""},
		{"openclaw http gateway", provider.ProviderBinding{Kind: provider.KindOpenclawHTTP}, "", provider.KindOpenclawHTTP, "OpenClaw", "", ""},
		{"hermes gateway", provider.ProviderBinding{Kind: provider.KindHermesBot}, "", provider.KindHermesBot, "Hermes", "", ""},
		{"slack", provider.ProviderBinding{Kind: provider.KindSlack}, "", provider.KindSlack, "Slack", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := memberRuntime(officeMember{Slug: "x", Provider: c.binding}, c.observed, defaults)
			if got.Harness != c.harness {
				t.Errorf("harness = %q, want %q", got.Harness, c.harness)
			}
			// The catalog owns display names for native kinds; assert only
			// where this test states one, but never accept an empty name.
			if c.harnessName != "" && got.HarnessName != c.harnessName {
				t.Errorf("harness name = %q, want %q", got.HarnessName, c.harnessName)
			}
			if got.HarnessName == "" {
				t.Errorf("harness name is empty for kind %q", c.harness)
			}
			if got.Model != c.model || got.Source != c.source {
				t.Errorf("model/source = (%q, %q), want (%q, %q)", got.Model, got.Source, c.model, c.source)
			}
			if (got.Model == "") != (got.ModelLabel == "") {
				t.Errorf("model %q and label %q must be set together", got.Model, got.ModelLabel)
			}
		})
	}
}

func TestRecordObservedModelIgnoresKindsAndBlanks(t *testing.T) {
	b := newTestBroker(t)
	b.RecordObservedModel("eng", "")
	b.RecordObservedModel("", "claude-opus-5-5")
	b.RecordObservedModel("eng", provider.KindOllama) // a runner reporting its kind
	if got := b.observedModels["eng"]; got != "" {
		t.Fatalf("observed model = %q, want none", got)
	}
	b.RecordObservedModel("eng", " claude-opus-5-5 ")
	if got := b.observedModels["eng"]; got != "claude-opus-5-5" {
		t.Fatalf("observed model = %q, want claude-opus-5-5", got)
	}
}

func TestOfficeMemberListCarriesTheRuntime(t *testing.T) {
	t.Setenv("WUPHF_LLM_PROVIDER", provider.KindClaudeCode)
	b := newTestBroker(t)
	b.mu.Lock()
	b.members = []officeMember{
		{Slug: "cos", Name: "Chief of Staff"},
		{Slug: "eng", Name: "Engineer", Provider: provider.ProviderBinding{Kind: provider.KindClaudeCode, Model: "claude-opus-5-5"}},
	}
	b.mu.Unlock()
	b.RecordBotUsage("eng", "claude-fable-5-1", provider.ClaudeUsage{})

	rec := httptest.NewRecorder()
	b.serveOfficeMemberList(rec)
	var body struct {
		Members []struct {
			Slug    string            `json:"slug"`
			Runtime memberRuntimeInfo `json:"runtime"`
		} `json:"members"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := map[string]memberRuntimeInfo{}
	for _, m := range body.Members {
		got[m.Slug] = m.Runtime
	}
	if r := got["cos"]; r.Harness != provider.KindClaudeCode || r.ModelLabel != "Sonnet 4.6" || r.Source != runtimeSourceDefault {
		t.Errorf("default-bound bot runtime = %+v", r)
	}
	if r := got["eng"]; r.ModelLabel != "Fable 5.1" || r.Family != "claude" || r.Source != runtimeSourceObserved {
		t.Errorf("bot that has run shows what it ran on, got %+v", r)
	}
}
