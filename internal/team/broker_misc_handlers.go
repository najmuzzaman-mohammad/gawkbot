package team

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/buildinfo"
	"github.com/nex-crm/wuphf/internal/company"
	"github.com/nex-crm/wuphf/internal/config"
)

// HealthResponse is the stable JSON response served by GET /health.
type HealthResponse struct {
	Status              string         `json:"status"`
	SessionMode         string         `json:"session_mode"`
	OneOnOneBot         string         `json:"one_on_one_agent"`
	FocusMode           bool           `json:"focus_mode"`
	Provider            string         `json:"provider"`
	ProviderModel       string         `json:"provider_model"`
	MemoryBackend       string         `json:"memory_backend"`
	MemoryBackendActive string         `json:"memory_backend_active"`
	MemoryBackendReady  bool           `json:"memory_backend_ready"`
	Build               buildinfo.Info `json:"build"`
}

func (b *Broker) handleHealth(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	mode := b.sessionMode
	bot := b.oneOnOneBot
	focus := b.focusMode
	provider := b.runtimeProvider
	b.mu.Unlock()
	if strings.TrimSpace(provider) == "" {
		provider = config.ResolveLLMProvider("")
	}
	memoryStatus := ResolveMemoryBackendStatus()
	// MemoryBackendReady must reflect *runtime* readiness, not just config:
	// the markdown backend can resolve to "active" yet have b.wikiWorker
	// == nil because repo.Init failed at startup. Without this gate,
	// /health reported ready while every /notebook/* and /review/* call
	// returned 503, masking the failure from operators and the web UI.
	ready := memoryStatus.ActiveKind != config.MemoryBackendNone
	if memoryStatus.ActiveKind == config.MemoryBackendMarkdown {
		ready = b.WikiWorker() != nil
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(HealthResponse{
		Status:              "ok",
		SessionMode:         mode,
		OneOnOneBot:         bot,
		FocusMode:           focus,
		Provider:            provider,
		ProviderModel:       resolveProviderModel(provider),
		MemoryBackend:       memoryStatus.SelectedKind,
		MemoryBackendActive: memoryStatus.ActiveKind,
		MemoryBackendReady:  ready,
		Build:               buildinfo.Current(),
	})
}

// resolveProviderModel returns the effective model id for the active LLM
// provider so the web UI's status bar can show, e.g.
// "opencode · ollama/qwen2.5-coder:1.5b". Returns "" when the provider has
// no resolvable model (claude-code uses the CLI's bundled default unless the
// user overrides via --model; we don't parse that out here).
func resolveProviderModel(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "codex":
		// Empty cwd keeps the home-dir config lookup but skips the
		// workspace-relative walk — Broker doesn't know which workspace the
		// caller is in, and the status bar is a coarse indicator anyway.
		return config.ResolveCodexModel("")
	case "opencode":
		return config.ResolveOpencodeModel()
	default:
		return ""
	}
}

func (b *Broker) handleSessionMode(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		mode, bot := b.SessionModeState()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session_mode":     mode,
			"one_on_one_agent": bot,
		})
	case http.MethodPost:
		var body struct {
			Mode string `json:"mode"`
			Bot  string `json:"agent"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := b.SetSessionMode(body.Mode, body.Bot); err != nil {
			http.Error(w, "failed to persist broker state", http.StatusInternalServerError)
			return
		}
		mode, bot := b.SessionModeState()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session_mode":     mode,
			"one_on_one_agent": bot,
		})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *Broker) handleFocusMode(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"focus_mode": b.FocusModeEnabled(),
		})
	case http.MethodPost:
		var body struct {
			FocusMode bool `json:"focus_mode"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := b.SetFocusMode(body.FocusMode); err != nil {
			http.Error(w, "failed to persist", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"focus_mode": b.FocusModeEnabled(),
		})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *Broker) handleReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	b.Reset()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (b *Broker) handleResetDM(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Bot     string `json:"agent"`
		Channel string `json:"channel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	bot := strings.TrimSpace(body.Bot)
	// Raw emptiness first: normalizeChannelSlug("") is "general", so a missing
	// channel used to be silently laundered into the shared room. Resolve a real
	// home instead — while #general is enabled this still answers "general", so
	// today is unchanged; once it is off this is the bot's DM, or a refusal.
	//
	// homeChannelFor is the correct variant HERE specifically: b.mu is
	// NOT held at this point. The other variant would
	// read the roster unsynchronised.
	channel := ""
	if raw := strings.TrimSpace(body.Channel); raw != "" {
		channel = normalizeChannelSlug(raw)
	}
	if channel == "" {
		home, err := b.homeChannelFor(body.Bot)
		if err != nil {
			http.Error(w, `channel is required: there is no default room to fall back to. Name a channel, or set a member slug so the message can go to that agent's DM.`, http.StatusBadRequest)
			return
		}
		channel = home
	}
	// bot is required: an empty bot would otherwise cause this handler
	// to wipe every human-authored message in the channel, even ones that
	// belong to other bots' threads.
	if bot == "" {
		http.Error(w, "bot is required", http.StatusBadRequest)
		return
	}

	b.mu.Lock()
	// Keep only messages that are NOT direct exchanges between human and the
	// SPECIFIED bot. Human messages must explicitly tag the bot, and
	// bot messages must come from that bot — anything else (other
	// bots' threads, broadcasts, etc.) is preserved.
	filtered := make([]channelMessage, 0, len(b.messages))
	removed := 0
	for _, msg := range b.messages {
		if normalizeChannelSlug(msg.Channel) != channel {
			filtered = append(filtered, msg)
			continue
		}
		isHuman := isHumanMessageSender(msg.From)
		isBot := msg.From == bot
		if isHuman {
			// Only drop human messages that are part of THIS bot's thread:
			// either tagged at the bot, or replying inside that thread.
			taggedBot := false
			for _, t := range msg.Tagged {
				if t == bot {
					taggedBot = true
					break
				}
			}
			if !taggedBot {
				filtered = append(filtered, msg)
				continue
			}
			removed++
			continue
		}
		if isBot {
			// Drop bot->human DMs: messages where the bot explicitly
			// tagged the human. Anything else (untagged broadcasts,
			// messages tagged at other bots, channel-wide replies) is
			// preserved — only the human↔bot thread is being reset.
			taggedHuman := false
			for _, t := range msg.Tagged {
				if isHumanMessageSender(t) {
					taggedHuman = true
					break
				}
			}
			if !taggedHuman {
				filtered = append(filtered, msg)
				continue
			}
			removed++
			continue
		}
		filtered = append(filtered, msg)
	}
	b.messages = filtered
	b.pruneIncidentsByChannelAndBotLocked(channel, bot)
	if err := b.saveLocked(); err != nil {
		// Roll forward: snapshot save failed, but the in-memory mutation
		// already applied. Surface the error rather than reporting success.
		b.mu.Unlock()
		http.Error(w, "failed to persist DM reset", http.StatusInternalServerError)
		return
	}
	b.mu.Unlock()

	// Respawn the bot's Claude Code session to clear its context
	go respawnBotPane(bot)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "removed": removed})
}

// respawnBotPane restarts a bot's Claude Code session in its tmux pane.
func respawnBotPane(slug string) {
	manifest := company.DefaultManifest()
	loaded, err := company.LoadManifest()
	if err == nil && len(loaded.Members) > 0 {
		manifest = loaded
	}

	for i, bot := range manifest.Members {
		if bot.Slug == slug {
			paneIdx := i + 1 // pane 0 is channel view
			target := fmt.Sprintf("wuphf-team:team.%d", paneIdx)
			// Bound each tmux call so a stalled socket can't strand the
			// goroutine that handleResetDM spawned. 5s is generous for a
			// healthy local tmux server and short enough that an offline
			// server fails fast.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = exec.CommandContext(ctx, "tmux", "-L", "wuphf", "send-keys", "-t", target, "C-c", "").Run()
			time.Sleep(500 * time.Millisecond)
			_ = exec.CommandContext(ctx, "tmux", "-L", "wuphf", "send-keys", "-t", target, "C-c", "").Run()
			time.Sleep(500 * time.Millisecond)
			// Respawn the pane with a fresh claude session
			_ = exec.CommandContext(ctx, "tmux", "-L", "wuphf", "respawn-pane", "-k", "-t", target).Run()
			return
		}
	}
}

func (b *Broker) handleSignals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	b.mu.Lock()
	signals := make([]officeSignalRecord, len(b.signals))
	copy(signals, b.signals)
	b.mu.Unlock()
	copy(signals, signals)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"signals": signals})
}

func (b *Broker) handleDecisions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	b.mu.Lock()
	decisions := make([]officeDecisionRecord, len(b.decisions))
	copy(decisions, b.decisions)
	b.mu.Unlock()
	copy(decisions, decisions)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"decisions": decisions})
}

func (b *Broker) handleWatchdogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	b.mu.Lock()
	alerts := make([]watchdogAlert, len(b.watchdogs))
	copy(alerts, b.watchdogs)
	b.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"watchdogs": alerts})
}

func (b *Broker) handleActions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		b.mu.Lock()
		actions := make([]officeActionLog, len(b.actions))
		copy(actions, b.actions)
		b.mu.Unlock()
		for i, action := range actions {
			actions[i] = sanitizeOfficeActionLog(action)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"actions": actions})
	case http.MethodPost:
		var body struct {
			Kind       string            `json:"kind"`
			Source     string            `json:"source"`
			Channel    string            `json:"channel"`
			Actor      string            `json:"actor"`
			Summary    string            `json:"summary"`
			RelatedID  string            `json:"related_id"`
			SignalIDs  []string          `json:"signal_ids"`
			DecisionID string            `json:"decision_id"`
			Metadata   map[string]string `json:"metadata"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(body.Kind) == "" || strings.TrimSpace(body.Summary) == "" {
			http.Error(w, "kind and summary required", http.StatusBadRequest)
			return
		}
		if actor, ok := requestActorFromContext(r.Context()); ok && actor.Kind == requestActorKindHuman {
			body.Actor = humanMessageSender(actor.Slug)
		}
		if err := b.RecordActionWithMetadata(
			body.Kind,
			body.Source,
			body.Channel,
			body.Actor,
			body.Summary,
			body.RelatedID,
			body.SignalIDs,
			body.DecisionID,
			body.Metadata,
		); err != nil {
			http.Error(w, "failed to persist action", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *Broker) handleQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(b.QueueSnapshot())
}

func (b *Broker) handleTelegramGroups(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	b.mu.Lock()
	groups := make([]map[string]any, 0)
	for chatID, title := range b.seenTelegramGroups {
		groups = append(groups, map[string]any{"chat_id": chatID, "title": title})
	}
	b.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"groups": groups})
}
