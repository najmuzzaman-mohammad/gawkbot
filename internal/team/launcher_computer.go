package team

// launcher_computer.go: the runner-facing half of a bot's computer. Both
// headless runners (Claude, Codex) call mountComputerForTurn before they
// build their MCP config and releaseComputerForTurn when the turn ends.
// Every method on a nil *computerMount is a no-op, so a bot without a
// computer costs the runners nothing.

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// mountComputerForTurn resolves and wakes the bot's computer. Failures
// are reported into the bot's own stream and the turn proceeds without
// a computer, never blocking the reply.
func (l *Launcher) mountComputerForTurn(ctx context.Context, slug string) *computerMount {
	if l == nil || l.broker == nil {
		return nil
	}
	turnID := newHeadlessTurnID()
	taskID := l.turnTaskIDForCtx(ctx, slug)
	controlURL := l.BrokerBaseURL() + "/computer-control/" + slug
	mount, err := l.broker.computers().mountForTurn(ctx, slug, turnID, taskID, controlURL, l.broker.Token())
	if err != nil {
		appendHeadlessClaudeLog(slug, "computer: "+err.Error())
		if stream := l.broker.BotStream(slug); stream != nil {
			emitHeadlessText(stream, turnID, "computer", slug, taskID, fmt.Sprintf("(computer unavailable this turn: %s)", err.Error()), "computer.unavailable")
		}
		return nil
	}
	return mount
}

// releaseComputerForTurn ends the mount; safe on nil.
func (l *Launcher) releaseComputerForTurn(m *computerMount) {
	if m == nil || l == nil || l.broker == nil {
		return
	}
	l.broker.computers().releaseTurn(m)
}

// pokeComputer refreshes the live preview after a computer tool result.
func (l *Launcher) pokeComputer(slug string) {
	if l == nil || l.broker == nil {
		return
	}
	l.broker.computers().poke(slug)
}

// mcpServers is the extra server map for the Claude runner's config.
func (m *computerMount) mcpServers() map[string]any {
	if m == nil {
		return nil
	}
	entry := map[string]any{
		"command": m.Launch.Command,
		"args":    m.Launch.Args,
	}
	if len(m.Launch.Env) > 0 {
		entry["env"] = m.Launch.Env
	}
	return map[string]any{"computer": entry}
}

// promptHint is the system-prompt block telling the bot it has hands.
func (m *computerMount) promptHint() string {
	if m == nil {
		return ""
	}
	return computerPromptHint(m.destination())
}

func (m *computerMount) destination() string {
	if m == nil {
		return computerOff
	}
	if m.target.ContainerName == "" {
		return computerCloud
	}
	return computerSandbox
}

// envPairs returns KEY=VALUE pairs for the bot CLI's environment. Codex
// passes env to MCP servers by name, so the values must exist on the
// parent; Claude gets them from the config entry too, which is harmless.
func (m *computerMount) envPairs() []string {
	if m == nil || len(m.Launch.Env) == 0 {
		return nil
	}
	keys := make([]string, 0, len(m.Launch.Env))
	for k := range m.Launch.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+m.Launch.Env[k])
	}
	return out
}

// codexOverrides mounts the same server for the Codex runner.
func (m *computerMount) codexOverrides() []string {
	if m == nil {
		return nil
	}
	quotedArgs := make([]string, 0, len(m.Launch.Args))
	for _, a := range m.Launch.Args {
		quotedArgs = append(quotedArgs, tomlQuote(a))
	}
	keys := make([]string, 0, len(m.Launch.Env))
	for k := range m.Launch.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return []string{
		fmt.Sprintf(`mcp_servers.computer.command=%s`, tomlQuote(m.Launch.Command)),
		`mcp_servers.computer.args=[` + strings.Join(quotedArgs, ",") + `]`,
		fmt.Sprintf(`mcp_servers.computer.env_vars=%s`, tomlStringArray(keys)),
	}
}
