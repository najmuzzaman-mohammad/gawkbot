package team

import (
	"regexp"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/provider"
)

// Member runtime: what a bot actually runs on, resolved once on the server so
// every surface (web, notch, phone) draws the same badge on the avatar.
//
// The binding alone cannot answer that. Most bots have an empty binding and
// follow the install default, and a bot bound to a tool without a model runs
// whatever that tool defaults to. So the model is taken from the best evidence
// available, and Source says which:
//
//   - observed: the model the bot's last turn ran on
//   - binding:  the model pinned on the bot
//   - default:  what the runner would pick for a bot that has not run yet
//
// Model stays empty when none of those is known (a gateway bot, a CLI agent
// with no pinned model); the badge then shows the tool alone.

const (
	runtimeSourceObserved = "observed"
	runtimeSourceBinding  = "binding"
	runtimeSourceDefault  = "default"

	// Anthropic family defaults for a Claude Code bot with no pinned model.
	// headlessClaudeModel is the runner-side reader of the same two values.
	defaultClaudeModel     = "claude-sonnet-4-6"
	defaultClaudeLeadModel = "claude-opus-4-8"

	modelLabelMaxRunes = 24
)

// memberRuntimeInfo is the wire shape under "runtime" on an office-member
// list entry.
type memberRuntimeInfo struct {
	// Harness is the effective provider kind (the install default when the
	// binding is empty); HarnessName is its display name ("Claude Code").
	Harness     string `json:"harness"`
	HarnessName string `json:"harness_name,omitempty"`
	// Model is the raw model id; ModelLabel is the short form for a badge
	// ("Opus 5.5"); Family groups models for the badge glyph.
	Model      string `json:"model,omitempty"`
	ModelLabel string `json:"model_label,omitempty"`
	Family     string `json:"family,omitempty"`
	Source     string `json:"source,omitempty"`
}

// runtimeDefaults is the install-wide fallback for bots with an empty or
// model-less binding. It reads config files, so resolve it once per request
// and outside b.mu.
type runtimeDefaults struct {
	Kind   string
	Models map[string]string
}

func resolveRuntimeDefaults(cwd string) runtimeDefaults {
	return runtimeDefaults{
		Kind: config.ResolveLLMProvider(""),
		Models: map[string]string{
			provider.KindClaudeCode: defaultClaudeModel,
			provider.KindCodex:      strings.TrimSpace(config.ResolveCodexModel(cwd)),
			provider.KindOpencode:   strings.TrimSpace(config.ResolveOpencodeModel()),
		},
	}
}

// memberRuntime resolves what m runs on. observed is the model its last turn
// used ("" when it has not run since the broker started).
func memberRuntime(m officeMember, observed string, defaults runtimeDefaults) memberRuntimeInfo {
	kind := strings.TrimSpace(m.Provider.Kind)
	if kind == "" {
		kind = defaults.Kind
	}
	info := memberRuntimeInfo{Harness: kind, HarnessName: harnessDisplayName(m, kind)}
	switch {
	case strings.TrimSpace(observed) != "":
		info.Model, info.Source = strings.TrimSpace(observed), runtimeSourceObserved
	case strings.TrimSpace(m.Provider.Model) != "":
		info.Model, info.Source = strings.TrimSpace(m.Provider.Model), runtimeSourceBinding
	case defaults.Models[kind] != "":
		info.Model, info.Source = defaults.Models[kind], runtimeSourceDefault
	}
	info.ModelLabel, info.Family = modelLabel(info.Model)
	return info
}

// runtimeDefaultsTTL is how long cachedRuntimeDefaults reuses one read of the
// config files. The notch polls every couple of seconds; the install default
// changes when a person changes a setting.
const runtimeDefaultsTTL = 15 * time.Second

// cachedRuntimeDefaults is resolveRuntimeDefaults for a hot path. It takes
// its own lock, never b.mu, so call it before locking the broker.
func (b *Broker) cachedRuntimeDefaults(now time.Time) runtimeDefaults {
	b.runtimeDefaultsMu.Lock()
	defer b.runtimeDefaultsMu.Unlock()
	if b.runtimeDefaultsAt.IsZero() || now.Sub(b.runtimeDefaultsAt) > runtimeDefaultsTTL || now.Before(b.runtimeDefaultsAt) {
		b.runtimeDefaultsVal = resolveRuntimeDefaults("")
		b.runtimeDefaultsAt = now
	}
	return b.runtimeDefaultsVal
}

// sessionRuntime is the runtime of an agent session found on this machine.
// Its tool is known from which log it is; its model is whatever its own log
// last named, so it is always observed, never a guess.
func sessionRuntime(sess agentdetect.Session) *memberRuntimeInfo {
	info := memberRuntimeInfo{Harness: sess.Tool, HarnessName: sess.ToolName}
	if model := strings.TrimSpace(sess.Model); model != "" {
		info.Model, info.Source = model, runtimeSourceObserved
		info.ModelLabel, info.Family = modelLabel(model)
	}
	return &info
}

// harnessDisplayName is the name a person would call the tool: the detected
// agent for a CLI-agent bot, the catalog name for a native kind, and the kind
// itself when the catalog does not know it.
func harnessDisplayName(m officeMember, kind string) string {
	switch kind {
	case provider.KindCLIAgent:
		if m.Provider.CLIAgent != nil {
			if spec, ok := agentdetect.Lookup(m.Provider.CLIAgent.Agent); ok {
				return spec.Name
			}
		}
		return "Agent CLI"
	case provider.KindOpenclaw, provider.KindOpenclawHTTP:
		return "OpenClaw"
	case provider.KindHermesBot:
		return "Hermes"
	case provider.KindSlack:
		return "Slack"
	}
	return toolNameForKind(kind)
}

// RecordObservedModel notes the model slug's turn ran on, so the badge shows
// what the bot really used and not only what it is configured for. Kinds are
// ignored: some runners report their kind where a model is expected.
func (b *Broker) RecordObservedModel(slug, model string) {
	slug, model = strings.TrimSpace(slug), strings.TrimSpace(model)
	if slug == "" || model == "" || provider.ValidateKind(model) == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.observedModels == nil {
		b.observedModels = make(map[string]string)
	}
	b.observedModels[slug] = model
}

var (
	modelSuffixRe = regexp.MustCompile(`\[[^\]]*\]$`)
	modelDateRe   = regexp.MustCompile(`-(20\d{6}|latest)$`)
	// claude-<tier>-<major>[-<minor>] (current ids) and
	// claude-<major>[-<minor>]-<tier> (older ids).
	claudeTierFirstRe = regexp.MustCompile(`^claude-([a-z]+)-(\d+)(?:-(\d+))?$`)
	claudeTierLastRe  = regexp.MustCompile(`^claude-(\d+)(?:-(\d+))?-([a-z]+)$`)
	gptRe             = regexp.MustCompile(`^gpt-(\d+(?:\.\d+)?[a-z]?)(?:-(.+))?$`)
	oSeriesRe         = regexp.MustCompile(`^o\d+(?:-.+)?$`)
	geminiRe          = regexp.MustCompile(`^gemini-(\d+(?:\.\d+)?)(?:-(.+))?$`)
)

// modelLabel turns a model id into a short badge label and a family. It
// parses the id itself and never consults a model catalogue, so a model newer
// than this build still gets a correct label. An id it does not recognise is
// shown as it is, shortened, with an empty family.
func modelLabel(id string) (label, family string) {
	raw := strings.TrimSpace(id)
	if raw == "" {
		return "", ""
	}
	s := strings.ToLower(raw)
	if i := strings.LastIndex(s, "/"); i >= 0 { // "anthropic/claude-…" (Opencode)
		s, raw = s[i+1:], raw[i+1:]
	}
	s = modelSuffixRe.ReplaceAllString(s, "")
	s = modelDateRe.ReplaceAllString(s, "")
	switch {
	case claudeTierFirstRe.MatchString(s):
		m := claudeTierFirstRe.FindStringSubmatch(s)
		return titleWord(m[1]) + " " + joinVersion(m[2], m[3]), "claude"
	case claudeTierLastRe.MatchString(s):
		m := claudeTierLastRe.FindStringSubmatch(s)
		return titleWord(m[3]) + " " + joinVersion(m[1], m[2]), "claude"
	case gptRe.MatchString(s):
		m := gptRe.FindStringSubmatch(s)
		return strings.TrimSpace("GPT-" + m[1] + " " + titleWords(m[2])), "gpt"
	case oSeriesRe.MatchString(s):
		return s, "gpt"
	case geminiRe.MatchString(s):
		m := geminiRe.FindStringSubmatch(s)
		return strings.TrimSpace("Gemini " + m[1] + " " + titleWords(m[2])), "gemini"
	}
	return truncateRunes(modelSuffixRe.ReplaceAllString(raw, ""), modelLabelMaxRunes), ""
}

func joinVersion(major, minor string) string {
	if minor == "" {
		return major
	}
	return major + "." + minor
}

func titleWords(dashed string) string {
	parts := strings.Split(dashed, "-")
	for i, p := range parts {
		parts[i] = titleWord(p)
	}
	return strings.Join(parts, " ")
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}
