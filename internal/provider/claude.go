package provider

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/bot"
)

// claudeEnvVarsToStrip are the env vars injected by Claude Code that must be
// removed so the child `claude` process does not detect a recursive invocation.
var claudeEnvVarsToStrip = []string{
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SESSION",
	"CLAUDE_CODE_PARENT_SESSION",
}

var (
	claudeLookPath         = exec.LookPath
	claudeCommand          = exec.Command
	claudeCommandContext   = exec.CommandContext
	claudeGetwd            = os.Getwd
	claudeConfigureProcess = configureClaudeProcess
)

// claudeStreamMsg is the NDJSON envelope emitted by `claude --output-format stream-json`.
type claudeStreamMsg struct {
	Type      string            `json:"type"`
	Subtype   string            `json:"subtype,omitempty"`
	SessionID string            `json:"session_id,omitempty"`
	Model     string            `json:"model,omitempty"`
	Message   *claudeMessage    `json:"message"`
	Result    string            `json:"result,omitempty"`
	Errors    []json.RawMessage `json:"errors,omitempty"`
	// Event carries the raw Anthropic streaming event when Type is
	// "stream_event" (emitted only under --include-partial-messages). Held as
	// RawMessage because the envelope covers many event shapes and we decode
	// just the delta ones.
	Event         json.RawMessage `json:"event,omitempty"`
	ToolUseResult *struct {
		Stdout string `json:"stdout,omitempty"`
		Stderr string `json:"stderr,omitempty"`
	} `json:"tool_use_result,omitempty"`
}

type claudeMessage struct {
	Content []claudeContentBlock `json:"content"`
}

// claudeStreamEvent is the subset of an Anthropic streaming event we act on:
// the incremental text/thinking deltas that let the office paint a reply as it
// is generated instead of after it is finished.
type claudeStreamEvent struct {
	Type  string `json:"type"`
	Delta *struct {
		Type     string `json:"type"`
		Text     string `json:"text,omitempty"`
		Thinking string `json:"thinking,omitempty"`
	} `json:"delta,omitempty"`
}

type claudeContentBlock struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Thinking string `json:"thinking,omitempty"`
	ID       string `json:"id,omitempty"`
	Name     string `json:"name,omitempty"`
	Input    any    `json:"input,omitempty"`
	Content  any    `json:"content,omitempty"` // for tool_result
}

type claudeAttemptResult struct {
	sessionID      string
	model          string
	exitErr        error
	stderr         string
	resultText     string
	errorMessages  []string
	unknownSession bool
	loginRequired  bool
}

func init() {
	Register(&Entry{
		Kind:       KindClaudeCode,
		StreamFn:   CreateClaudeCodeStreamFn,
		OneShot:    RunClaudeOneShot,
		OneShotCtx: RunClaudeOneShotCtx,
		Capabilities: Capabilities{
			PaneEligible:               true,
			SupportsOneShot:            true,
			RequiresClaudeSessionReset: true,
		},
	})
}

// CreateClaudeCodeStreamFn returns a StreamFn that runs the `claude` CLI and
// parses its NDJSON stream output.
func CreateClaudeCodeStreamFn(botSlug string) bot.StreamFn {
	sessionStore := getClaudeSessionStore()

	return func(msgs []bot.Message, tools []bot.BotTool) <-chan bot.StreamChunk {
		ch := make(chan bot.StreamChunk, 64)
		go func() {
			defer close(ch)

			if _, err := claudeLookPath("claude"); err != nil {
				ch <- bot.StreamChunk{Type: "error", Content: "Claude CLI not found. Run /init to choose a different provider."}
				return
			}

			cwd, err := claudeGetwd()
			if err != nil {
				ch <- bot.StreamChunk{Type: "error", Content: fmt.Sprintf("resolve working directory: %v", err)}
				return
			}

			systemPrompt, prompt := buildClaudePrompts(msgs)
			if prompt == "" {
				prompt = "Proceed with the task."
			}

			resumeID := sessionStore.resumeSessionID(botSlug, cwd)
			attempt := runClaudeAttempt(ch, prompt, systemPrompt, cwd, resumeID, false)
			if attempt.sessionID != "" {
				sessionStore.save(botSlug, attempt.sessionID, cwd)
			}
			if attempt.exitErr == nil {
				return
			}

			if resumeID != "" && attempt.unknownSession {
				sessionStore.clear(botSlug)
				ch <- bot.StreamChunk{
					Type:    "thinking",
					Content: fmt.Sprintf("%s session expired; retrying with a fresh Claude session.", botSlug),
				}
				retry := runClaudeAttempt(ch, prompt, systemPrompt, cwd, "", false)
				if retry.sessionID != "" {
					sessionStore.save(botSlug, retry.sessionID, cwd)
				}
				if retry.exitErr == nil {
					return
				}
				ch <- bot.StreamChunk{Type: "error", Content: describeClaudeAttemptFailure(retry)}
				return
			}

			ch <- bot.StreamChunk{Type: "error", Content: describeClaudeAttemptFailure(attempt)}
		}()
		return ch
	}
}

func runClaudeAttempt(ch chan<- bot.StreamChunk, prompt string, systemPrompt string, cwd string, resumeID string, oneShot bool) claudeAttemptResult {
	args := buildClaudeArgs(systemPrompt, resumeID, oneShot)
	cmd := claudeCommand("claude", args...)
	return runClaudeAttemptCommand(context.Background(), cmd, ch, prompt, cwd)
}

func runClaudeAttemptCtx(ctx context.Context, ch chan<- bot.StreamChunk, prompt string, systemPrompt string, cwd string, resumeID string, oneShot bool) claudeAttemptResult {
	args := buildClaudeArgs(systemPrompt, resumeID, oneShot)
	cmd := claudeCommandContext(ctx, "claude", args...)
	return runClaudeAttemptCommand(ctx, cmd, ch, prompt, cwd)
}

func runClaudeAttemptCommand(ctx context.Context, cmd *exec.Cmd, ch chan<- bot.StreamChunk, prompt string, cwd string) claudeAttemptResult {
	cmd.Dir = cwd
	cmd.Env = filteredEnv(claudeEnvVarsToStrip)
	cmd.Stdin = strings.NewReader(prompt)
	claudeConfigureProcess(cmd)

	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return claudeAttemptResult{exitErr: fmt.Errorf("pipe: %w", err)}
	}
	if err := cmd.Start(); err != nil {
		return claudeAttemptResult{exitErr: fmt.Errorf("start claude: %w", err)}
	}
	result, scanErr := consumeClaudeStream(stdout, ch)

	if err := scanErr; err != nil {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		if ctxErr := ctx.Err(); ctxErr != nil {
			result.exitErr = ctxErr
		} else {
			result.exitErr = fmt.Errorf("scan: %w", err)
		}
		result.stderr = strings.TrimSpace(stderrBuf.String())
		return result
	}

	result.exitErr = cmd.Wait()
	if result.exitErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			result.exitErr = ctxErr
		}
	}
	result.stderr = strings.TrimSpace(stderrBuf.String())
	result.loginRequired = isClaudeLoginRequired(result)
	result.unknownSession = isClaudeUnknownSessionFailure(result)
	return result
}

func buildClaudeArgs(systemPrompt string, resumeID string, oneShot bool) []string {
	// A one-shot call (the workspace judge: workflow/app detection + acceptance)
	// does pure generation — it must emit JSON and nothing else. A bot turn
	// needs many turns and tools; a judge needs neither, and must NOT, since its
	// prompt can carry untrusted transcript content that could otherwise steer it
	// to execute a built-in tool (Bash/Write/…) before any human sees the output.
	//
	// 20 was too tight for a real app build: the App Builder spends turns
	// exploring the scaffold, reading AI_RULES/DESIGN, and writing the app BEFORE
	// it can `bun install` + `vite build` + register_app. A complex app (e.g. a
	// Gmail+ai digest) exhausts 20 turns mid-build and never publishes, then the
	// task stalls holding the single worker. 50 gives one dispatch enough headroom
	// to reach publish.
	maxTurns := "50"
	if oneShot {
		maxTurns = "1"
	}
	args := []string{
		"--print", "-",
		"--output-format", "stream-json",
		// Emit token-level deltas. Without this the CLI only emits an event
		// per COMPLETED assistant message, so the office showed a "Working…"
		// pill and nothing else until the whole first message was done — and
		// because the first message is required to be a team_task tool call
		// (prompt_builder's RULE ZERO), the human's first visible text only
		// arrived after a full tool round-trip. Measured ~1 min of dead air on
		// a first question. Deltas make the reply paint as it generates.
		"--include-partial-messages",
		"--verbose",
		"--max-turns", maxTurns,
		"--disable-slash-commands",
		"--strict-mcp-config",
		"--setting-sources", "user",
	}
	if oneShot {
		// Empty allow-list = no tools at all. --strict-mcp-config with no
		// --mcp-config already blocks MCP servers; this also blocks the built-in
		// tools, so a prompt-injected judge cannot touch the filesystem or shell.
		args = append(args, "--allowedTools", "")
	}
	if shouldUseClaudeBareMode() {
		args = append(args, "--bare")
	}
	if resumeID != "" {
		args = append(args, "--resume", resumeID)
	}
	if systemPrompt != "" {
		args = append(args, "--system-prompt", systemPrompt)
	}
	return args
}

func shouldUseClaudeBareMode() bool {
	return strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")) != ""
}

func formatClaudeToolResult(value any) string {
	resultStr := ""
	switch v := value.(type) {
	case string:
		resultStr = v
	default:
		b, _ := json.Marshal(v)
		resultStr = string(b)
	}
	return truncateClaudeOutput(resultStr)
}

func truncateClaudeOutput(value string) string {
	if len(value) > 500 {
		return value[:500] + "..."
	}
	return value
}

func parseClaudeErrors(rawErrors []json.RawMessage) []string {
	messages := make([]string, 0, len(rawErrors))
	for _, raw := range rawErrors {
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			text = strings.TrimSpace(text)
			if text != "" {
				messages = append(messages, text)
			}
			continue
		}

		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			continue
		}
		for _, key := range []string{"message", "error", "code"} {
			value, ok := obj[key].(string)
			if !ok {
				continue
			}
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			messages = append(messages, value)
			break
		}
	}
	return messages
}

func isClaudeUnknownSessionFailure(result claudeAttemptResult) bool {
	messages := append([]string{result.resultText}, result.errorMessages...)
	for _, message := range messages {
		text := strings.ToLower(strings.TrimSpace(message))
		if strings.Contains(text, "no conversation found with session id") ||
			strings.Contains(text, "unknown session") ||
			(strings.Contains(text, "session") && strings.Contains(text, "not found")) {
			return true
		}
	}
	return false
}

func isClaudeLoginRequired(result claudeAttemptResult) bool {
	messages := append([]string{result.resultText}, result.errorMessages...)
	if result.stderr != "" {
		messages = append(messages, result.stderr)
	}
	text := strings.ToLower(strings.Join(messages, "\n"))
	return strings.Contains(text, "not logged in") ||
		strings.Contains(text, "please log in") ||
		strings.Contains(text, "please run `claude login`") ||
		strings.Contains(text, "please run claude login") ||
		strings.Contains(text, "login required") ||
		strings.Contains(text, "requires login") ||
		strings.Contains(text, "unauthorized") ||
		strings.Contains(text, "authentication required")
}

func describeClaudeAttemptFailure(result claudeAttemptResult) string {
	if result.loginRequired {
		return "Claude CLI requires login. Run `claude login` or use /init to choose a different provider."
	}
	if result.stderr != "" {
		return fmt.Sprintf("claude exited with error: %v — %s", result.exitErr, result.stderr)
	}
	if len(result.errorMessages) > 0 {
		return fmt.Sprintf("claude exited with error: %v — %s", result.exitErr, result.errorMessages[0])
	}
	if result.resultText != "" {
		return fmt.Sprintf("claude exited with error: %v — %s", result.exitErr, result.resultText)
	}
	return fmt.Sprintf("claude exited with error: %v", result.exitErr)
}

// filteredEnv returns os.Environ() with the given keys removed.
func filteredEnv(strip []string) []string {
	stripSet := make(map[string]struct{}, len(strip))
	for _, k := range strip {
		stripSet[k] = struct{}{}
	}
	env := os.Environ()
	out := make([]string, 0, len(env))
	for _, kv := range env {
		key := kv
		if idx := strings.IndexByte(kv, '='); idx >= 0 {
			key = kv[:idx]
		}
		if _, skip := stripSet[key]; !skip {
			out = append(out, kv)
		}
	}
	return out
}

// buildClaudePrompts splits conversation history into a Claude system prompt and
// a printable conversation transcript for stdin-driven `claude --print -`.
func buildClaudePrompts(msgs []bot.Message) (systemPrompt string, prompt string) {
	var systemParts []string
	var sb strings.Builder
	for _, m := range msgs {
		if m.Role == "system" {
			systemParts = append(systemParts, m.Content)
			continue
		}
		sb.WriteString(m.Role)
		sb.WriteString(": ")
		sb.WriteString(m.Content)
		sb.WriteString("\n")
	}
	return strings.Join(systemParts, "\n\n"), strings.TrimRight(sb.String(), "\n")
}

func streamTextChunks(ch chan<- bot.StreamChunk, text string) {
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return
	}
	if len(text) <= 40 {
		ch <- bot.StreamChunk{Type: "text", Content: text}
		return
	}

	words := strings.Fields(text)
	if len(words) == 0 {
		ch <- bot.StreamChunk{Type: "text", Content: text}
		return
	}

	const wordsPerChunk = 5
	for i := 0; i < len(words); i += wordsPerChunk {
		end := i + wordsPerChunk
		if end > len(words) {
			end = len(words)
		}
		ch <- bot.StreamChunk{Type: "text", Content: strings.Join(words[i:end], " ")}
		if end < len(words) {
			time.Sleep(40 * time.Millisecond)
		}
	}
}

// consumeClaudeStream reads the CLI's NDJSON stdout and fans it out onto ch.
//
// Split out from runClaudeAttemptCommand so the stream contract can be tested
// against a plain io.Reader. Driving it through a real subprocess was flaky on
// CI — the child produced no output at all under the race suite — and a test
// for "which chunks does this NDJSON produce" has no business spawning a
// process to answer it.
func consumeClaudeStream(r io.Reader, ch chan<- bot.StreamChunk) (claudeAttemptResult, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	result := claudeAttemptResult{}
	gotAssistantText := false
	// Whether the CURRENT assistant message already reached the human as
	// token deltas. Guards against printing a block twice: once live, then
	// again when its completed form arrives.
	streamedText := false
	streamedThinking := false
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var msg claudeStreamMsg
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msg.SessionID != "" {
			result.sessionID = msg.SessionID
		}
		if msg.Model != "" {
			result.model = msg.Model
		}

		switch msg.Type {
		// Token-level deltas, emitted under --include-partial-messages. These
		// arrive BEFORE the completed "assistant" message for the same turn,
		// so they are what actually reaches the human first.
		case "stream_event":
			if len(msg.Event) == 0 {
				continue
			}
			var ev claudeStreamEvent
			if err := json.Unmarshal(msg.Event, &ev); err != nil {
				continue
			}
			if ev.Type != "content_block_delta" || ev.Delta == nil {
				continue
			}
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					ch <- bot.StreamChunk{Type: "text", Content: ev.Delta.Text}
					streamedText = true
					gotAssistantText = true
				}
			case "thinking_delta":
				if ev.Delta.Thinking != "" {
					ch <- bot.StreamChunk{Type: "thinking", Content: ev.Delta.Thinking}
					streamedThinking = true
				}
			}
		case "assistant":
			if msg.Message == nil {
				continue
			}
			for _, block := range msg.Message.Content {
				switch block.Type {
				case "thinking":
					// Already painted delta-by-delta above; re-emitting the
					// completed block would print the whole thing twice.
					if block.Thinking != "" && !streamedThinking {
						ch <- bot.StreamChunk{Type: "thinking", Content: block.Thinking}
					}
				case "text":
					if block.Text != "" {
						if !streamedText {
							streamTextChunks(ch, block.Text)
						}
						gotAssistantText = true
					}
				case "tool_use":
					inputJSON, _ := json.Marshal(block.Input)
					ch <- bot.StreamChunk{
						Type:      "tool_use",
						ToolName:  block.Name,
						ToolUseID: block.ID,
						ToolInput: string(inputJSON),
					}
				}
			}
			// One turn emits several assistant messages (a tool call, then
			// the reply). Each gets its own delta run, so the
			// already-streamed guards reset once a message is complete —
			// otherwise the first message's deltas would suppress every later
			// message's text.
			streamedText = false
			streamedThinking = false
		case "user":
			if msg.Message != nil {
				for _, block := range msg.Message.Content {
					if block.Type != "tool_result" {
						continue
					}
					resultStr := formatClaudeToolResult(block.Content)
					ch <- bot.StreamChunk{
						Type:      "tool_result",
						ToolUseID: block.ID,
						Content:   resultStr,
					}
				}
			}
			if msg.ToolUseResult != nil && msg.ToolUseResult.Stdout != "" {
				ch <- bot.StreamChunk{Type: "tool_result", Content: truncateClaudeOutput(msg.ToolUseResult.Stdout)}
			}
		case "result":
			if msg.Result != "" {
				result.resultText = msg.Result
				if !gotAssistantText && msg.Subtype != "error" {
					streamTextChunks(ch, msg.Result)
				}
			}
			result.errorMessages = append(result.errorMessages, parseClaudeErrors(msg.Errors)...)
		}
	}

	return result, scanner.Err()
}
