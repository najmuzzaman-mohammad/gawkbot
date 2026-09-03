package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/provider"
)

// cmdBot handles /bot with subcommands: list, <slug>, prompt, create, edit, remove
func cmdBot(ctx *SlashContext, args string) error {
	args = strings.TrimSpace(args)

	// No args or "list" → list all bots (uses BotService if available, else HTTP).
	if args == "" || args == "list" {
		return cmdBotList(ctx)
	}

	// Subcommand dispatch: first token = subcommand
	head := args
	rest := ""
	if i := strings.IndexAny(args, " \t"); i >= 0 {
		head = args[:i]
		rest = strings.TrimSpace(args[i+1:])
	}
	switch strings.ToLower(head) {
	case "prompt":
		return cmdBotPrompt(ctx, rest)
	case "create":
		return cmdBotCreate(ctx, rest)
	case "edit":
		return cmdBotEdit(ctx, rest)
	case "remove", "rm", "delete":
		return cmdBotRemove(ctx, rest)
	}

	// Otherwise treat the single argument as a slug lookup (inspect).
	if ctx.BotService == nil {
		ctx.AddMessage("system", "Bot service not available.")
		return nil
	}
	slug := args
	ma, ok := ctx.BotService.Get(slug)
	if !ok {
		ctx.AddMessage("system", fmt.Sprintf("Bot %q not found.", slug))
		return nil
	}
	info := fmt.Sprintf(
		"Bot: %s\nSlug:  %s\nPhase: %s\nExpertise: %s",
		ma.Config.Name, ma.Config.Slug, ma.State.Phase,
		strings.Join(ma.Config.Expertise, ", "),
	)
	ctx.AddMessage("system", info)
	return nil
}

type generatedBotTemplate struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	Expertise   []string `json:"expertise"`
	Personality string   `json:"personality"`
}

func cmdBotPrompt(ctx *SlashContext, args string) error {
	prompt := strings.TrimSpace(args)
	if prompt == "" {
		ctx.AddMessage("system", "usage: /bot prompt <describe the teammate you want>")
		return nil
	}
	tmpl, err := brokerGenerateOfficeMember(prompt)
	if err != nil {
		ctx.AddMessage("system", fmt.Sprintf("Prompt failed: %v", err))
		return nil
	}
	body := map[string]any{
		"action":     "create",
		"slug":       tmpl.Slug,
		"name":       tmpl.Name,
		"role":       tmpl.Role,
		"expertise":  tmpl.Expertise,
		"created_by": "slash",
	}
	if strings.TrimSpace(tmpl.Personality) != "" {
		body["personality"] = tmpl.Personality
	}
	if _, err := brokerPostOfficeMembers(body); err != nil {
		ctx.AddMessage("system", fmt.Sprintf("Create failed: %v", err))
		return nil
	}
	ctx.AddMessage("system", fmt.Sprintf("Created @%s from prompt.", tmpl.Slug))
	return nil
}

func cmdBotList(ctx *SlashContext) error {
	if ctx.BotService == nil {
		ctx.AddMessage("system", "Bot service not available.")
		return nil
	}
	bots := ctx.BotService.List()
	if len(bots) == 0 {
		ctx.AddMessage("system", "No bots running.")
		return nil
	}
	var sb strings.Builder
	sb.WriteString("Active bots:\n")
	for _, a := range bots {
		sb.WriteString(fmt.Sprintf("  • %s (%s) — %s\n", a.Config.Name, a.Config.Slug, a.State.Phase))
	}
	ctx.AddMessage("system", strings.TrimRight(sb.String(), "\n"))
	return nil
}

// cmdBotCreate handles /bot create <slug> --name=... --provider=... --model=...
func cmdBotCreate(ctx *SlashContext, args string) error {
	pos, flags := parseFlags(args)
	if len(pos) < 1 {
		ctx.AddMessage("system", "usage: /bot create <slug> --name <name> --provider <claude-code|codex|opencode|hermes-bot|openclaw-http|openclaw> [--model <m>] [--role <r>] [--personality <p>] [--session-key <k>] [--bot-id <id>]")
		return nil
	}
	slug := pos[0]
	providerKind := strings.TrimSpace(flags["provider"])
	if err := provider.ValidateKind(providerKind); err != nil {
		ctx.AddMessage("system", err.Error())
		return nil
	}

	body := map[string]any{
		"action":      "create",
		"slug":        slug,
		"name":        getFlagOr(flags, "name", slug),
		"role":        getFlag(flags, "role"),
		"personality": getFlag(flags, "personality"),
		"created_by":  "slash",
	}
	if providerKind != "" {
		body["provider"] = buildProviderPayload(providerKind, flags)
	}

	res, err := brokerPostOfficeMembers(body)
	if err != nil {
		ctx.AddMessage("system", fmt.Sprintf("Create failed: %v", err))
		return nil
	}
	ctx.AddMessage("system", fmt.Sprintf("Created @%s (provider=%s).", slug, describeProviderKind(providerKind)))
	_ = res
	return nil
}

// cmdBotEdit handles /bot edit <slug> [--provider=...] [--model=...] etc.
func cmdBotEdit(ctx *SlashContext, args string) error {
	pos, flags := parseFlags(args)
	if len(pos) < 1 {
		ctx.AddMessage("system", "usage: /bot edit <slug> [--provider X] [--model Y] [--name N] [--role R] [--personality P] [--session-key K]")
		return nil
	}
	slug := pos[0]
	body := map[string]any{"action": "update", "slug": slug}

	if v := strings.TrimSpace(flags["name"]); v != "" {
		body["name"] = v
	}
	if v := strings.TrimSpace(flags["role"]); v != "" {
		body["role"] = v
	}
	if v := strings.TrimSpace(flags["personality"]); v != "" {
		body["personality"] = v
	}
	if providerKind, ok := flags["provider"]; ok {
		providerKind = strings.TrimSpace(providerKind)
		if err := provider.ValidateKind(providerKind); err != nil {
			ctx.AddMessage("system", err.Error())
			return nil
		}
		body["provider"] = buildProviderPayload(providerKind, flags)
	}

	if _, err := brokerPostOfficeMembers(body); err != nil {
		ctx.AddMessage("system", fmt.Sprintf("Edit failed: %v", err))
		return nil
	}
	ctx.AddMessage("system", fmt.Sprintf("Updated @%s.", slug))
	return nil
}

// cmdBotRemove handles /bot remove <slug>
func cmdBotRemove(ctx *SlashContext, args string) error {
	pos, _ := parseFlags(args)
	if len(pos) < 1 {
		ctx.AddMessage("system", "usage: /bot remove <slug>")
		return nil
	}
	slug := pos[0]
	body := map[string]any{"action": "remove", "slug": slug}
	if _, err := brokerPostOfficeMembers(body); err != nil {
		ctx.AddMessage("system", fmt.Sprintf("Remove failed: %v", err))
		return nil
	}
	ctx.AddMessage("system", fmt.Sprintf("Removed @%s.", slug))
	return nil
}

// buildProviderPayload assembles the provider block for a /office-members POST.
// For openclaw, it optionally threads through an explicit session_key + agent_id;
// leaving both empty triggers broker-side auto-create on sessions.create.
func buildProviderPayload(kind string, flags map[string]string) map[string]any {
	p := map[string]any{"kind": kind, "model": strings.TrimSpace(flags["model"])}
	if kind == provider.KindOpenclaw {
		oc := map[string]any{}
		if v := strings.TrimSpace(flags["session-key"]); v != "" {
			oc["session_key"] = v
		}
		if v := strings.TrimSpace(flags["agent-id"]); v != "" {
			oc["agent_id"] = v
		}
		p["openclaw"] = oc
	}
	return p
}

func describeProviderKind(kind string) string {
	if kind == "" {
		return "install-default"
	}
	return kind
}

// brokerPostOfficeMembers POSTs body JSON to the broker's /office-members endpoint
// using the same env-based auth the MCP server does. Returns the decoded JSON
// response on success.
func brokerPostOfficeMembers(body map[string]any) (map[string]any, error) {
	base := resolveBrokerBaseURL()
	token := resolveBrokerToken()
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal body: %w", err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, base+"/office-members", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("%d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out, nil
}

func brokerGenerateOfficeMember(prompt string) (generatedBotTemplate, error) {
	base := resolveBrokerBaseURL()
	token := resolveBrokerToken()
	data, err := json.Marshal(map[string]string{"prompt": prompt})
	if err != nil {
		return generatedBotTemplate{}, fmt.Errorf("marshal body: %w", err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, base+"/office-members/generate", bytes.NewReader(data))
	if err != nil {
		return generatedBotTemplate{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return generatedBotTemplate{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return generatedBotTemplate{}, fmt.Errorf("broker %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var tmpl generatedBotTemplate
	if err := json.NewDecoder(resp.Body).Decode(&tmpl); err != nil {
		return generatedBotTemplate{}, err
	}
	return tmpl, nil
}

func resolveBrokerBaseURL() string {
	if v := strings.TrimSpace(os.Getenv("WUPHF_TEAM_BROKER_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	if v := strings.TrimSpace(os.Getenv("NEX_TEAM_BROKER_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://127.0.0.1:18779"
}

func resolveBrokerToken() string {
	if v := strings.TrimSpace(os.Getenv("WUPHF_BROKER_TOKEN")); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("NEX_BROKER_TOKEN")); v != "" {
		return v
	}
	if path := strings.TrimSpace(os.Getenv("WUPHF_BROKER_TOKEN_FILE")); path != "" {
		if raw, err := os.ReadFile(path); err == nil {
			return strings.TrimSpace(string(raw))
		}
	}
	return ""
}
