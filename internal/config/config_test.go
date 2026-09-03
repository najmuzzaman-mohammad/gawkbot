package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// withTempConfig redirects ConfigPath to a temp dir for the duration of f.
func withTempConfig(t *testing.T, f func(dir string)) {
	t.Helper()
	dir := t.TempDir()
	// Override UserHomeDir by pointing ConfigPath indirectly via HOME env var.
	orig := os.Getenv("HOME")
	t.Setenv("HOME", dir)
	defer os.Setenv("HOME", orig)
	f(dir)
}

func TestLoadMissingFileReturnsEmpty(t *testing.T) {
	withTempConfig(t, func(_ string) {
		cfg, err := Load()
		if err != nil {
			t.Fatalf("expected no error for missing file, got: %v", err)
		}
		if cfg.Email != "" || cfg.WorkspaceID != "" {
			t.Fatalf("expected empty config, got: %+v", cfg)
		}
	})
}

func TestIsAnalyticsEnabledDefaultsOnWhenUnset(t *testing.T) {
	var c Config
	if !c.IsAnalyticsTelemetryEnabled() {
		t.Error("telemetry should default ON when unset")
	}
	if !c.IsAnalyticsSessionRecordingEnabled() {
		t.Error("session recording should default ON when unset")
	}
}

func TestIsAnalyticsRespectsExplicitOptOut(t *testing.T) {
	no, yes := false, true
	c := Config{AnalyticsTelemetryEnabled: &no, AnalyticsSessionRecordingEnabled: &yes}
	if c.IsAnalyticsTelemetryEnabled() {
		t.Error("telemetry explicit false should be honored")
	}
	if !c.IsAnalyticsSessionRecordingEnabled() {
		t.Error("session recording explicit true should be honored")
	}
}

func TestAnalyticsConsentRoundtrips(t *testing.T) {
	withTempConfig(t, func(_ string) {
		no := false
		if err := Save(Config{AnalyticsTelemetryEnabled: &no}); err != nil {
			t.Fatalf("Save: %v", err)
		}
		got, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if got.AnalyticsTelemetryEnabled == nil || *got.AnalyticsTelemetryEnabled {
			t.Fatalf("telemetry opt-out did not round-trip: %+v", got.AnalyticsTelemetryEnabled)
		}
		// Recording was never set → nil → resolves ON.
		if got.AnalyticsSessionRecordingEnabled != nil {
			t.Errorf("expected recording unset, got %+v", got.AnalyticsSessionRecordingEnabled)
		}
		if !got.IsAnalyticsSessionRecordingEnabled() {
			t.Error("unset recording should resolve ON")
		}
	})
}

func TestResolvePostHogKeyAndHostFromEnv(t *testing.T) {
	t.Setenv("WUPHF_POSTHOG_KEY", "phc_test")
	t.Setenv("POSTHOG_KEY", "ignored")
	t.Setenv("WUPHF_POSTHOG_HOST", "https://eu.i.posthog.com")
	if got := ResolvePostHogKey(); got != "phc_test" {
		t.Errorf("key: WUPHF_POSTHOG_KEY should win, got %q", got)
	}
	if got := ResolvePostHogHost(); got != "https://eu.i.posthog.com" {
		t.Errorf("host: got %q", got)
	}
}

func TestResolvePostHogKeyFallsBackToBareEnv(t *testing.T) {
	t.Setenv("WUPHF_POSTHOG_KEY", "")
	t.Setenv("POSTHOG_KEY", "phc_bare")
	if got := ResolvePostHogKey(); got != "phc_bare" {
		t.Errorf("key fallback: got %q, want phc_bare", got)
	}
}

func TestRoundtrip(t *testing.T) {
	withTempConfig(t, func(_ string) {
		in := Config{
			MemoryBackend:      MemoryBackendGBrain,
			Email:              "user@example.com",
			WorkspaceID:        "ws-123",
			WorkspaceSlug:      "my-ws",
			LLMProvider:        "gemini",
			GeminiAPIKey:       "gemini-key",
			AnthropicAPIKey:    "anthropic-key",
			OpenAIAPIKey:       "openai-key",
			MinimaxAPIKey:      "minimax-key",
			Blueprint:          "niche-crm",
			DefaultFormat:      "json",
			DefaultTimeout:     30_000,
			DevURL:             "http://localhost:3000",
			CompanyName:        "Acme Corp",
			CompanyDescription: "AI-powered analytics",
			CompanyGoals:       "Ship MVP, get 10 customers",
			CompanySize:        "2-5",
			CompanyPriority:    "Launch landing page",
		}
		if err := Save(in); err != nil {
			t.Fatalf("Save failed: %v", err)
		}
		out, err := Load()
		if err != nil {
			t.Fatalf("Load failed: %v", err)
		}
		if !reflect.DeepEqual(out, in) {
			t.Fatalf("roundtrip mismatch:\n  got:  %+v\n  want: %+v", out, in)
		}
	})
}

func TestActiveBlueprintPrefersBlueprintField(t *testing.T) {
	cfg := Config{Blueprint: "template-blueprint", Pack: "legacy-pack"}
	if got := cfg.ActiveBlueprint(); got != "template-blueprint" {
		t.Fatalf("expected blueprint field to win, got %q", got)
	}
}

func TestSetActiveBlueprintDoesNotBackfillLegacyPack(t *testing.T) {
	cfg := Config{Pack: "legacy-pack"}
	cfg.SetActiveBlueprint("template-blueprint")
	if got := cfg.Blueprint; got != "template-blueprint" {
		t.Fatalf("expected preferred blueprint field to be set, got %q", got)
	}
	if got := cfg.Pack; got != "legacy-pack" {
		t.Fatalf("expected legacy pack field to remain unchanged, got %q", got)
	}
}

func TestActiveBlueprintFallsBackToPack(t *testing.T) {
	cfg := Config{Pack: "legacy-pack"}
	if got := cfg.ActiveBlueprint(); got != "legacy-pack" {
		t.Fatalf("expected pack fallback, got %q", got)
	}
}

func TestSaveCreatesParentDirs(t *testing.T) {
	withTempConfig(t, func(dir string) {
		if err := Save(Config{Email: "e@e.com"}); err != nil {
			t.Fatalf("Save failed: %v", err)
		}
		path := filepath.Join(dir, ".wuphf", "config.json")
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected config file at %s: %v", path, err)
		}
	})
}

func TestSaveWritesValidJSON(t *testing.T) {
	withTempConfig(t, func(dir string) {
		if err := Save(Config{Email: "e@e.com"}); err != nil {
			t.Fatalf("Save: %v", err)
		}
		raw, _ := os.ReadFile(filepath.Join(dir, ".wuphf", "config.json"))
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("invalid JSON: %v\n%s", err, raw)
		}
		if m["email"] != "e@e.com" {
			t.Fatalf("unexpected email: %v", m["email"])
		}
	})
}

func setGBrainOllamaEmbedder(t *testing.T, available bool) {
	t.Helper()
	prev := gbrainOllamaEmbedderAvailable
	gbrainOllamaEmbedderAvailable = func() bool { return available }
	t.Cleanup(func() { gbrainOllamaEmbedderAvailable = prev })
}

// clearGBrainReadiness forces gbrainBackendReady() to report false within a
// test: an empty PATH (no gbrain binary), no provider keys, and no local ollama
// embedder. Use it when a test wants the implicit default to fall back to
// markdown deterministically, regardless of the host environment.
func clearGBrainReadiness(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
	t.Setenv("WUPHF_GBRAIN_COMMAND", "")
	t.Setenv("WUPHF_OPENAI_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("WUPHF_ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	setGBrainOllamaEmbedder(t, false)
}

// fakeGBrainOnPath puts an executable named "gbrain" on PATH so
// gbrainBackendReady() sees the binary as installed.
func fakeGBrainOnPath(t *testing.T) {
	t.Helper()
	binDir := t.TempDir()
	bin := filepath.Join(binDir, "gbrain")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("create fake gbrain: %v", err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestResolveMemoryBackendDefaultsToMarkdownWhenGBrainNotReady(t *testing.T) {
	// Empty config + no env override, gbrain unavailable: a fresh OSS clone
	// without gbrain must still boot on the git-native markdown wiki. This is
	// the graceful-fallback half of the gbrain-default flip.
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", "")
		clearGBrainReadiness(t)
		if got := ResolveMemoryBackend(""); got != MemoryBackendMarkdown {
			t.Fatalf("expected markdown fallback when gbrain not ready, got %q", got)
		}
	})
}

func TestResolveMemoryBackendDefaultsToGBrainWhenReady(t *testing.T) {
	// gbrain is the strong default: with the binary installed and a provider
	// key configured, an empty config resolves to gbrain rather than markdown.
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", "")
		t.Setenv("WUPHF_OPENAI_API_KEY", "sk-test-openai")
		t.Setenv("WUPHF_ANTHROPIC_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "")
		fakeGBrainOnPath(t)
		if got := ResolveMemoryBackend(""); got != MemoryBackendGBrain {
			t.Fatalf("expected gbrain default when ready, got %q", got)
		}
	})
}

func TestResolveMemoryBackendExplicitCommandMissingDoesNotFallBack(t *testing.T) {
	// An explicit WUPHF_GBRAIN_COMMAND that no longer resolves (e.g. a reaped
	// wrapper script) must not silently fall back to the PATH gbrain: the
	// explicit command usually re-homes the brain, and the PATH binary points
	// at the user-global one. Not installed → markdown default.
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", "")
		t.Setenv("WUPHF_OPENAI_API_KEY", "sk-test-openai")
		t.Setenv("WUPHF_ANTHROPIC_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "")
		fakeGBrainOnPath(t)
		t.Setenv("WUPHF_GBRAIN_COMMAND", filepath.Join(t.TempDir(), "missing-wrapper.sh"))
		if got := ResolveMemoryBackend(""); got != MemoryBackendMarkdown {
			t.Fatalf("expected markdown when explicit gbrain command is missing, got %q", got)
		}
	})
}

func TestResolveMemoryBackendDefaultsToMarkdownWhenGBrainInstalledButNoEmbedder(t *testing.T) {
	// Installed but with no embedding provider (no OpenAI key, no local ollama
	// embedder) gbrain is not "ready": semantic search cannot run, and a
	// keyword-only gbrain is ~equivalent to markdown, so the default falls back
	// to markdown rather than selecting a backend that adds nothing.
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", "")
		t.Setenv("WUPHF_OPENAI_API_KEY", "")
		t.Setenv("OPENAI_API_KEY", "")
		t.Setenv("WUPHF_ANTHROPIC_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "")
		fakeGBrainOnPath(t)
		setGBrainOllamaEmbedder(t, false)
		if got := ResolveMemoryBackend(""); got != MemoryBackendMarkdown {
			t.Fatalf("expected markdown when gbrain installed but no embedder, got %q", got)
		}
	})
}

func TestResolveMemoryBackendDefaultsToMarkdownWhenAnthropicOnly(t *testing.T) {
	// An Anthropic key alone does not make gbrain ready: Anthropic has no
	// embeddings API. Without OpenAI or a local ollama embedder, the implicit
	// default stays on the markdown wiki.
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", "")
		t.Setenv("WUPHF_OPENAI_API_KEY", "")
		t.Setenv("OPENAI_API_KEY", "")
		t.Setenv("WUPHF_ANTHROPIC_API_KEY", "sk-ant-test")
		fakeGBrainOnPath(t)
		setGBrainOllamaEmbedder(t, false)
		if got := ResolveMemoryBackend(""); got != MemoryBackendMarkdown {
			t.Fatalf("expected markdown when only an Anthropic key is set, got %q", got)
		}
	})
}

func TestResolveMemoryBackendDefaultsToGBrainWithLocalOllamaEmbedder(t *testing.T) {
	// No cloud key, but gbrain is installed and a local ollama embedding model
	// is pulled: gbrain can do semantic retrieval entirely on-device, so it is
	// the strong default even without an OpenAI key.
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", "")
		t.Setenv("WUPHF_OPENAI_API_KEY", "")
		t.Setenv("OPENAI_API_KEY", "")
		t.Setenv("WUPHF_ANTHROPIC_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "")
		fakeGBrainOnPath(t)
		setGBrainOllamaEmbedder(t, true)
		if got := ResolveMemoryBackend(""); got != MemoryBackendGBrain {
			t.Fatalf("expected gbrain default with local ollama embedder, got %q", got)
		}
	})
}

func TestResolveMemoryBackendExplicitMarkdownOverridesGBrainDefault(t *testing.T) {
	// An explicit selection bypasses the gbrain-ready probe entirely, even
	// when gbrain would otherwise be the default.
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", MemoryBackendMarkdown)
		t.Setenv("WUPHF_OPENAI_API_KEY", "sk-test-openai")
		fakeGBrainOnPath(t)
		if got := ResolveMemoryBackend(""); got != MemoryBackendMarkdown {
			t.Fatalf("expected explicit markdown to win over gbrain default, got %q", got)
		}
	})
}

func TestResolveOneIdentityFallsBackToEmail(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{Email: "founder@example.com"})
		if got := ResolveOneIdentity(); got != "founder@example.com" {
			t.Fatalf("expected config email identity, got %q", got)
		}
		if got := ResolveOneIdentityType(); got != "user" {
			t.Fatalf("expected default identity type user, got %q", got)
		}
	})
}

func TestOneSetupSummaryManagedPending(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{Email: "ops@example.com"})
		got := OneSetupSummary()
		if got != "handled by One (ops@example.com), credential pending" {
			t.Fatalf("unexpected setup summary %q", got)
		}
	})
}

func TestResolveComposioAPIKeyFallsBackToConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{ComposioAPIKey: "cmp-key"})
		if got := ResolveComposioAPIKey(); got != "cmp-key" {
			t.Fatalf("expected composio key from config, got %q", got)
		}
	})
}

func TestIsComposioConfigured(t *testing.T) {
	t.Run("project ak_ key", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			_ = Save(Config{ComposioAPIKey: "ak_proj"})
			if !IsComposioConfigured() {
				t.Fatal("expected configured with a project key")
			}
		})
	})
	t.Run("user key + org", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			_ = Save(Config{ComposioUserAPIKey: "uak_x", ComposioOrgID: "ok_1"})
			if !IsComposioConfigured() {
				t.Fatal("expected configured with the user-key pair")
			}
			if got := ResolveComposioUserAPIKey(); got != "uak_x" {
				t.Fatalf("user key = %q", got)
			}
			if got := ResolveComposioOrgID(); got != "ok_1" {
				t.Fatalf("org id = %q", got)
			}
		})
	})
	t.Run("user key without org is not enough", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			_ = Save(Config{ComposioUserAPIKey: "uak_x"})
			if IsComposioConfigured() {
				t.Fatal("user key without org must not count as configured")
			}
		})
	})
	t.Run("nothing", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			_ = Save(Config{})
			if IsComposioConfigured() {
				t.Fatal("empty config must not be configured")
			}
		})
	})
}

func TestResolveComposioUserID(t *testing.T) {
	// Clear both env overrides so an env-contaminated runner can't leak into
	// the config/default-fallback subtests.
	clearEnv := func(t *testing.T) {
		t.Helper()
		t.Setenv("WUPHF_COMPOSIO_USER_ID", "")
		t.Setenv("COMPOSIO_USER_ID", "")
	}
	t.Run("prefers email", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			clearEnv(t)
			_ = Save(Config{Email: "owner@example.com", WorkspaceSlug: "acme"})
			if got := ResolveComposioUserID(); got != "owner@example.com" {
				t.Fatalf("got %q", got)
			}
		})
	})
	t.Run("falls back to workspace slug", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			clearEnv(t)
			_ = Save(Config{WorkspaceSlug: "acme"})
			if got := ResolveComposioUserID(); got != "acme" {
				t.Fatalf("got %q", got)
			}
		})
	})
	t.Run("falls back to workspace id", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			clearEnv(t)
			_ = Save(Config{WorkspaceID: "ws_123"})
			if got := ResolveComposioUserID(); got != "ws_123" {
				t.Fatalf("got %q", got)
			}
		})
	})
	t.Run("never empty so a signed-in office can browse", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			clearEnv(t)
			_ = Save(Config{})
			if got := ResolveComposioUserID(); got != "default" {
				t.Fatalf("expected the default identity, got %q", got)
			}
		})
	})
	t.Run("WUPHF env override wins", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			clearEnv(t)
			t.Setenv("WUPHF_COMPOSIO_USER_ID", "u_env")
			_ = Save(Config{Email: "owner@example.com"})
			if got := ResolveComposioUserID(); got != "u_env" {
				t.Fatalf("got %q", got)
			}
		})
	})
	t.Run("COMPOSIO_USER_ID env override wins over config", func(t *testing.T) {
		withTempConfig(t, func(_ string) {
			clearEnv(t)
			t.Setenv("COMPOSIO_USER_ID", "u_compat")
			_ = Save(Config{Email: "owner@example.com"})
			if got := ResolveComposioUserID(); got != "u_compat" {
				t.Fatalf("got %q", got)
			}
		})
	})
}

func TestResolveGeminiAPIKeyEnvOverride(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_GEMINI_API_KEY", "wuphf-gemini")
		_ = Save(Config{GeminiAPIKey: "file-gemini"})
		if got := ResolveGeminiAPIKey(); got != "wuphf-gemini" {
			t.Fatalf("expected WUPHF env override, got %q", got)
		}
	})
}

func TestResolveGeminiAPIKeyFallbackEnv(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("GEMINI_API_KEY", "generic-gemini")
		if got := ResolveGeminiAPIKey(); got != "generic-gemini" {
			t.Fatalf("expected GEMINI_API_KEY fallback, got %q", got)
		}
	})
}

func TestResolveGeminiAPIKeyConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{GeminiAPIKey: "cfg-gemini"})
		if got := ResolveGeminiAPIKey(); got != "cfg-gemini" {
			t.Fatalf("expected config fallback, got %q", got)
		}
	})
}

func TestResolveAnthropicAPIKeyEnvOverride(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_ANTHROPIC_API_KEY", "wuphf-anthropic")
		_ = Save(Config{AnthropicAPIKey: "file-anthropic"})
		if got := ResolveAnthropicAPIKey(); got != "wuphf-anthropic" {
			t.Fatalf("expected WUPHF env override, got %q", got)
		}
	})
}

func TestResolveAnthropicAPIKeyFallbackEnv(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("ANTHROPIC_API_KEY", "generic-anthropic")
		if got := ResolveAnthropicAPIKey(); got != "generic-anthropic" {
			t.Fatalf("expected ANTHROPIC_API_KEY fallback, got %q", got)
		}
	})
}

func TestResolveAnthropicAPIKeyConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{AnthropicAPIKey: "cfg-anthropic"})
		if got := ResolveAnthropicAPIKey(); got != "cfg-anthropic" {
			t.Fatalf("expected config fallback, got %q", got)
		}
	})
}

func TestResolveOpenAIAPIKeyEnvOverride(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_OPENAI_API_KEY", "wuphf-openai")
		_ = Save(Config{OpenAIAPIKey: "file-openai"})
		if got := ResolveOpenAIAPIKey(); got != "wuphf-openai" {
			t.Fatalf("expected WUPHF env override, got %q", got)
		}
	})
}

func TestResolveOpenAIAPIKeyFallbackEnv(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("OPENAI_API_KEY", "generic-openai")
		if got := ResolveOpenAIAPIKey(); got != "generic-openai" {
			t.Fatalf("expected OPENAI_API_KEY fallback, got %q", got)
		}
	})
}

func TestResolveOpenAIAPIKeyConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{OpenAIAPIKey: "cfg-openai"})
		if got := ResolveOpenAIAPIKey(); got != "cfg-openai" {
			t.Fatalf("expected config fallback, got %q", got)
		}
	})
}

func TestResolveMinimaxAPIKeyEnvOverride(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MINIMAX_API_KEY", "wuphf-minimax")
		_ = Save(Config{MinimaxAPIKey: "file-minimax"})
		if got := ResolveMinimaxAPIKey(); got != "wuphf-minimax" {
			t.Fatalf("expected WUPHF env override, got %q", got)
		}
	})
}

func TestResolveMinimaxAPIKeyFallbackEnv(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("MINIMAX_API_KEY", "generic-minimax")
		if got := ResolveMinimaxAPIKey(); got != "generic-minimax" {
			t.Fatalf("expected MINIMAX_API_KEY fallback, got %q", got)
		}
	})
}

func TestResolveMinimaxAPIKeyConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{MinimaxAPIKey: "cfg-minimax"})
		if got := ResolveMinimaxAPIKey(); got != "cfg-minimax" {
			t.Fatalf("expected config fallback, got %q", got)
		}
	})
}

func TestCompanyContextBlockFull(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{
			CompanyName:        "Acme Corp",
			CompanyDescription: "AI analytics for e-commerce",
			CompanyGoals:       "Ship MVP, get 10 customers",
			CompanyPriority:    "Launch landing page",
		})
		block := CompanyContextBlock()
		if block == "" {
			t.Fatal("expected non-empty company context block")
		}
		for _, want := range []string{"Acme Corp", "AI analytics", "Ship MVP", "Launch landing page"} {
			if !strings.Contains(block, want) {
				t.Errorf("expected block to contain %q, got:\n%s", want, block)
			}
		}
	})
}

func TestCompanyContextBlockEmpty(t *testing.T) {
	withTempConfig(t, func(_ string) {
		block := CompanyContextBlock()
		if block != "" {
			t.Fatalf("expected empty block when no company name, got: %q", block)
		}
	})
}

func TestCompanyContextBlockNameOnly(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{CompanyName: "Solo Inc"})
		block := CompanyContextBlock()
		if block == "" {
			t.Fatal("expected non-empty block with name only")
		}
		if !strings.Contains(block, "Solo Inc") {
			t.Errorf("expected block to contain company name")
		}
		if strings.Contains(block, "Current goals") {
			t.Errorf("should not contain goals when empty")
		}
	})
}

func TestResolveActionProviderDefaultsToAuto(t *testing.T) {
	withTempConfig(t, func(_ string) {
		if got := ResolveActionProvider(); got != "auto" {
			t.Fatalf("expected auto provider, got %q", got)
		}
	})
}

func TestResolveActionProviderUsesConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{ActionProvider: "composio"})
		if got := ResolveActionProvider(); got != "composio" {
			t.Fatalf("expected composio provider, got %q", got)
		}
	})
}

func TestResolveLLMProviderDefaultsToClaude(t *testing.T) {
	withTempConfig(t, func(_ string) {
		if got := ResolveLLMProvider(""); got != "claude-code" {
			t.Fatalf("expected claude-code default, got %q", got)
		}
	})
}

func TestResolveLLMProviderUsesEnvOverride(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_LLM_PROVIDER", "codex")
		if got := ResolveLLMProvider(""); got != "codex" {
			t.Fatalf("expected codex env override, got %q", got)
		}
	})
}

func TestResolveLLMProviderNormalizesUnsupportedConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{LLMProvider: "gemini"})
		if got := ResolveLLMProvider(""); got != "claude-code" {
			t.Fatalf("expected unsupported provider to normalize to claude-code, got %q", got)
		}
	})
}

func TestResolveLLMProviderAcceptsOpencode(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_LLM_PROVIDER", "opencode")
		if got := ResolveLLMProvider(""); got != "opencode" {
			t.Fatalf("expected opencode env override, got %q", got)
		}
	})
}

func TestResolveLLMProviderOpencodeFromConfig(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{LLMProvider: "opencode"})
		if got := ResolveLLMProvider(""); got != "opencode" {
			t.Fatalf("expected opencode from config, got %q", got)
		}
	})
}

func TestResolveOpencodeModelEnvOverride(t *testing.T) {
	t.Setenv("WUPHF_OPENCODE_MODEL", "qwen3.6:35b-a3b")
	if got := ResolveOpencodeModel(); got != "qwen3.6:35b-a3b" {
		t.Fatalf("expected WUPHF_OPENCODE_MODEL override, got %q", got)
	}
}

func TestResolveOpencodeModelFallsBackToOpencodeEnv(t *testing.T) {
	t.Setenv("WUPHF_OPENCODE_MODEL", "")
	t.Setenv("OPENCODE_MODEL", "llama3.3")
	if got := ResolveOpencodeModel(); got != "llama3.3" {
		t.Fatalf("expected OPENCODE_MODEL fallback, got %q", got)
	}
}

func TestResolveCodexModelUsesEnvOverride(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_CODEX_MODEL", "gpt-5.4")
		if got := ResolveCodexModel(""); got != "gpt-5.4" {
			t.Fatalf("expected env codex model, got %q", got)
		}
	})
}

func TestResolveCodexModelPrefersNearestProjectConfig(t *testing.T) {
	withTempConfig(t, func(dir string) {
		homeConfigDir := filepath.Join(dir, ".codex")
		if err := os.MkdirAll(homeConfigDir, 0o755); err != nil {
			t.Fatalf("mkdir home codex dir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(homeConfigDir, "config.toml"), []byte("model = \"gpt-5.4\"\n"), 0o644); err != nil {
			t.Fatalf("write home config: %v", err)
		}

		projectRoot := filepath.Join(dir, "repo")
		projectConfigDir := filepath.Join(projectRoot, ".codex")
		if err := os.MkdirAll(projectConfigDir, 0o755); err != nil {
			t.Fatalf("mkdir project codex dir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(projectConfigDir, "config.toml"), []byte("model = \"gpt-5.4-mini\"\n"), 0o644); err != nil {
			t.Fatalf("write project config: %v", err)
		}

		nested := filepath.Join(projectRoot, "nested", "deeper")
		if err := os.MkdirAll(nested, 0o755); err != nil {
			t.Fatalf("mkdir nested dir: %v", err)
		}

		if got := ResolveCodexModel(nested); got != "gpt-5.4-mini" {
			t.Fatalf("expected nearest project codex model, got %q", got)
		}
	})
}

func TestResolveFormatFlag(t *testing.T) {
	withTempConfig(t, func(_ string) {
		if got := ResolveFormat("json"); got != "json" {
			t.Fatalf("expected json, got: %s", got)
		}
	})
}

func TestResolveFormatConfigDefault(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{DefaultFormat: "json"})
		if got := ResolveFormat(""); got != "json" {
			t.Fatalf("expected json from config, got: %s", got)
		}
	})
}

func TestResolveFormatFallback(t *testing.T) {
	withTempConfig(t, func(_ string) {
		if got := ResolveFormat(""); got != "text" {
			t.Fatalf("expected text default, got: %s", got)
		}
	})
}

func TestResolveTimeoutFlag(t *testing.T) {
	withTempConfig(t, func(_ string) {
		if got := ResolveTimeout("5000"); got != 5000 {
			t.Fatalf("expected 5000, got: %d", got)
		}
	})
}

func TestResolveTimeoutConfigDefault(t *testing.T) {
	withTempConfig(t, func(_ string) {
		_ = Save(Config{DefaultTimeout: 60_000})
		if got := ResolveTimeout(""); got != 60_000 {
			t.Fatalf("expected 60000, got: %d", got)
		}
	})
}

func TestResolveTimeoutFallback(t *testing.T) {
	withTempConfig(t, func(_ string) {
		if got := ResolveTimeout(""); got != 120_000 {
			t.Fatalf("expected 120000, got: %d", got)
		}
	})
}

func TestOpenclawConfigRoundTrip(t *testing.T) {
	withTempConfig(t, func(_ string) {
		want := Config{
			OpenclawGatewayURL: "ws://127.0.0.1:18789",
			OpenclawToken:      "secret-token",
			OpenclawBridges: []OpenclawBridgeBinding{
				{SessionKey: "agent:main:main", Slug: "openclaw-ops", DisplayName: "Ops Bot"},
			},
		}
		if err := Save(want); err != nil {
			t.Fatalf("Save: %v", err)
		}
		got, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if got.OpenclawGatewayURL != want.OpenclawGatewayURL ||
			got.OpenclawToken != want.OpenclawToken ||
			len(got.OpenclawBridges) != 1 ||
			got.OpenclawBridges[0].Slug != "openclaw-ops" {
			t.Fatalf("round-trip mismatch: got %+v want %+v", got, want)
		}
	})
}

func TestResolveOpenclawTokenEnvWins(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_OPENCLAW_TOKEN", "env-token")
		t.Setenv("OPENCLAW_GATEWAY_TOKEN", "gateway-token")
		if got := ResolveOpenclawToken(); got != "env-token" {
			t.Fatalf("expected env-token, got %q", got)
		}
	})
}

func TestResolveOpenclawTokenAcceptsGatewayEnv(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("OPENCLAW_GATEWAY_TOKEN", "gateway-token")
		if got := ResolveOpenclawToken(); got != "gateway-token" {
			t.Fatalf("expected gateway-token, got %q", got)
		}
	})
}

// TestResolveMemoryBackendDegradesRetiredNexBackend pins the persisted-state
// half of the Nex removal: a config.json still carrying `memory_backend: "nex"`
// is on real users' disks. Loading it must land on a working backend, not error
// and not leave the office with no memory at all.
func TestResolveMemoryBackendDegradesRetiredNexBackend(t *testing.T) {
	withTempConfig(t, func(_ string) {
		t.Setenv("WUPHF_MEMORY_BACKEND", "")
		clearGBrainReadiness(t)
		if err := Save(Config{MemoryBackend: "nex"}); err != nil {
			t.Fatalf("save config: %v", err)
		}
		got := ResolveMemoryBackend("")
		if got != MemoryBackendMarkdown {
			t.Fatalf("retired nex backend should degrade to the markdown default, got %q", got)
		}
	})
}

// TestNormalizeMemoryBackendRejectsRetiredNex documents that "nex" is no longer
// a selectable backend: it normalizes away like any unknown value, which is what
// makes the degradation above fall through to the implicit default.
func TestNormalizeMemoryBackendRejectsRetiredNex(t *testing.T) {
	if got := NormalizeMemoryBackend("nex"); got != "" {
		t.Fatalf("NormalizeMemoryBackend(\"nex\") = %q, want \"\"", got)
	}
}
