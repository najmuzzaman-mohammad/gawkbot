// Package agentdetect finds the coding/agent CLIs installed and running on
// this machine (Claude Code, Codex, Opencode, Gemini CLI, Cursor CLI, Aider,
// Goose, Amp, ...) so the office can adopt each one as a gawkbot that the
// Chief of Staff routes work to.
//
// Detection is read-only: it resolves binaries, stats config directories,
// and lists processes. It never launches an agent, never reads credential
// files, and never touches the network.
package agentdetect

import "strings"

// Runtime describes how gawkbot can drive a detected agent.
type Runtime string

const (
	// RuntimeNative agents already have a first-class gawkbot provider
	// (claude-code, codex, opencode, ollama, ...). Adopting one creates a
	// bot bound to that provider kind.
	RuntimeNative Runtime = "native"
	// RuntimeCLI agents have a non-interactive "one prompt in, answer out"
	// mode. Adopting one creates a bot on the generic cli-agent provider,
	// which shells out to the agent's headless invocation each turn.
	RuntimeCLI Runtime = "cli"
	// RuntimeGateway agents (OpenClaw, Hermes) are long-running gateways
	// with their own bots. They are bridged through the Integrations app,
	// not adopted from here.
	RuntimeGateway Runtime = "gateway"
	// RuntimeApp agents are desktop IDEs with no headless mode gawkbot can
	// drive. They are reported so the user sees them, but cannot be adopted.
	RuntimeApp Runtime = "app"
)

// PromptPlaceholder is replaced with the full turn prompt in Headless.Args.
const PromptPlaceholder = "{prompt}"

// Headless is the non-interactive invocation of a RuntimeCLI agent.
type Headless struct {
	// Args is the argv after the binary. Exactly one element must be
	// PromptPlaceholder; it is replaced with the turn prompt verbatim (no
	// shell is involved, so no quoting is needed).
	Args []string
	// ModelFlag, when set, is passed as `<ModelFlag> <model>` before Args
	// when the bot's provider binding names a model.
	ModelFlag string
}

// Spec is one entry in the catalog of agents gawkbot knows how to detect.
type Spec struct {
	// ID is the stable identifier, also the default bot slug on adoption.
	ID     string
	Name   string
	Vendor string
	// Binaries are executable names resolved on PATH (plus the common
	// user/package-manager bin dirs runtimebin knows about). The first one
	// that resolves is the agent's binary.
	Binaries []string
	// ProcessMarkers are substrings that identify the agent in the argv of
	// an interpreter-hosted process (node/bun/python running the agent's
	// package), where argv[0] is the interpreter rather than the agent.
	ProcessMarkers []string
	// ConfigPaths are home-relative paths whose presence shows the agent
	// has been set up on this machine even if its binary is off PATH.
	ConfigPaths []string
	Runtime     Runtime
	// ProviderKind is the gawkbot provider kind for RuntimeNative agents.
	ProviderKind string
	Headless     *Headless
	InstallURL   string
	// Expertise seeds the adopted bot's expertise list.
	Expertise []string
	Note      string
}

// Adoptable reports whether the office can turn this agent into a bot
// directly (gateways and IDE apps cannot).
func (s Spec) Adoptable() bool {
	switch s.Runtime {
	case RuntimeNative:
		return s.ProviderKind != ""
	case RuntimeCLI:
		return s.Headless != nil
	default:
		return false
	}
}

var codingExpertise = []string{"coding", "debugging", "code review", "refactoring"}

// catalog is ordered by how the UI should list agents: the native runtimes
// first, then headless CLIs, then gateways, then IDE apps.
var catalog = []Spec{
	{
		ID: "claude-code", Name: "Claude Code", Vendor: "Anthropic",
		Binaries:       []string{"claude"},
		ProcessMarkers: []string{"@anthropic-ai/claude-code"},
		ConfigPaths:    []string{".claude", ".claude.json"},
		Runtime:        RuntimeNative, ProviderKind: "claude-code",
		InstallURL: "https://claude.ai/code",
		Expertise:  codingExpertise,
	},
	{
		ID: "codex", Name: "Codex CLI", Vendor: "OpenAI",
		Binaries:       []string{"codex"},
		ProcessMarkers: []string{"@openai/codex"},
		ConfigPaths:    []string{".codex"},
		Runtime:        RuntimeNative, ProviderKind: "codex",
		InstallURL: "https://github.com/openai/codex",
		Expertise:  codingExpertise,
	},
	{
		ID: "opencode", Name: "Opencode", Vendor: "SST",
		Binaries:       []string{"opencode"},
		ProcessMarkers: []string{"opencode-ai"},
		ConfigPaths:    []string{".config/opencode", ".local/share/opencode", ".opencode"},
		Runtime:        RuntimeNative, ProviderKind: "opencode",
		InstallURL: "https://opencode.ai",
		Expertise:  codingExpertise,
	},
	{
		ID: "gemini", Name: "Gemini CLI", Vendor: "Google",
		Binaries:       []string{"gemini"},
		ProcessMarkers: []string{"@google/gemini-cli"},
		ConfigPaths:    []string{".gemini"},
		Runtime:        RuntimeCLI,
		Headless:       &Headless{Args: []string{"-p", PromptPlaceholder}, ModelFlag: "-m"},
		InstallURL:     "https://github.com/google-gemini/gemini-cli",
		Expertise:      append([]string{"research"}, codingExpertise...),
	},
	{
		ID: "cursor-agent", Name: "Cursor CLI", Vendor: "Cursor",
		Binaries:   []string{"cursor-agent"},
		Runtime:    RuntimeCLI,
		Headless:   &Headless{Args: []string{"-p", PromptPlaceholder, "--output-format", "text"}, ModelFlag: "--model"},
		InstallURL: "https://cursor.com/cli",
		Expertise:  codingExpertise,
	},
	{
		ID: "qwen-code", Name: "Qwen Code", Vendor: "Alibaba",
		Binaries:       []string{"qwen"},
		ProcessMarkers: []string{"@qwen-code/qwen-code"},
		ConfigPaths:    []string{".qwen"},
		Runtime:        RuntimeCLI,
		Headless:       &Headless{Args: []string{"-p", PromptPlaceholder}, ModelFlag: "-m"},
		InstallURL:     "https://github.com/QwenLM/qwen-code",
		Expertise:      codingExpertise,
	},
	{
		ID: "copilot", Name: "GitHub Copilot CLI", Vendor: "GitHub",
		Binaries:       []string{"copilot"},
		ProcessMarkers: []string{"@github/copilot"},
		ConfigPaths:    []string{".copilot"},
		Runtime:        RuntimeCLI,
		Headless:       &Headless{Args: []string{"-p", PromptPlaceholder}, ModelFlag: "--model"},
		InstallURL:     "https://github.com/github/copilot-cli",
		Expertise:      codingExpertise,
	},
	{
		ID: "amp", Name: "Amp", Vendor: "Sourcegraph",
		Binaries:       []string{"amp"},
		ProcessMarkers: []string{"@sourcegraph/amp"},
		ConfigPaths:    []string{".config/amp"},
		Runtime:        RuntimeCLI,
		Headless:       &Headless{Args: []string{"-x", PromptPlaceholder}},
		InstallURL:     "https://ampcode.com",
		Expertise:      codingExpertise,
	},
	{
		ID: "goose", Name: "Goose", Vendor: "Block",
		Binaries:    []string{"goose"},
		ConfigPaths: []string{".config/goose"},
		Runtime:     RuntimeCLI,
		Headless:    &Headless{Args: []string{"run", "-t", PromptPlaceholder}},
		InstallURL:  "https://block.github.io/goose",
		Expertise:   append([]string{"automation"}, codingExpertise...),
	},
	{
		ID: "aider", Name: "Aider", Vendor: "Aider",
		Binaries:       []string{"aider"},
		ProcessMarkers: []string{"/bin/aider", "aider-chat"},
		ConfigPaths:    []string{".aider.conf.yml"},
		Runtime:        RuntimeCLI,
		// --no-auto-commits: the office owns commits through its approval
		// gate; aider committing on its own would bypass it.
		Headless:   &Headless{Args: []string{"--message", PromptPlaceholder, "--no-pretty", "--no-auto-commits"}, ModelFlag: "--model"},
		InstallURL: "https://aider.chat",
		Expertise:  codingExpertise,
	},
	{
		ID: "crush", Name: "Crush", Vendor: "Charm",
		Binaries:    []string{"crush"},
		ConfigPaths: []string{".config/crush", ".local/share/crush"},
		Runtime:     RuntimeCLI,
		Headless:    &Headless{Args: []string{"run", PromptPlaceholder}},
		InstallURL:  "https://github.com/charmbracelet/crush",
		Expertise:   codingExpertise,
	},
	{
		ID: "droid", Name: "Factory Droid", Vendor: "Factory",
		Binaries:    []string{"droid"},
		ConfigPaths: []string{".factory"},
		Runtime:     RuntimeCLI,
		Headless:    &Headless{Args: []string{"exec", PromptPlaceholder}},
		InstallURL:  "https://factory.ai",
		Expertise:   codingExpertise,
	},
	{
		ID: "ollama", Name: "Ollama", Vendor: "Ollama",
		Binaries:    []string{"ollama"},
		ConfigPaths: []string{".ollama"},
		Runtime:     RuntimeNative, ProviderKind: "ollama",
		InstallURL: "https://ollama.com",
		Expertise:  []string{"local models", "drafting"},
		Note:       "Runs on a local model; start `ollama serve` before the bot takes work.",
	},
	{
		ID: "mlx-lm", Name: "MLX-LM", Vendor: "Apple",
		Binaries: []string{"mlx_lm.server"},
		Runtime:  RuntimeNative, ProviderKind: "mlx-lm",
		InstallURL: "https://github.com/ml-explore/mlx-lm",
		Expertise:  []string{"local models", "drafting"},
	},
	{
		ID: "exo", Name: "Exo", Vendor: "Exo Labs",
		Binaries: []string{"exo"},
		Runtime:  RuntimeNative, ProviderKind: "exo",
		InstallURL: "https://github.com/exo-explore/exo",
		Expertise:  []string{"local models", "drafting"},
	},
	{
		ID: "openclaw", Name: "OpenClaw", Vendor: "OpenClaw",
		Binaries:    []string{"openclaw"},
		ConfigPaths: []string{".openclaw"},
		Runtime:     RuntimeGateway,
		InstallURL:  "https://openclaw.ai",
		Note:        "Gateway with its own bots. Bridge them from the Integrations app.",
	},
	{
		ID: "hermes", Name: "Hermes", Vendor: "Nous Research",
		Binaries:    []string{"hermes"},
		ConfigPaths: []string{".hermes"},
		Runtime:     RuntimeGateway,
		Note:        "Gateway with its own bots. Bridge them from the Integrations app.",
	},
	{
		ID: "cursor", Name: "Cursor", Vendor: "Cursor",
		Binaries:    []string{"cursor"},
		ConfigPaths: []string{".cursor"},
		Runtime:     RuntimeApp,
		InstallURL:  "https://cursor.com",
		Note:        "IDE with no headless mode. Install the Cursor CLI (cursor-agent) to adopt it.",
	},
	{
		ID: "windsurf", Name: "Windsurf", Vendor: "Windsurf",
		Binaries:    []string{"windsurf"},
		ConfigPaths: []string{".codeium/windsurf"},
		Runtime:     RuntimeApp,
		InstallURL:  "https://windsurf.com",
		Note:        "IDE with no headless mode gawkbot can drive.",
	},
}

// Catalog returns a copy of every agent spec gawkbot knows how to detect.
func Catalog() []Spec {
	out := make([]Spec, len(catalog))
	copy(out, catalog)
	return out
}

// Lookup returns the spec for id, or false when id is not in the catalog.
func Lookup(id string) (Spec, bool) {
	id = strings.ToLower(strings.TrimSpace(id))
	for _, s := range catalog {
		if s.ID == id {
			return s, true
		}
	}
	return Spec{}, false
}

// HeadlessArgv builds the argv (after the binary) for one headless turn of a
// RuntimeCLI agent. ok is false when the agent has no headless mode.
func (s Spec) HeadlessArgv(model, prompt string) (args []string, ok bool) {
	if s.Headless == nil {
		return nil, false
	}
	if m := strings.TrimSpace(model); m != "" && s.Headless.ModelFlag != "" {
		args = append(args, s.Headless.ModelFlag, m)
	}
	for _, a := range s.Headless.Args {
		if a == PromptPlaceholder {
			args = append(args, prompt)
			continue
		}
		args = append(args, a)
	}
	return args, true
}
