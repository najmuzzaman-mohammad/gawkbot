package team

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/computer/box"
	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/provider"
)

func (b *Broker) handleCompany(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg, err := config.Load()
		if err != nil {
			http.Error(w, "config load failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name":        cfg.CompanyName,
			"description": cfg.CompanyDescription,
			"goals":       cfg.CompanyGoals,
			"size":        cfg.CompanySize,
			"priority":    cfg.CompanyPriority,
		})
	case http.MethodPost:
		// /company and /config write the same file; share the same lock so
		// a concurrent /config POST cannot interleave a partial read here
		// with a Save and lose fields.
		b.configMu.Lock()
		defer b.configMu.Unlock()
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Goals       string `json:"goals"`
			Size        string `json:"size"`
			Priority    string `json:"priority"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		cfg, err := config.Load()
		if err != nil {
			// Refuse to proceed: writing back a zero-value cfg with our
			// fields layered on would clobber whatever else lived in the
			// file under a transient read failure.
			http.Error(w, "config load failed", http.StatusInternalServerError)
			return
		}
		if body.Name != "" {
			cfg.CompanyName = strings.TrimSpace(body.Name)
		}
		if body.Description != "" {
			cfg.CompanyDescription = strings.TrimSpace(body.Description)
		}
		if body.Goals != "" {
			cfg.CompanyGoals = strings.TrimSpace(body.Goals)
		}
		if body.Size != "" {
			cfg.CompanySize = strings.TrimSpace(body.Size)
		}
		if body.Priority != "" {
			cfg.CompanyPriority = strings.TrimSpace(body.Priority)
		}
		if err := config.Save(cfg); err != nil {
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// validateProviderEndpointURL gates user-supplied base URLs persisted
// to ~/.wuphf/config.json so a locally-authenticated client can't
// pivot future bot turns to attacker-controlled targets via
// schemes our HTTP client doesn't service (or persist URLs that
// would surprise users on next launch). Allowed: http://… and
// https://… with a non-empty host. Rejected: file://, gopher://,
// unix://, schemeless paths, hostless URLs, raw IPs without scheme,
// userinfo-only URLs, etc.
//
// Loopback hosts are allowed — wuphf's whole point is local-LLM
// pointing at 127.0.0.1, and the runtime probe code already gates
// reachability scans on isLoopbackBaseURL elsewhere. The threat we
// care about here is "URL the bot runner will later POST a
// system prompt + conversation to," which is governed by scheme +
// host, not by loopback-vs-public.
func validateProviderEndpointURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("malformed URL: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		// ok
	case "":
		return fmt.Errorf("missing scheme (must be http or https)")
	default:
		return fmt.Errorf("unsupported scheme %q (must be http or https)", u.Scheme)
	}
	// Use Hostname() not Host: url.Parse("http://:8080") yields
	// Host=":8080" but Hostname()="", so checking Host would let a
	// port-only URL through and persist a hostless endpoint that
	// fails later at request time.
	if strings.TrimSpace(u.Hostname()) == "" {
		return fmt.Errorf("missing host")
	}
	return nil
}

// handleConfig exposes GET/POST over ~/.wuphf/config.json for the web UI
// settings page and onboarding wizard. All POST fields are optional; clients
// can update one without touching the others. Secret fields (API keys, tokens)
// are returned as boolean flags on GET and accepted as plain values on POST.
//
// TODO(broker-split): this 400-line handler is ripe for a parser/applier
// split — see the broker.go decomposition plan. Currently a faithful
// monolithic relocation; the validation, secret-mask, and persistence
// concerns should be isolated in a follow-up pass once the slice series
// has soaked.
func (b *Broker) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg, err := config.Load()
		if err != nil {
			http.Error(w, "failed to read config", http.StatusInternalServerError)
			return
		}
		envLLMProvider := strings.TrimSpace(os.Getenv("WUPHF_LLM_PROVIDER"))
		configLLMProvider := strings.TrimSpace(cfg.LLMProvider)
		llmProviderConfigured := (envLLMProvider != "" && config.IsLLMProviderKindAllowed(envLLMProvider)) ||
			(configLLMProvider != "" && config.IsLLMProviderKindAllowed(configLLMProvider))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			// Runtime
			"llm_provider":            config.ResolveLLMProvider(""),
			"llm_provider_configured": llmProviderConfigured,
			"llm_provider_priority":   cfg.LLMProviderPriority,
			// llm_provider_kinds is the non-gateway subset of the registered
			// provider runtimes — the safe set to render in any UI runtime
			// picker (Settings default-runtime, BotProfilePanel runtime
			// section, BotWizard provider field). Gateway kinds (openclaw,
			// hermes-bot) are excluded; the Integrations app surfaces them.
			"llm_provider_kinds": provider.LLMProviderKinds(),
			// gateway_kinds is the inverse — registered kinds that are
			// gateway-controlled. Consumed by the Integrations app to
			// enumerate which gateways are compiled in and connectable.
			"gateway_kinds":         provider.GatewayKinds(),
			"provider_endpoints":    cfg.ProviderEndpoints,
			"memory_backend":        config.ResolveMemoryBackend(""),
			"action_provider":       config.ResolveActionProvider(),
			"team_lead_slug":        cfg.TeamLeadSlug,
			"max_concurrent_agents": cfg.MaxConcurrent,
			"default_format":        config.ResolveFormat(""),
			"default_timeout":       config.ResolveTimeout(""),
			"blueprint":             cfg.ActiveBlueprint(),
			// Workspace
			"email":          cfg.Email,
			"workspace_id":   cfg.WorkspaceID,
			"workspace_slug": cfg.WorkspaceSlug,
			// Company
			"company_name":        cfg.CompanyName,
			"company_description": cfg.CompanyDescription,
			"company_goals":       cfg.CompanyGoals,
			"company_size":        cfg.CompanySize,
			"company_priority":    cfg.CompanyPriority,
			// Polling intervals
			"insights_poll_minutes":  config.ResolveInsightsPollInterval(),
			"task_follow_up_minutes": config.ResolveTaskFollowUpInterval(),
			"task_reminder_minutes":  config.ResolveTaskReminderInterval(),
			"task_recheck_minutes":   config.ResolveTaskRecheckInterval(),
			// Integrations — secret fields as booleans
			"openai_key_set":       config.ResolveOpenAIAPIKey() != "",
			"realtime_model":       config.ResolveRealtimeModel(),
			"anthropic_key_set":    config.ResolveAnthropicAPIKey() != "",
			"gemini_key_set":       config.ResolveGeminiAPIKey() != "",
			"minimax_key_set":      config.ResolveMinimaxAPIKey() != "",
			"one_key_set":          config.ResolveOneSecret() != "",
			"composio_key_set":     config.IsComposioConfigured(),
			"box_key_set":          config.ResolveBoxAPIKey() != "",
			"telegram_token_set":   config.ResolveTelegramBotToken() != "",
			"openclaw_token_set":   config.ResolveOpenclawToken() != "",
			"openclaw_gateway_url": config.ResolveOpenclawGatewayURL(),
			// Product analytics consent (PostHog). The two channels are
			// independently toggleable; analytics_configured reports whether
			// the backend injects a key (the frontend ORs this with its own
			// build-time key to decide whether the toggles are meaningful).
			"analytics_telemetry_enabled":         cfg.IsAnalyticsTelemetryEnabled(),
			"analytics_session_recording_enabled": cfg.IsAnalyticsSessionRecordingEnabled(),
			"analytics_configured":                config.ResolvePostHogKey() != "",
			// Config file path (informational)
			"config_path": config.ConfigPath(),
		})
	case http.MethodPost:
		// Serialize POST reads/writes; config.Save is not atomic against
		// concurrent writers and two parallel calls can corrupt the file.
		b.configMu.Lock()
		defer b.configMu.Unlock()
		var body struct {
			LLMProvider         *string   `json:"llm_provider,omitempty"`
			LLMProviderPriority *[]string `json:"llm_provider_priority,omitempty"`
			MemoryBackend       *string   `json:"memory_backend,omitempty"`
			ActionProvider      *string   `json:"action_provider,omitempty"`
			TeamLeadSlug        *string   `json:"team_lead_slug,omitempty"`
			MaxConcurrent       *int      `json:"max_concurrent_agents,omitempty"`
			DefaultFormat       *string   `json:"default_format,omitempty"`
			DefaultTimeout      *int      `json:"default_timeout,omitempty"`
			Blueprint           *string   `json:"blueprint,omitempty"`
			Email               *string   `json:"email,omitempty"`
			DevURL              *string   `json:"dev_url,omitempty"`
			CompanyName         *string   `json:"company_name,omitempty"`
			CompanyDesc         *string   `json:"company_description,omitempty"`
			CompanyGoals        *string   `json:"company_goals,omitempty"`
			CompanySize         *string   `json:"company_size,omitempty"`
			CompanyPriority     *string   `json:"company_priority,omitempty"`
			InsightsPoll        *int      `json:"insights_poll_minutes,omitempty"`
			TaskFollowUp        *int      `json:"task_follow_up_minutes,omitempty"`
			TaskReminder        *int      `json:"task_reminder_minutes,omitempty"`
			TaskRecheck         *int      `json:"task_recheck_minutes,omitempty"`
			// RealtimeModel is a plain model identifier, not a secret (it is
			// returned verbatim in the GET response), so it sits outside the
			// secret block below.
			RealtimeModel *string `json:"realtime_model,omitempty"`
			// Secret fields
			APIKey          *string `json:"api_key,omitempty"`
			OpenAIAPIKey    *string `json:"openai_api_key,omitempty"`
			AnthropicAPIKey *string `json:"anthropic_api_key,omitempty"`
			GeminiAPIKey    *string `json:"gemini_api_key,omitempty"`
			MinimaxAPIKey   *string `json:"minimax_api_key,omitempty"`
			OneAPIKey       *string `json:"one_api_key,omitempty"`
			ComposioAPIKey  *string `json:"composio_api_key,omitempty"`
			BoxAPIKey       *string `json:"box_api_key,omitempty"`
			TelegramToken   *string `json:"telegram_bot_token,omitempty"`
			OpenclawToken   *string `json:"openclaw_token,omitempty"`
			OpenclawGateway *string `json:"openclaw_gateway_url,omitempty"`
			// Product analytics consent toggles. Pointer => nil means "not
			// sent, leave alone"; an explicit true/false round-trips.
			AnalyticsTelemetry        *bool `json:"analytics_telemetry_enabled,omitempty"`
			AnalyticsSessionRecording *bool `json:"analytics_session_recording_enabled,omitempty"`
			// ProviderEndpoints is a partial-update map: keys present in
			// the payload replace the corresponding entry; absent keys are
			// preserved. Pass an empty value (`{"base_url":"","model":""}`)
			// to clear a kind back to its compile-time defaults.
			ProviderEndpoints *map[string]config.ProviderEndpoint `json:"provider_endpoints,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		// Validate enum fields before touching config. The "global LLM
		// provider" surface (llm_provider, llm_provider_priority, and
		// the provider_endpoints map keys) must use
		// config.IsLLMProviderKindAllowed — provider.ValidateKind is
		// broader and accepts member-only kinds like openclaw that the
		// runtime launcher can't dispatch as a global default. Per-
		// member binding kinds keep ValidateKind below.
		//
		// Nil pointer vs empty string: a nil body field means "the
		// client didn't send it, leave the saved value alone"; an
		// explicit empty string means "clear my override and fall back
		// to the install default". Both must round-trip.
		var (
			llmProvider    string
			llmProviderSet bool
		)
		if body.LLMProvider != nil {
			llmProviderSet = true
			llmProvider = strings.TrimSpace(strings.ToLower(*body.LLMProvider))
			if llmProvider != "" && !config.IsLLMProviderKindAllowed(llmProvider) {
				http.Error(w, "unsupported llm_provider "+strconv.Quote(llmProvider)+
					" (allowed: "+strings.Join(config.AllowedLLMProviderKinds(), ", ")+")",
					http.StatusBadRequest)
				return
			}
		}
		var providerPriority []string
		if body.LLMProviderPriority != nil {
			// Normalize + validate each entry. Unknown entries are rejected so
			// the stored list only contains provider ids the resolver knows how
			// to dispatch. Empty list is accepted (means "clear").
			seen := make(map[string]bool, len(*body.LLMProviderPriority))
			for _, raw := range *body.LLMProviderPriority {
				id := strings.TrimSpace(strings.ToLower(raw))
				if id == "" {
					continue
				}
				if !config.IsLLMProviderKindAllowed(id) {
					http.Error(w, "unsupported entry in llm_provider_priority: "+strconv.Quote(id)+
						" (allowed: "+strings.Join(config.AllowedLLMProviderKinds(), ", ")+")",
						http.StatusBadRequest)
					return
				}
				if seen[id] {
					continue
				}
				seen[id] = true
				providerPriority = append(providerPriority, id)
			}
		}
		var memory string
		if body.MemoryBackend != nil {
			memory = config.NormalizeMemoryBackend(*body.MemoryBackend)
			if memory == "" {
				http.Error(w, "unsupported memory_backend", http.StatusBadRequest)
				return
			}
		}

		cfg, err := config.Load()
		if err != nil {
			// A transient read failure must not turn into a destructive
			// writeback of a zero-value config plus whichever fields the
			// client supplied — that would silently clobber any field the
			// client didn't send (provider keys, custom endpoints, etc.).
			http.Error(w, "config load failed", http.StatusInternalServerError)
			return
		}
		changed := false

		// Enum/string fields. `llmProviderSet` distinguishes "client
		// sent the field with a value" (use it) and "client sent the
		// field with empty string" (clear back to install default)
		// from "client didn't send the field" (leave alone). Without
		// this distinction the Settings UI couldn't drop a saved
		// provider override.
		if llmProviderSet {
			cfg.LLMProvider = llmProvider
			changed = true
		}
		if body.LLMProviderPriority != nil {
			// Explicit pointer set means the client wanted to write this field,
			// even if the final list is empty (which clears the stored order).
			cfg.LLMProviderPriority = providerPriority
			changed = true
		}
		if memory != "" {
			cfg.MemoryBackend = memory
			changed = true
		}
		if body.ActionProvider != nil {
			ap := strings.TrimSpace(strings.ToLower(*body.ActionProvider))
			switch ap {
			case "auto", "one", "composio", "":
				cfg.ActionProvider = ap
				changed = true
			default:
				http.Error(w, "unsupported action_provider", http.StatusBadRequest)
				return
			}
		}
		if body.TeamLeadSlug != nil {
			cfg.TeamLeadSlug = strings.TrimSpace(*body.TeamLeadSlug)
			changed = true
		}
		if body.MaxConcurrent != nil {
			cfg.MaxConcurrent = *body.MaxConcurrent
			changed = true
		}
		if body.DefaultFormat != nil {
			cfg.DefaultFormat = strings.TrimSpace(*body.DefaultFormat)
			changed = true
		}
		if body.DefaultTimeout != nil {
			cfg.DefaultTimeout = *body.DefaultTimeout
			changed = true
		}
		if body.Blueprint != nil {
			cfg.SetActiveBlueprint(*body.Blueprint)
			changed = true
		}
		if body.Email != nil {
			cfg.Email = strings.TrimSpace(*body.Email)
			changed = true
		}
		if body.DevURL != nil {
			cfg.DevURL = strings.TrimSpace(*body.DevURL)
			changed = true
		}
		// Company
		if body.CompanyName != nil {
			cfg.CompanyName = strings.TrimSpace(*body.CompanyName)
			changed = true
		}
		if body.CompanyDesc != nil {
			cfg.CompanyDescription = strings.TrimSpace(*body.CompanyDesc)
			changed = true
		}
		if body.CompanyGoals != nil {
			cfg.CompanyGoals = strings.TrimSpace(*body.CompanyGoals)
			changed = true
		}
		if body.CompanySize != nil {
			cfg.CompanySize = strings.TrimSpace(*body.CompanySize)
			changed = true
		}
		if body.CompanyPriority != nil {
			cfg.CompanyPriority = strings.TrimSpace(*body.CompanyPriority)
			changed = true
		}
		// Polling intervals (minimum 2 minutes, matching resolve functions)
		if body.InsightsPoll != nil {
			if *body.InsightsPoll < 2 {
				http.Error(w, "insights_poll_minutes must be >= 2", http.StatusBadRequest)
				return
			}
			cfg.InsightsPollMinutes = *body.InsightsPoll
			changed = true
		}
		if body.TaskFollowUp != nil {
			if *body.TaskFollowUp < 2 {
				http.Error(w, "task_follow_up_minutes must be >= 2", http.StatusBadRequest)
				return
			}
			cfg.TaskFollowUpMinutes = *body.TaskFollowUp
			changed = true
		}
		if body.TaskReminder != nil {
			if *body.TaskReminder < 2 {
				http.Error(w, "task_reminder_minutes must be >= 2", http.StatusBadRequest)
				return
			}
			cfg.TaskReminderMinutes = *body.TaskReminder
			changed = true
		}
		if body.TaskRecheck != nil {
			if *body.TaskRecheck < 2 {
				http.Error(w, "task_recheck_minutes must be >= 2", http.StatusBadRequest)
				return
			}
			cfg.TaskRecheckMinutes = *body.TaskRecheck
			changed = true
		}
		// Secret fields
		if body.OpenAIAPIKey != nil {
			cfg.OpenAIAPIKey = strings.TrimSpace(*body.OpenAIAPIKey)
			changed = true
		}
		if body.RealtimeModel != nil {
			cfg.RealtimeModel = strings.TrimSpace(*body.RealtimeModel)
			changed = true
		}
		if body.AnthropicAPIKey != nil {
			cfg.AnthropicAPIKey = strings.TrimSpace(*body.AnthropicAPIKey)
			changed = true
		}
		if body.GeminiAPIKey != nil {
			cfg.GeminiAPIKey = strings.TrimSpace(*body.GeminiAPIKey)
			changed = true
		}
		if body.MinimaxAPIKey != nil {
			cfg.MinimaxAPIKey = strings.TrimSpace(*body.MinimaxAPIKey)
			changed = true
		}
		if body.OneAPIKey != nil {
			cfg.OneAPIKey = strings.TrimSpace(*body.OneAPIKey)
			changed = true
		}
		if body.ComposioAPIKey != nil {
			cfg.ComposioAPIKey = strings.TrimSpace(*body.ComposioAPIKey)
			changed = true
		}
		if body.BoxAPIKey != nil {
			token := strings.TrimSpace(*body.BoxAPIKey)
			// Check the key with the provider before saving it. Without this
			// the paste "succeeds" and the first sign of trouble is a 401 in
			// a bot's Computer tab minutes later, with nothing to act on.
			if token != "" {
				if err := box.VerifyToken(r.Context(), boxAPIBase(), token); err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
			}
			cfg.BoxAPIKey = token
			changed = true
		}
		if body.TelegramToken != nil {
			cfg.TelegramBotToken = strings.TrimSpace(*body.TelegramToken)
			changed = true
		}
		if body.OpenclawToken != nil {
			cfg.OpenclawToken = strings.TrimSpace(*body.OpenclawToken)
			changed = true
		}
		if body.OpenclawGateway != nil {
			cfg.OpenclawGatewayURL = strings.TrimSpace(*body.OpenclawGateway)
			changed = true
		}
		// Analytics consent toggles. Copy into a fresh local so the stored
		// pointer doesn't alias the decoded request body.
		if body.AnalyticsTelemetry != nil {
			v := *body.AnalyticsTelemetry
			cfg.AnalyticsTelemetryEnabled = &v
			changed = true
		}
		if body.AnalyticsSessionRecording != nil {
			v := *body.AnalyticsSessionRecording
			cfg.AnalyticsSessionRecordingEnabled = &v
			changed = true
		}
		if body.ProviderEndpoints != nil {
			// Partial merge: only kinds present in the payload are touched,
			// so the Settings UI can update one runtime's endpoint without
			// shipping the whole map. Validate each key against the
			// registry — same source of truth as llm_provider. `changed`
			// flips ONLY when at least one entry actually mutates state,
			// so an empty-map payload (or one whose entries are all
			// empty-key skips) doesn't force a config.Save round-trip.
			if cfg.ProviderEndpoints == nil {
				cfg.ProviderEndpoints = map[string]config.ProviderEndpoint{}
			}
			for kind, ep := range *body.ProviderEndpoints {
				k := strings.TrimSpace(strings.ToLower(kind))
				if k == "" {
					continue
				}
				// provider_endpoints keys must be registered runtime kinds
				// — that includes both directly-dispatchable LLMs
				// (claude-code/codex/opencode/mlx-lm/ollama/exo) and
				// gateway-controlled HTTP runtimes (openclaw-http,
				// hermes-bot) whose base_url + model the operator may
				// legitimately want to override. The legacy openclaw
				// bridge kind has no Register entry (it dispatches via
				// the WebSocket bridge, not /v1/chat/completions) so
				// provider.Lookup returns nil and the request is rejected.
				//
				// Using provider.Lookup (registry membership) instead of
				// config.IsLLMProviderKindAllowed (non-gateway subset) is
				// deliberate: the gateway/non-gateway split lives in the
				// picker UIs, not in the endpoint-configuration surface.
				if provider.Lookup(k) == nil {
					http.Error(w, "unsupported provider_endpoints kind: "+strconv.Quote(k)+
						" (must be a registered runtime kind)",
						http.StatusBadRequest)
					return
				}
				ep.BaseURL = strings.TrimSpace(ep.BaseURL)
				ep.Model = strings.TrimSpace(ep.Model)
				// Security gate: a malicious authenticated client (or
				// anyone with write access to ~/.wuphf/config.json) must
				// not be able to redirect future bot turns to file://,
				// gopher://, unix://, or schemeless URLs. Allow only the
				// two URL families our HTTP client actually services
				// (http, https) and require a non-empty host so a
				// `http://` no-op can't slip through.
				if ep.BaseURL != "" {
					if err := validateProviderEndpointURL(ep.BaseURL); err != nil {
						http.Error(w, "invalid provider_endpoints["+k+"].base_url: "+err.Error(), http.StatusBadRequest)
						return
					}
				}
				if ep.BaseURL == "" && ep.Model == "" {
					// Treat the empty-empty case as a clear so the user can
					// drop their override and fall back to compile-time
					// defaults without hand-editing config.json.
					if _, existed := cfg.ProviderEndpoints[k]; existed {
						delete(cfg.ProviderEndpoints, k)
						changed = true
					}
				} else {
					prev, existed := cfg.ProviderEndpoints[k]
					if !existed || prev != ep {
						cfg.ProviderEndpoints[k] = ep
						changed = true
					}
				}
			}
		}

		if !changed {
			http.Error(w, "no fields to update", http.StatusBadRequest)
			return
		}

		if err := config.Save(cfg); err != nil {
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		// Keep /health in sync for this process so the wizard choice
		// (or a clear back to default) is reflected immediately
		// without requiring a broker restart. Use `llmProviderSet`
		// for the same reason described at the write-back above —
		// nil-vs-empty must round-trip, otherwise /health keeps
		// reporting the stale provider after a clear.
		if llmProviderSet {
			b.mu.Lock()
			providerChanged := b.runtimeProvider != llmProvider
			b.runtimeProvider = llmProvider
			if providerChanged {
				b.publishOfficeChangeLocked(officeChangeEvent{Kind: "office_reseeded"})
			}
			b.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleOfficeMembers and the action handlers (create/update/remove)
// moved to broker_office_members.go.

func (b *Broker) handleGenerateMember(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if b.generateMemberFn == nil {
		http.Error(w, "generate not available", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		http.Error(w, "prompt required", http.StatusBadRequest)
		return
	}
	tmpl, err := b.generateMemberFn(prompt)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(tmpl)
}

func (b *Broker) handleGenerateChannel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if b.generateChannelFn == nil {
		http.Error(w, "generate not available", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		http.Error(w, "prompt required", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	type genResult struct {
		tmpl generatedChannelTemplate
		err  error
	}
	ch := make(chan genResult, 1)
	go func() {
		t, e := b.generateChannelFn(ctx, prompt)
		ch <- genResult{t, e}
	}()
	var tmpl generatedChannelTemplate
	select {
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.Canceled) {
			http.Error(w, "channel generation cancelled", http.StatusRequestTimeout)
			return
		}
		http.Error(w, "channel generation timed out", http.StatusGatewayTimeout)
		return
	case r := <-ch:
		if r.err != nil {
			if errors.Is(r.err, context.Canceled) {
				http.Error(w, "channel generation cancelled", http.StatusRequestTimeout)
				return
			}
			if errors.Is(r.err, context.DeadlineExceeded) {
				http.Error(w, "channel generation timed out", http.StatusGatewayTimeout)
				return
			}
			http.Error(w, r.err.Error(), http.StatusInternalServerError)
			return
		}
		tmpl = r.tmpl
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(tmpl)
}

func (b *Broker) handleChannels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		typeFilter := r.URL.Query().Get("type") // "dm" to see DMs, default excludes them
		b.mu.Lock()
		channels := make([]teamChannel, 0, len(b.channels))
		for _, ch := range b.channels {
			// Group DMs are retired: withhold them from the listing so no
			// multi-participant room can be reached from the UI. The row and
			// its history stay on disk untouched and come back the moment the
			// switch flips, which is the whole point of gating the list rather
			// than deleting the channel.
			if ch.isGroupDM() && !groupDMsEnabled() {
				continue
			}
			// An app's edit thread is plumbing, not a room (see
			// appEditChannelPrefix). It exists so an app can be correlated with
			// its build conversation and so the Edit panel has something to wake
			// on; nobody browses to it. Withheld HERE rather than only in the
			// sidebar because "invisible" has to mean absent from the data every
			// surface enumerates — a picker, a switcher, or a search box added
			// later reads this endpoint and would otherwise list one dead room
			// per app. The app's own Edit panel addresses the channel by slug and
			// never reads this listing.
			if strings.HasPrefix(ch.Slug, appEditChannelPrefix) {
				continue
			}
			// Named-channel retirement: withhold ordinary named rooms from the
			// listing. Bridged channels are EXEMPT — a Slack or Telegram room is
			// how external messages arrive, and hiding it would strand every
			// message that came in through it. ch.Surface is what marks one, so
			// the carve-out reads off the data rather than off a slug list.
			// DMs are unaffected; they are the surface that survives.
			if !namedChannelsEnabled() && !ch.isDM() && ch.Surface == nil {
				continue
			}
			if typeFilter == "dm" {
				// Human DMs only. Bot↔bot pair DMs never appear in
				// listings — their sole human surface is the consult
				// markers' read-only thread view.
				if _, _, pair := isBotToBotDM(ch.Slug); ch.isDM() && !pair {
					channels = append(channels, ch)
				}
			} else {
				// Default: only return real channels, never DMs
				if !ch.isDM() {
					channels = append(channels, ch)
				}
			}
		}
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"channels": channels})
	case http.MethodPost:
		var body struct {
			Action      string          `json:"action"`
			Slug        string          `json:"slug"`
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Members     []string        `json:"members"`
			CreatedBy   string          `json:"created_by"`
			Surface     *channelSurface `json:"surface,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		action := strings.TrimSpace(body.Action)
		slug := normalizeChannelSlug(body.Slug)
		now := time.Now().UTC().Format(time.RFC3339)
		b.mu.Lock()
		defer b.mu.Unlock()
		validateMembers := func(members []string) ([]string, string) {
			members = uniqueSlugs(members)
			if len(members) == 0 {
				return nil, ""
			}
			validated := make([]string, 0, len(members))
			var missing []string
			for _, member := range members {
				if b.findMemberLocked(member) == nil {
					missing = append(missing, member)
					continue
				}
				validated = append(validated, member)
			}
			return validated, strings.Join(missing, ", ")
		}
		switch action {
		case "create":
			// Named-channel retirement. The gate sits HERE, at the HTTP
			// boundary, and NOT inside createChannelLocked — deliberately.
			//
			// createChannelLocked has five callers. Three of them must keep
			// working while named channels are off: the Slack bridge, the
			// Telegram bridge (both are how EXTERNAL messages arrive, not rooms
			// bots chat in), and the app-<id> edit thread (hidden plumbing,
			// load-bearing for apps being editable at all). Gating the shared
			// helper would mean maintaining an exemption list inside it, and an
			// exemption list is a thing that goes stale. Gating the one
			// human-facing entry point needs no list: the other callers are
			// exempt by construction.
			//
			// Do NOT "finish the job" by moving this into createChannelLocked.
			if !namedChannelsEnabled() {
				http.Error(w,
					"named channels are retired: conversations happen in a DM with one bot. Open a DM and tag the others in it.",
					http.StatusConflict)
				return
			}
			ch, cerr := b.createChannelLocked(channelCreateInput{
				Slug:        body.Slug,
				Name:        body.Name,
				Description: body.Description,
				Members:     body.Members,
				CreatedBy:   body.CreatedBy,
				Surface:     body.Surface,
			})
			if cerr != nil {
				http.Error(w, cerr.Msg, cerr.Code)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"channel": ch})
		case "update":
			if slug == "" {
				http.Error(w, "slug required", http.StatusBadRequest)
				return
			}
			ch := b.findChannelLocked(slug)
			if ch == nil {
				http.Error(w, "channel not found", http.StatusNotFound)
				return
			}
			if name := strings.TrimSpace(body.Name); name != "" {
				ch.Name = name
			}
			if description := strings.TrimSpace(body.Description); description != "" {
				ch.Description = description
			}
			if body.Surface != nil {
				ch.Surface = body.Surface
			}
			if body.Members != nil {
				// A DM's participants are fixed by its slug. Editing them
				// here would be the one remaining path for a third party
				// into a private thread.
				if ch.isDM() {
					http.Error(w, "a DM's participants are fixed; open a channel for a group", http.StatusBadRequest)
					return
				}
				members, missing := validateMembers(body.Members)
				if missing != "" {
					http.Error(w, "unknown members: "+missing, http.StatusNotFound)
					return
				}
				ch.Members = uniqueSlugs(append([]string{"ceo"}, members...))
				if len(ch.Disabled) > 0 {
					// Drop any disabled entry whose slug is in the updated
					// roster. The semantic pinned by
					// TestChannelUpdateMutatesDescriptionAndMembers is
					// "re-adding a slug to Members clears the per-channel
					// disabled flag" — so the filter keeps only entries
					// that are NOT in the new member list.
					filtered := make([]string, 0, len(ch.Disabled))
					for _, disabled := range ch.Disabled {
						if !containsString(ch.Members, disabled) {
							filtered = append(filtered, disabled)
						}
					}
					ch.Disabled = filtered
				}
			}
			ch.UpdatedAt = now
			if err := b.saveLocked(); err != nil {
				http.Error(w, "failed to persist broker state", http.StatusInternalServerError)
				return
			}
			b.publishOfficeChangeLocked(officeChangeEvent{Kind: "channel_updated", Slug: slug})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"channel": ch})
		case "remove":
			if slug == "" || slug == "general" {
				http.Error(w, "cannot remove channel", http.StatusBadRequest)
				return
			}
			idx := -1
			for i := range b.channels {
				if b.channels[i].Slug == slug {
					idx = i
					break
				}
			}
			if idx == -1 {
				http.Error(w, "channel not found", http.StatusNotFound)
				return
			}
			b.channels = append(b.channels[:idx], b.channels[idx+1:]...)
			filteredMessages := b.messages[:0]
			for _, msg := range b.messages {
				if normalizeChannelSlug(msg.Channel) != slug {
					filteredMessages = append(filteredMessages, msg)
				}
			}
			b.messages = filteredMessages
			filteredTasks := b.tasks[:0]
			for _, task := range b.tasks {
				if normalizeChannelSlug(task.Channel) != slug {
					filteredTasks = append(filteredTasks, task)
				}
			}
			b.tasks = filteredTasks
			filteredRequests := b.requests[:0]
			for _, req := range b.requests {
				if normalizeChannelSlug(req.Channel) != slug {
					filteredRequests = append(filteredRequests, req)
				}
			}
			b.requests = filteredRequests
			b.pendingInterview = firstBlockingRequest(b.requests)
			b.pruneIncidentsByChannelLocked(slug)
			if err := b.saveLocked(); err != nil {
				http.Error(w, "failed to persist broker state", http.StatusInternalServerError)
				return
			}
			b.publishOfficeChangeLocked(officeChangeEvent{Kind: "channel_removed", Slug: slug})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		default:
			http.Error(w, "unknown action", http.StatusBadRequest)
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *Broker) handleChannelMembers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		channel := normalizeChannelSlug(r.URL.Query().Get("channel"))
		b.mu.Lock()
		ch := b.findChannelLocked(channel)
		if ch == nil {
			b.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"channel": channel, "members": []map[string]any{}})
			return
		}
		memberInfo := make([]map[string]any, 0, len(ch.Members))
		for _, member := range ch.Members {
			memberInfo = append(memberInfo, map[string]any{
				"slug":     member,
				"disabled": !b.channelMemberEnabledLocked(channel, member),
			})
		}
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"channel": channel, "members": memberInfo})
	case http.MethodPost:
		var body struct {
			Channel string `json:"channel"`
			Action  string `json:"action"`
			Slug    string `json:"slug"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		channel := normalizeChannelSlug(body.Channel)
		action := strings.TrimSpace(body.Action)
		// body.Slug names a MEMBER here, not a channel: actor normaliser, and
		// the 400 tests the raw value. normalizeChannelSlug turned a missing
		// member slug into "general", so this rejection never fired and the
		// handler went on to add or remove a "member" named after a channel.
		if strings.TrimSpace(body.Slug) == "" {
			http.Error(w, "slug required", http.StatusBadRequest)
			return
		}
		member := normalizeChannelSlug(body.Slug)
		b.mu.Lock()
		ch := b.findChannelLocked(channel)
		if ch == nil {
			b.mu.Unlock()
			http.Error(w, "channel not found", http.StatusNotFound)
			return
		}
		memberRecord := b.findMemberLocked(member)
		if memberRecord == nil {
			b.mu.Unlock()
			http.Error(w, "member not found", http.StatusNotFound)
			return
		}
		// Lead bots (BuiltIn) cannot be disabled or removed from any
		// channel. The blueprint's lead is the tag target for the onboarding
		// kickoff and the default owner for channel membership; the UI locks
		// these interactions too. Keeps the "ceo" literal as a legacy guard
		// for team states that predate the BuiltIn field.
		if (memberRecord.BuiltIn || member == "ceo") && (action == "remove" || action == "disable") {
			b.mu.Unlock()
			http.Error(w, "cannot remove or disable lead bot", http.StatusBadRequest)
			return
		}
		switch action {
		case "add":
			ch.Members = uniqueSlugs(append(ch.Members, member))
		case "remove":
			filtered := ch.Members[:0]
			for _, existing := range ch.Members {
				if existing != member {
					filtered = append(filtered, existing)
				}
			}
			ch.Members = filtered
			disabled := ch.Disabled[:0]
			for _, existing := range ch.Disabled {
				if existing != member {
					disabled = append(disabled, existing)
				}
			}
			ch.Disabled = disabled
		case "disable":
			if !b.channelHasMemberLocked(channel, member) {
				ch.Members = uniqueSlugs(append(ch.Members, member))
			}
			ch.Disabled = uniqueSlugs(append(ch.Disabled, member))
		case "enable":
			filtered := ch.Disabled[:0]
			for _, existing := range ch.Disabled {
				if existing != member {
					filtered = append(filtered, existing)
				}
			}
			ch.Disabled = filtered
		default:
			b.mu.Unlock()
			http.Error(w, "unknown action", http.StatusBadRequest)
			return
		}
		ch.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if err := b.saveLocked(); err != nil {
			b.mu.Unlock()
			http.Error(w, "failed to persist broker state", http.StatusInternalServerError)
			return
		}
		// Match the channel-create/update/remove paths: notify SSE
		// subscribers that the roster changed. Without this, sidebars
		// and member dialogs keep stale member lists until a full
		// reload.
		b.publishOfficeChangeLocked(officeChangeEvent{Kind: "channel_updated", Slug: ch.Slug})
		state := map[string]any{
			"channel":  ch.Slug,
			"members":  ch.Members,
			"disabled": ch.Disabled,
		}
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *Broker) handleMembers(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	channel := normalizeChannelSlug(r.URL.Query().Get("channel"))
	if channel == "" {
		channel = "general"
	}
	viewerSlug := strings.TrimSpace(r.URL.Query().Get("viewer_slug"))
	if !b.canAccessChannelLocked(viewerSlug, channel) {
		b.mu.Unlock()
		http.Error(w, "channel access denied", http.StatusForbidden)
		return
	}
	type memberView struct {
		name        string
		role        string
		lastMessage string
		lastTime    string
		disabled    bool
	}
	isOneOnOne := b.sessionMode == SessionModeOneOnOne
	oneOnOneSlug := b.oneOnOneBot
	memberProfiles := make(map[string]memberView, len(b.members))
	for _, member := range b.members {
		// Member slugs key this map, so all three touch points below use the
		// ACTOR normaliser. They must agree: a map written under one normaliser
		// and read under the other misses for any slug the two disagree on.
		memberProfiles[normalizeActorSlug(member.Slug)] = memberView{name: member.Name, role: member.Role}
	}
	members := make(map[string]memberView)
	if ch := b.findChannelLocked(channel); ch != nil {
		for _, member := range ch.Members {
			if isOneOnOne && member != oneOnOneSlug {
				continue
			}
			info := memberView{disabled: containsString(ch.Disabled, member)}
			if office, ok := memberProfiles[normalizeActorSlug(member)]; ok {
				info.name = office.name
				info.role = office.role
			}
			members[member] = info
		}
	}
	lastMessages := make([]channelMessage, 0)
	for _, msg := range b.messages {
		if normalizeChannelSlug(msg.Channel) != channel {
			continue
		}
		if isOneOnOne && msg.From != oneOnOneSlug {
			continue
		}
		if msg.Kind == "automation" || msg.From == "nex" {
			continue
		}
		lastMessages = append(lastMessages, msg)
	}
	taggedAt := make(map[string]time.Time, len(b.lastTaggedAt))
	for slug, ts := range b.lastTaggedAt {
		taggedAt[slug] = ts
	}
	activity := make(map[string]botActivitySnapshot, len(b.activity))
	for slug, snapshot := range b.activity {
		activity[slug] = snapshot
	}
	b.mu.Unlock()

	for _, msg := range lastMessages {
		// redaction removed (core-loop R1)
		content := msg.Content
		if len(content) > 80 {
			content = content[:80]
		}
		info := members[msg.From]
		info.lastMessage = content
		info.lastTime = msg.Timestamp
		if info.name == "" {
			if office, ok := memberProfiles[normalizeActorSlug(msg.From)]; ok {
				info.name = office.name
				info.role = office.role
			}
		}
		members[msg.From] = info
	}

	type memberEntry struct {
		Slug         string `json:"slug"`
		Name         string `json:"name,omitempty"`
		Role         string `json:"role,omitempty"`
		Disabled     bool   `json:"disabled,omitempty"`
		LastMessage  string `json:"lastMessage"`
		LastTime     string `json:"lastTime"`
		LiveActivity string `json:"liveActivity,omitempty"`
		Status       string `json:"status,omitempty"`
		Activity     string `json:"activity,omitempty"`
		Detail       string `json:"detail,omitempty"`
		TotalMs      int64  `json:"totalMs,omitempty"`
		FirstEventMs int64  `json:"firstEventMs,omitempty"`
		FirstTextMs  int64  `json:"firstTextMs,omitempty"`
		FirstToolMs  int64  `json:"firstToolMs,omitempty"`
	}

	// Capture pane activity via diff detection.
	// If content changed since last poll, bot is active — return last 5 lines.
	var paneActivity map[string]string
	if isOneOnOne && oneOnOneSlug != "" {
		paneActivity = b.capturePaneActivity(oneOnOneSlug)
	} else {
		paneActivity = b.capturePaneActivity("")
	}

	var list []memberEntry
	for slug, info := range members {
		entry := memberEntry{
			Slug:        slug,
			Name:        info.name,
			Role:        info.role,
			Disabled:    info.disabled,
			LastMessage: info.lastMessage,
			LastTime:    info.lastTime,
		}
		if snapshot, ok := activity[slug]; ok {
			entry.Status = snapshot.Status
			entry.Activity = snapshot.Activity
			entry.Detail = snapshot.Detail
			entry.TotalMs = snapshot.TotalMs
			entry.FirstEventMs = snapshot.FirstEventMs
			entry.FirstTextMs = snapshot.FirstTextMs
			entry.FirstToolMs = snapshot.FirstToolMs
			if snapshot.LastTime != "" {
				entry.LastTime = snapshot.LastTime
			}
			if snapshot.Detail != "" {
				entry.LiveActivity = snapshot.Detail
			}
		}
		if live, ok := paneActivity[slug]; ok {
			entry.Status = "active"
			if entry.Activity == "" {
				entry.Activity = "text"
			}
			entry.LiveActivity = live
			entry.Detail = live
			if entry.LastTime == "" {
				entry.LastTime = time.Now().UTC().Format(time.RFC3339)
			}
		}
		// Also mark as active if tagged recently and hasn't replied yet
		if entry.LiveActivity == "" && taggedAt != nil {
			if t, ok := taggedAt[slug]; ok && time.Since(t) < 60*time.Second {
				entry.Status = "active"
				if entry.Activity == "" {
					entry.Activity = "queued"
				}
				entry.LiveActivity = "active"
			}
		}
		if entry.Status == "" {
			entry.Status = "idle"
		}
		if entry.Activity == "" {
			entry.Activity = "idle"
		}
		list = append(list, entry)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"channel": channel, "members": list})
}

func (b *Broker) EnabledMembers(channel string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sessionMode == SessionModeOneOnOne {
		return []string{b.oneOnOneBot}
	}
	channel = normalizeChannelSlug(channel)
	if channel == "" {
		channel = "general"
	}
	if ch := b.findChannelLocked(channel); ch != nil {
		return b.enabledChannelMembersLocked(channel, ch.Members)
	}
	return nil
}

// DisabledMembers returns the slugs explicitly disabled for a channel —
// members who were present in ch.Members at some point but have been muted
// for this channel. Callers use this to distinguish "never added" (which an
// explicit @-tag can bypass) from "deliberately muted" (which an @-tag must
// respect — muting a bot is the user's explicit intent to silence them).
func (b *Broker) DisabledMembers(channel string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	channel = normalizeChannelSlug(channel)
	if channel == "" {
		channel = "general"
	}
	ch := b.findChannelLocked(channel)
	if ch == nil || len(ch.Disabled) == 0 {
		return nil
	}
	return append([]string(nil), ch.Disabled...)
}

// SurfaceChannels returns all channels that have a surface configured for the given provider.
func (b *Broker) SurfaceChannels(provider string) []teamChannel {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []teamChannel
	for _, ch := range b.channels {
		if ch.Surface != nil && ch.Surface.Provider == provider {
			cp := ch
			cp.Members = append([]string(nil), ch.Members...)
			cp.Disabled = append([]string(nil), ch.Disabled...)
			s := *ch.Surface
			cp.Surface = &s
			out = append(out, cp)
		}
	}
	return out
}
