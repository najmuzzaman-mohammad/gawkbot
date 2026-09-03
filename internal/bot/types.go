package bot

import "context"

// BotPhase represents the lifecycle phase of a bot.
type BotPhase string

const (
	PhaseIdle         BotPhase = "idle"
	PhaseBuildContext BotPhase = "build_context"
	PhaseStreamLLM    BotPhase = "stream_llm"
	PhaseExecuteTool  BotPhase = "execute_tool"
	PhaseDone         BotPhase = "done"
	PhaseError        BotPhase = "error"
)

// BudgetLimit defines token and cost limits for a bot session.
type BudgetLimit struct {
	MaxTokens  int     `json:"maxTokens"`
	MaxCostUsd float64 `json:"maxCostUsd"`
}

// BotConfig holds static configuration for a bot template.
type BotConfig struct {
	Slug              string       `json:"slug,omitempty"`
	Name              string       `json:"name"`
	Expertise         []string     `json:"expertise"`
	Personality       string       `json:"personality,omitempty"`
	HeartbeatCron     string       `json:"heartbeatCron,omitempty"`
	Tools             []string     `json:"tools,omitempty"`
	Budget            *BudgetLimit `json:"budget,omitempty"`
	AutoDecideTimeout int          `json:"autoDecideTimeout,omitempty"`
	AllowedTools      []string     `json:"allowedTools,omitempty"`
}

// BotState holds the runtime state of a running bot.
type BotState struct {
	Phase         BotPhase  `json:"phase"`
	Config        BotConfig `json:"config"`
	SessionID     string    `json:"sessionId,omitempty"`
	CurrentTask   string    `json:"currentTask,omitempty"`
	TaskID        string    `json:"taskId,omitempty"`
	TokensUsed    int       `json:"tokensUsed"`
	CostUsd       float64   `json:"costUsd"`
	LastHeartbeat int64     `json:"lastHeartbeat,omitempty"`
	NextHeartbeat int64     `json:"nextHeartbeat,omitempty"`
	Error         string    `json:"error,omitempty"`
}

// BotTool is a named tool a bot can invoke.
type BotTool struct {
	Name        string
	Description string
	Schema      map[string]any
	Execute     func(params map[string]any, ctx context.Context, onUpdate func(string)) (string, error)
}

// ToolCall records a single tool invocation and its result.
type ToolCall struct {
	ToolName    string         `json:"toolName"`
	Params      map[string]any `json:"params"`
	Result      string         `json:"result,omitempty"`
	Error       string         `json:"error,omitempty"`
	StartedAt   int64          `json:"startedAt"`
	CompletedAt int64          `json:"completedAt,omitempty"`
}

// SessionEntry is one entry in a bot's session history.
type SessionEntry struct {
	ID        string         `json:"id"`
	ParentID  string         `json:"parentId,omitempty"`
	Type      string         `json:"type"` // "user" | "assistant" | "tool_call" | "tool_result" | "system"
	Content   string         `json:"content"`
	Timestamp int64          `json:"timestamp"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// Message is a single LLM conversation turn.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// StreamChunk is one piece of streamed output from the LLM.
// Type is one of: "text", "tool_call", "error", "thinking", "tool_use", "tool_result", "usage"
type StreamChunk struct {
	Type       string         `json:"type"`
	Content    string         `json:"content,omitempty"`
	ToolName   string         `json:"toolName,omitempty"`
	ToolParams map[string]any `json:"toolParams,omitempty"`
	ToolUseID  string         `json:"toolUseId,omitempty"` // for tool_use / tool_result correlation
	ToolInput  string         `json:"toolInput,omitempty"` // serialized tool input for display

	// Token counts on Type == "usage" chunks. Providers that surface usage
	// (Claude, OpenAI-compatible local servers with stream_options.include_usage,
	// etc) emit a single trailing chunk per turn with these fields populated.
	// Other chunk types leave them zero.
	InputTokens         int `json:"inputTokens,omitempty"`
	OutputTokens        int `json:"outputTokens,omitempty"`
	CacheReadTokens     int `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int `json:"cacheCreationTokens,omitempty"`
}

// StreamFn is a function that streams LLM output as a channel of chunks.
type StreamFn func(msgs []Message, tools []BotTool) <-chan StreamChunk

// EscalationReason tags why an escalation fired so the consumer can format
// the message consistently.
type EscalationReason string

const (
	EscalationStuck         EscalationReason = "stuck"          // no phase change for too many ticks
	EscalationMaxRetries    EscalationReason = "max_retries"    // PhaseError seen too many times for one task
	EscalationCapabilityGap EscalationReason = "capability_gap" // bot identified missing capability needed to proceed
)

// Escalator is a callback invoked when a bot can't make forward progress.
// The consumer should post a heads-up message to the team. Non-blocking from
// the loop's perspective — the loop calls it while holding no locks.
type Escalator func(botSlug, taskID string, reason EscalationReason, detail string)
