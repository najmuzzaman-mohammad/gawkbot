package team

// broker_openai_compat.go — a minimal OpenAI-compatible /v1/chat/completions
// route backed by the office's already-configured bot CLI.
//
// Why this exists
// ===============
// gbrain speaks HTTP to model providers. A user on a Claude Pro or ChatGPT
// subscription has no API key of any kind — their credentials live inside the
// `claude` or `codex` CLI, which is a subprocess. So gbrain cannot reach a model
// for them, and they lose BOTH arms of retrieval quality:
//
//   - no embeddings (nothing to do about that here: Anthropic ships no
//     embeddings endpoint, and a chat model cannot produce a usable vector), and
//   - no query expansion, which IS recoverable, because expansion only needs a
//     chat model. gbrain gates it on chat availability alone, independent of
//     embeddings (core/search/expansion.ts).
//
// This route closes the second gap. Point gbrain's `expansion_model` at it via
// `provider_base_urls` and a subscription-only user gets keyword retrieval plus
// LLM query expansion, instead of bare keyword search.
//
// Deliberately narrow
// ===================
// This is NOT a general OpenAI gateway and must not grow into one. It serves
// exactly what gbrain's expansion touchpoint needs:
//
//   - non-streaming only. Expansion wants one short completion; `stream: true`
//     is rejected rather than faked, because a client that asked for SSE and got
//     a single JSON body would hang waiting for frames that never come.
//   - no tool calls, no images, no logprobs, no n>1.
//   - the messages are flattened to a system prompt plus a user prompt, which is
//     the whole shape RunConfiguredOneShotCtx accepts.
//
// Anything richer should use the provider layer directly rather than widening
// this surface.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/provider"
)

// openAICompatMaxPromptBytes bounds the prompt this route will forward.
//
// The body reaches a subprocess that bills real tokens, and the caller is a
// retrieval component that should only ever send a short query. A generous cap
// still refuses a runaway or hostile body long before it becomes expensive.
const openAICompatMaxPromptBytes = 32 * 1024

// openAICompatTimeout bounds one upstream CLI turn. Expansion is on the query
// path: a caller waiting on it has a user waiting on them, so a slow provider
// must fail rather than hang.
const openAICompatTimeout = 45 * time.Second

// openAIChatRequest is the subset of the chat-completions request this route
// honours. Unknown fields are ignored by encoding/json, which is the correct
// posture for a compatibility shim: a client sending `temperature` should not
// get a 400 just because this route does not forward it.
type openAIChatRequest struct {
	Model    string              `json:"model"`
	Messages []openAIChatMessage `json:"messages"`
	Stream   bool                `json:"stream"`
}

type openAIChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// openAIChatResponse is the non-streaming response shape. Field names and the
// nesting are load-bearing: the AI SDK's openai-compatible adapter parses this
// with a strict schema, so a "close enough" shape fails at the client.
type openAIChatResponse struct {
	ID      string             `json:"id"`
	Object  string             `json:"object"`
	Created int64              `json:"created"`
	Model   string             `json:"model"`
	Choices []openAIChatChoice `json:"choices"`
	Usage   openAIChatUsage    `json:"usage"`
}

type openAIChatChoice struct {
	Index        int               `json:"index"`
	Message      openAIChatMessage `json:"message"`
	FinishReason string            `json:"finish_reason"`
}

// openAIChatUsage is reported as zeros. The upstream CLIs do not surface token
// counts through the one-shot hook, and inventing numbers would be worse than
// admitting none: a caller doing cost accounting would silently under-report.
type openAIChatUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// handleOpenAIChatCompletions serves POST /v1/chat/completions.
func (b *Broker) handleOpenAIChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "only POST is supported")
		return
	}

	var req openAIChatRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, openAICompatMaxPromptBytes))
	if err := dec.Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	if req.Stream {
		// Refused, not faked. A client that asked for SSE and received one JSON
		// body would wait for frames that never arrive.
		writeOpenAIError(w, http.StatusBadRequest,
			"streaming is not supported by this endpoint; retry with stream:false")
		return
	}

	systemPrompt, userPrompt := splitOpenAIMessages(req.Messages)
	if strings.TrimSpace(userPrompt) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "no user message content")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), openAICompatTimeout)
	defer cancel()

	out, err := provider.RunConfiguredOneShotCtx(ctx, systemPrompt, userPrompt, "")
	if err != nil {
		// 502: this route is a proxy, and the failure is upstream. A 500 would
		// tell the caller to retry against us, which cannot help.
		writeOpenAIError(w, http.StatusBadGateway, "upstream provider failed: "+err.Error())
		return
	}

	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = "wuphf-configured-provider"
	}
	resp := openAIChatResponse{
		ID:      "chatcmpl-wuphf-" + fmt.Sprintf("%d", time.Now().UnixNano()),
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   model,
		Choices: []openAIChatChoice{{
			Index:        0,
			Message:      openAIChatMessage{Role: "assistant", Content: out},
			FinishReason: "stop",
		}},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// splitOpenAIMessages flattens a chat transcript into the (system, user) pair
// RunConfiguredOneShotCtx accepts.
//
// Multiple system messages are joined; the remaining roles are joined in order
// with their role as a prefix, so a multi-turn request still reaches the CLI as
// coherent text rather than losing everything but the last line. Expansion
// sends a single user turn, so this mostly matters for robustness.
func splitOpenAIMessages(msgs []openAIChatMessage) (systemPrompt, userPrompt string) {
	var systems, rest []string
	for _, m := range msgs {
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(m.Role)) {
		case "system", "developer":
			systems = append(systems, content)
		case "user", "":
			rest = append(rest, content)
		default:
			// assistant / tool turns keep their role so the CLI can read the
			// exchange rather than mistaking it for the user's own words.
			rest = append(rest, m.Role+": "+content)
		}
	}
	return strings.Join(systems, "\n\n"), strings.Join(rest, "\n\n")
}

// writeOpenAIError emits an OpenAI-shaped error envelope, which is what an
// openai-compatible client expects to parse on a non-2xx.
func writeOpenAIError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "invalid_request_error",
		},
	})
}
