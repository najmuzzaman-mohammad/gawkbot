package team

// mcp_config.go owns the MCP server-config assembly used to wire the
// office broker's MCP endpoint into each bot's claude session
// (PLAN.md §C13). buildMCPServerMap composes the server entry,
// ensureMCPConfig writes the team-wide config file (with optional
// per-bot override via ensureBotMCPConfig), and botMCPServers
// maps slugs to allowed-server slugs. codingBotSlugs is the
// hardcoded "these slugs are coders, give them the broker MCP"
// allowlist.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/nex-crm/wuphf/internal/config"
)

// codingBotSlugs lists bots that default to a minimal coding-focused MCP set.
// Task-level local_worktree isolation is driven by execution_mode, not this list.
var codingBotSlugs = map[string]bool{
	"eng":       true,
	"fe":        true,
	"be":        true,
	"ai":        true,
	"qa":        true,
	"tech-lead": true,
}

// botMCPServers returns the MCP server keys that a given bot should receive.
func botMCPServers(_ string) []string {
	return ServerKeys()
}

// buildMCPServerMap constructs the full set of MCP server entries.
// This is the shared helper used by both ensureMCPConfig and ensureBotMCPConfig.
func (l *Launcher) buildMCPServerMap() (map[string]any, error) {
	servers := map[string]any{}
	wuphfBinary, err := os.Executable()
	if err != nil {
		return nil, err
	}

	office := map[string]any{
		"command": wuphfBinary,
		"args":    []string{"mcp-team"},
	}
	// Register the SAME entry under every key this runtime has ever published
	// under, canonical first. A tool permission the user granted is stored on
	// their disk as "mcp__<key>__<tool>"; drop a legacy key here and every one
	// of those silently stops matching, with no error naming the rename as the
	// cause and no way for us to reach the stale allowlist. An alias costs one
	// map entry. See mcp_namespace.go.
	for _, key := range ServerKeys() {
		servers[key] = office
	}
	if oneSecret := strings.TrimSpace(config.ResolveOneSecret()); oneSecret != "" {
		office["env"] = map[string]string{
			"ONE_SECRET": oneSecret,
		}
	}
	if identity := strings.TrimSpace(config.ResolveOneIdentity()); identity != "" {
		env, _ := office["env"].(map[string]string)
		if env == nil {
			env = map[string]string{}
		}
		env["ONE_IDENTITY"] = identity
		if identityType := strings.TrimSpace(config.ResolveOneIdentityType()); identityType != "" {
			env["ONE_IDENTITY_TYPE"] = identityType
		}
		office["env"] = env
	}

	switch config.ResolveMemoryBackend("") {
	case config.MemoryBackendGBrain:
		env, _ := office["env"].(map[string]string)
		if env == nil {
			env = map[string]string{}
		}
		for key, value := range gbrainMCPEnv() {
			env[key] = value
		}
		office["env"] = env
	}

	if memoryServer, err := resolvedMemoryMCPServer(); err != nil {
		return nil, err
	} else if memoryServer != nil && len(memoryServer.Env) > 0 {
		env, _ := office["env"].(map[string]string)
		if env == nil {
			env = map[string]string{}
		}
		for key, value := range memoryServer.Env {
			env[key] = value
		}
		office["env"] = env
	}

	return servers, nil
}

func (l *Launcher) ensureMCPConfig() (string, error) {
	servers, err := l.buildMCPServerMap()
	if err != nil {
		return "", err
	}

	cfg := map[string]any{
		"mcpServers": servers,
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}

	dir, err := l.launchTempDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "wuphf-team-mcp.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// ensureBotMCPConfig writes a per-bot MCP config containing only the servers
// that bot needs. Returns the config file path. The file lives under the
// per-launch temp directory (see writeBotPromptFile) so two offices can
// run the same slug without one clobbering the other's broker token.
func (l *Launcher) ensureBotMCPConfig(slug string) (string, error) {
	return l.ensureBotMCPConfigWith(slug, nil)
}

// ensureBotMCPConfigWith adds per-turn servers (today: the bot's
// "computer", see broker_computer_turn.go) on top of the office set.
func (l *Launcher) ensureBotMCPConfigWith(slug string, extra map[string]any) (string, error) {
	allServers, err := l.buildMCPServerMap()
	if err != nil {
		return "", err
	}

	allowed := botMCPServers(slug)
	filtered := make(map[string]any, len(allowed)+len(extra))
	for _, key := range allowed {
		if srv, ok := allServers[key]; ok {
			filtered[key] = srv
		}
	}
	for key, srv := range extra {
		filtered[key] = srv
	}

	cfg := map[string]any{
		"mcpServers": filtered,
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}

	dir, err := l.launchTempDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "wuphf-mcp-"+slug+".json")
	// Atomic write (temp + rename): a bot can now run several turns at once
	// (parallel instances), and they all target this one per-slug path. A plain
	// truncating WriteFile would let a concurrent turn's spawned process read a
	// half-written config. The content is identical per slug, so the rename just
	// guarantees readers always see a complete file.
	if err := atomicWriteFile(path, data); err != nil {
		return "", err
	}
	return path, nil
}
