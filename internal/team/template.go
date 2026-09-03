package team

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/provider"
)

type generatedMemberTemplate struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	Expertise   []string `json:"expertise"`
	Personality string   `json:"personality"`
	// Provider and Model are CEO suggestions for the bot's runtime. The
	// BotWizard pre-fills its picker from these when the suggested
	// provider is in the install's registered LLM provider list (i.e. a
	// non-gateway kind). When absent or a gateway kind, the wizard falls
	// back to "Inherit default" — the human always gets the final pick
	// because the CEO can't reliably reason about local-runtime availability.
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
}

func (l *Launcher) GenerateMemberTemplateFromPrompt(request string) (generatedMemberTemplate, error) {
	request = strings.TrimSpace(request)
	if request == "" {
		return generatedMemberTemplate{}, fmt.Errorf("prompt is required")
	}
	if stub := strings.TrimSpace(os.Getenv("WUPHF_AGENT_TEMPLATE_STUB")); stub != "" {
		return parseGeneratedMemberTemplate(stub)
	}
	systemPrompt := l.buildPrompt(l.targeter().LeadSlug()) + `

You are designing a NEW office teammate template for WUPHF.
Return exactly one JSON object and nothing else.
Do not wrap it in markdown fences.
Do not explain your reasoning.

Required schema:
{
  "slug": "lowercase-hyphen-slug",
  "name": "Display Name",
  "role": "Role / title",
  "expertise": ["area", "area"],
  "personality": "one short paragraph",
  "provider": "claude-code | codex | opencode | mlx-lm | ollama | exo",
  "model": "runtime-specific model identifier or empty"
}

Constraints:
- Never use slug "ceo".
- Keep the teammate narrow and domain-specific.
- Pick a role that complements the existing office rather than overlapping heavily.
- If the prompt is vague, still make a crisp decision.
- "provider" is the LLM runtime the agent should run on. Pick one of:
  claude-code, codex, opencode (cloud) or mlx-lm, ollama, exo (local).
  Never suggest "openclaw", "openclaw-http", or "hermes-agent" — those are
  gateways for importing existing agents, not runtimes for new ones.
- "model" is the model identifier inside the chosen runtime (for example
  "claude-3-5-sonnet-latest" for claude-code, "gpt-4o" for codex,
  "llama3.1:8b" for ollama). Leave empty if you have no opinion — the
  runtime's default will be used.
- The human will confirm provider and model in the next step. Your job is
  to suggest a sensible default, not to lock the choice.
`
	userPrompt := "Design a new office teammate from this request:\n\n" + request
	raw, err := provider.RunConfiguredOneShot(systemPrompt, userPrompt, l.cwd)
	if err != nil {
		return generatedMemberTemplate{}, err
	}
	jsonText := extractJSONObjectString(raw)
	if jsonText == "" {
		jsonText = strings.TrimSpace(raw)
	}
	return parseGeneratedMemberTemplate(jsonText)
}

func parseGeneratedMemberTemplate(raw string) (generatedMemberTemplate, error) {
	var tmpl generatedMemberTemplate
	if err := json.Unmarshal([]byte(raw), &tmpl); err != nil {
		return generatedMemberTemplate{}, fmt.Errorf("parse generated bot template: %w", err)
	}
	// A generated MEMBER slug: actor normaliser, and reject on the raw value.
	// normalizeChannelSlug turned an empty generated slug into "general", so
	// the `== ""` rejection never fired and a model that returned no slug
	// minted a bot named after a channel. This one is PERSISTED once the
	// template is accepted.
	if strings.TrimSpace(tmpl.Slug) == "" {
		return generatedMemberTemplate{}, fmt.Errorf("generated invalid slug %q", tmpl.Slug)
	}
	tmpl.Slug = normalizeChannelSlug(tmpl.Slug)
	if tmpl.Slug == "ceo" {
		return generatedMemberTemplate{}, fmt.Errorf("generated invalid slug %q", tmpl.Slug)
	}
	if tmpl.Name == "" {
		tmpl.Name = humanizeSlug(tmpl.Slug)
	}
	if tmpl.Role == "" {
		tmpl.Role = tmpl.Name
	}
	if len(tmpl.Expertise) == 0 {
		tmpl.Expertise = inferOfficeExpertise(tmpl.Slug, tmpl.Role)
	}
	if tmpl.Personality == "" {
		tmpl.Personality = inferOfficePersonality(tmpl.Slug, tmpl.Role)
	}
	// Sanitize provider/model: drop suggestions that name a gateway kind so
	// the wizard never has to handle them. Per-bot gateway bindings are
	// established through the Integrations app, not through the CEO
	// template generator — the wizard's runtime picker only shows the
	// non-gateway registered LLM kinds.
	tmpl.Provider = strings.TrimSpace(strings.ToLower(tmpl.Provider))
	if provider.IsGatewayKind(tmpl.Provider) {
		tmpl.Provider = ""
		tmpl.Model = ""
	}
	tmpl.Model = strings.TrimSpace(tmpl.Model)
	return tmpl, nil
}

// GenerateBotFileFromContext authors a richer version of one prose
// instruction file (SOUL / OPERATIONS, or the office USER.md) for human review.
// It NEVER commits — the caller hands the result to the editor so the human
// approves it with a save. On any LLM failure it returns an error (the file
// already exists, so there is nothing to half-initialize); the UI surfaces it.
//
// Reuses the same one-shot provider call as member/channel generation. The
// WUPHF_AGENT_FILE_STUB env var short-circuits the model for tests.
func (l *Launcher) GenerateBotFileFromContext(ctx context.Context, relPath, hint string) (string, error) {
	if err := validateBotFilePath(relPath); err != nil {
		return "", err
	}
	relPath = strings.TrimSpace(relPath)

	var slug, name string
	if relPath == officeUserFileRel {
		name = "USER"
	} else {
		parts := strings.Split(relPath, "/") // bots/<slug>/<NAME>.md
		slug = parts[1]
		name = strings.TrimSuffix(parts[2], ".md")
	}
	if name != "USER" && !aiGeneratableFile(name) {
		return "", fmt.Errorf("AI generation is available only for SOUL, OPERATIONS, and USER; got %q", name)
	}

	if stub := strings.TrimSpace(os.Getenv("WUPHF_AGENT_FILE_STUB")); stub != "" {
		return stub, nil
	}

	leadSlug := l.targeter().LeadSlug()
	var info strings.Builder
	var example string
	if name == "USER" {
		if cb := strings.TrimSpace(config.CompanyContextBlock()); cb != "" {
			fmt.Fprintf(&info, "Company context:\n%s\n", cb)
		}
		example = renderOfficeUserFile()
	} else {
		member := l.officeMemberBySlug(slug)
		isLead := slug == leadSlug
		fmt.Fprintf(&info, "Bot: @%s\n", slug)
		if r := strings.TrimSpace(member.Role); r != "" {
			fmt.Fprintf(&info, "Role: %s\n", r)
		}
		if len(member.Expertise) > 0 {
			fmt.Fprintf(&info, "Expertise: %s\n", strings.Join(member.Expertise, ", "))
		}
		if p := strings.TrimSpace(member.Personality); p != "" {
			fmt.Fprintf(&info, "Persona: %s\n", p)
		}
		if isLead {
			info.WriteString("This bot is the team lead: it coordinates and delegates rather than doing all the work itself.\n")
		}
		example = renderBotFileContent(member, name, isLead)
	}

	systemPrompt := l.buildPrompt(leadSlug) + fmt.Sprintf(`

You are authoring the %s.md instruction file for a WUPHF office bot. This
file is loaded verbatim into the bot's system prompt, so write it as direct
second-person instructions to that bot ("You ...").

Purpose of %s.md: %s

Return ONLY the markdown body of the file. Do not wrap it in code fences and do
not explain your reasoning. Start with a level-1 heading.

Match the section structure and style of the current version below, but make
the content specific, vivid, and genuinely useful — not generic filler.

----- CURRENT VERSION -----
%s
---------------------------
`, name, name, botFilePurpose(name), example)

	var ub strings.Builder
	ub.WriteString(info.String())
	if hint = strings.TrimSpace(hint); hint != "" {
		fmt.Fprintf(&ub, "\nExtra guidance from the human:\n%s\n", hint)
	}
	fmt.Fprintf(&ub, "\nWrite the improved %s.md now.", name)

	raw, err := provider.RunConfiguredOneShotCtx(ctx, systemPrompt, ub.String(), l.cwd)
	if err != nil {
		return "", err
	}
	content := stripMarkdownFences(raw)
	if content == "" {
		return "", fmt.Errorf("model returned no content")
	}
	return content, nil
}

type generatedChannelTemplate struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Members     []string `json:"members"`
}

func (l *Launcher) GenerateChannelTemplateFromPrompt(request string) (generatedChannelTemplate, error) {
	return l.GenerateChannelTemplateFromPromptCtx(context.Background(), request)
}

func (l *Launcher) GenerateChannelTemplateFromPromptCtx(ctx context.Context, request string) (generatedChannelTemplate, error) {
	request = strings.TrimSpace(request)
	if request == "" {
		return generatedChannelTemplate{}, fmt.Errorf("prompt is required")
	}
	if stub := strings.TrimSpace(os.Getenv("WUPHF_CHANNEL_TEMPLATE_STUB")); stub != "" {
		return parseGeneratedChannelTemplate(stub)
	}
	systemPrompt := l.buildPrompt(l.targeter().LeadSlug()) + `

You are designing a NEW office channel for WUPHF.
Return exactly one JSON object and nothing else.
Do not wrap it in markdown fences.
Do not explain your reasoning.

Required schema:
{
  "slug": "lowercase-hyphen-slug",
  "name": "Display Name",
  "description": "One sentence explaining the channel purpose",
  "members": ["ceo", "relevant-member-slug"]
}

Constraints:
- Never use slug "general".
- Keep the channel focused on a specific topic or workstream.
- Always include "ceo" in members.
- Pick members that match the channel topic from the existing office roster.
- If the prompt is vague, still make a crisp decision.
`
	userPrompt := "Design a new office channel from this request:\n\n" + request
	raw, err := provider.RunConfiguredOneShotCtx(ctx, systemPrompt, userPrompt, l.cwd)
	if err != nil {
		return generatedChannelTemplate{}, err
	}
	jsonText := extractJSONObjectString(raw)
	if jsonText == "" {
		jsonText = strings.TrimSpace(raw)
	}
	return parseGeneratedChannelTemplate(jsonText)
}

func parseGeneratedChannelTemplate(raw string) (generatedChannelTemplate, error) {
	var tmpl generatedChannelTemplate
	if err := json.Unmarshal([]byte(raw), &tmpl); err != nil {
		return generatedChannelTemplate{}, fmt.Errorf("parse generated channel template: %w", err)
	}
	// This one IS a channel slug, so normalizeChannelSlug is correct and stays.
	// Only the emptiness test moves ahead of it. Behaviour is unchanged: an
	// empty generated slug normalised to "general" and was already rejected by
	// the second clause, so this is honest tidying rather than a bug fix — but
	// it stops the rejection depending on a coincidence between the lobby
	// fallback and the value this function happens to blacklist.
	if strings.TrimSpace(tmpl.Slug) == "" {
		return generatedChannelTemplate{}, fmt.Errorf("generated invalid slug %q", tmpl.Slug)
	}
	tmpl.Slug = normalizeChannelSlug(tmpl.Slug)
	if tmpl.Slug == GeneralChannelSlug {
		return generatedChannelTemplate{}, fmt.Errorf("generated invalid slug %q", tmpl.Slug)
	}
	if tmpl.Name == "" {
		tmpl.Name = humanizeSlug(tmpl.Slug)
	}
	if tmpl.Description == "" {
		tmpl.Description = defaultTeamChannelDescription(tmpl.Slug, tmpl.Name)
	}
	hasCEO := false
	for _, m := range tmpl.Members {
		if m == "ceo" {
			hasCEO = true
			break
		}
	}
	if !hasCEO {
		tmpl.Members = append([]string{"ceo"}, tmpl.Members...)
	}
	return tmpl, nil
}

func extractJSONObjectString(raw string) string {
	start := strings.Index(raw, "{")
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(raw); i++ {
		ch := raw[i]
		if escaped {
			escaped = false
			continue
		}
		if inString {
			if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return raw[start : i+1]
			}
		}
	}
	return ""
}
