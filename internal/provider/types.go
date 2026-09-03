// Package provider implements LLM backend providers for bots.
//
// Each provider (claude-code, codex, hermes-bot, openclaw-http, ollama, vllm, exo, openai-compatible)
// registers itself with the Registry (registry.go) at init() time. Dispatch
// sites — DefaultStreamFnResolver, RunConfiguredOneShot, and team-side
// capability checks (PaneEligible, RequiresClaudeSessionReset) — look kinds
// up through the Registry rather than hardcoded switches, so adding a new
// provider does not require touching every dispatcher.
package provider
