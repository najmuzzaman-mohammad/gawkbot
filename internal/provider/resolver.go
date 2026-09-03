package provider

import (
	"github.com/nex-crm/wuphf/internal/bot"
	"github.com/nex-crm/wuphf/internal/config"
)

// ProviderKindResolver maps a bot slug to its registered provider Kind.
// Implementations consult per-bot state (e.g., broker.MemberProviderKind)
// and return "" when the bot has no explicit binding so the resolver can
// fall back to the install-wide default.
type ProviderKindResolver func(botSlug string) string

// DefaultStreamFnResolver returns a StreamFnResolver that picks a provider's
// StreamFn factory by Kind. Resolution order:
//
//  1. Per-bot kind from kindResolver (if non-nil and returns non-empty).
//     This is always honored — the global runtime never overrides an
//     existing bot's per-bot binding.
//  2. Install-wide kind from config.ResolveLLMProvider — the
//     default-for-new-bots fallback used at bot creation time and
//     when a bot has no per-bot binding.
//  3. Claude Code (default fallback for unknown / unregistered Kinds).
//
// kindResolver is what makes per-bot ProviderBindings (an Ollama bot
// alongside Claude bots in the same team) actually take effect on the
// streaming dispatch path. Pass nil to use only the install-wide default.
//
// Config is re-read on each call so runtime provider changes (e.g., a /provider
// switch from the TUI) take effect on the next bot turn without restart.
// The install-wide LLMProvider is intentionally a default-for-new-bots
// only — changing it never replays through existing bots' bindings. To
// change an existing bot's runtime, edit it through the BotProfilePanel.
func DefaultStreamFnResolver(kindResolver ProviderKindResolver) bot.StreamFnResolver {
	return func(botSlug string) bot.StreamFn {
		var kind string
		if kindResolver != nil {
			kind = kindResolver(botSlug)
		}
		if kind == "" {
			kind = config.ResolveLLMProvider("")
		}
		if e := Lookup(kind); e != nil {
			return e.StreamFn(botSlug)
		}
		return CreateClaudeCodeStreamFn(botSlug)
	}
}
