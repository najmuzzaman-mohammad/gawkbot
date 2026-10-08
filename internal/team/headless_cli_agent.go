package team

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/provider"
	"github.com/nex-crm/wuphf/internal/runtimebin"
)

// Test hooks for the generic CLI-agent runtime.
var (
	headlessCLIAgentLookPath       = runtimebin.LookPath
	headlessCLIAgentCommandContext = exec.CommandContext
)

// HeadlessProviderCLIAgent tags headless events from cli-agent turns.
const HeadlessProviderCLIAgent = "cli-agent"

// cliAgentRuntimeNote is appended to the system prompt: the shared prompt
// builder describes office MCP tools, which a third-party CLI does not have.
const cliAgentRuntimeNote = "\n\nRUNTIME NOTE: you are running through a command-line agent without the office tools. " +
	"Do not try to call team_* tools. Do the work in your working directory if it needs files, " +
	"then reply with your final answer as plain text; it is posted to the channel for you."

// resolveCLIAgentBinary returns the catalog spec and resolved binary path for
// a cli-agent binding.
func resolveCLIAgentBinary(binding provider.ProviderBinding) (agentdetect.Spec, string, error) {
	if binding.CLIAgent == nil || strings.TrimSpace(binding.CLIAgent.Agent) == "" {
		return agentdetect.Spec{}, "", fmt.Errorf("cli-agent binding names no agent")
	}
	spec, ok := agentdetect.Lookup(binding.CLIAgent.Agent)
	if !ok || spec.Headless == nil {
		return agentdetect.Spec{}, "", fmt.Errorf("cli-agent %q has no headless mode gawkbot can drive", binding.CLIAgent.Agent)
	}
	for _, bin := range spec.Binaries {
		if path, err := headlessCLIAgentLookPath(bin); err == nil {
			return spec, path, nil
		}
	}
	return spec, "", fmt.Errorf("%s not found on this machine (looked for %s)", spec.Name, strings.Join(spec.Binaries, ", "))
}

// runHeadlessCLIAgentTurn runs one turn for a bot adopted from an agent CLI
// detected on this machine (Gemini CLI, Aider, Goose, ...). The agent gets
// the full work packet as one prompt through its non-interactive mode and
// its stdout is the reply. These CLIs have no wuphf MCP wiring, so the bot
// cannot claim tasks or call office tools itself: the Chief of Staff
// delegates to it by @mention and the reply is posted for it.
func (l *Launcher) runHeadlessCLIAgentTurn(ctx context.Context, slug string, notification string, channel ...string) error {
	if l == nil || l.broker == nil {
		return fmt.Errorf("broker is not running")
	}
	binding := l.broker.MemberProviderBinding(slug)
	spec, binPath, err := resolveCLIAgentBinary(binding)
	if err != nil {
		return err
	}

	workspaceDir, isTaskWorktree := l.headlessTurnWorkspace(slug, headlessTurnTaskID(ctx))
	promptText := buildHeadlessOpencodePrompt(l.buildPrompt(slug)+cliAgentRuntimeNote, notification)
	model := firstNonEmpty(l.taskModelForKind(ctx, slug, provider.KindCLIAgent), strings.TrimSpace(binding.Model))
	args, _ := spec.HeadlessArgv(model, promptText)
	cmd := headlessCLIAgentCommandContext(ctx, binPath, args...)
	cmd.Dir = workspaceDir

	// Same env shape as the Opencode runtime: broker/workspace plumbing from
	// the Codex builder, the user's real HOME so the agent finds its own
	// sign-in, and none of gawkbot's secrets — a third-party CLI that talks
	// to its own model backend never needs them.
	env := l.buildHeadlessCodexEnv(slug, workspaceDir, firstNonEmpty(channel...))
	env = setEnvValue(env, "WUPHF_HEADLESS_PROVIDER", HeadlessProviderCLIAgent)
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		env = setEnvValue(env, "HOME", home)
	}
	env = stripEnvKeys(env, []string{"CODEX_HOME", "WUPHF_BROKER_TOKEN"})
	env = stripEnvKeys(env, headlessOpencodeSecretEnvVars)
	// The Codex builder injects gawkbot's configured OpenAI key as
	// OPENAI_API_KEY. Give the agent exactly what the user's own shell had
	// instead: an agent that reads OPENAI_API_KEY (Aider) still works when
	// the user exported it, and gawkbot's stored key never leaks outward.
	if own, ok := os.LookupEnv("OPENAI_API_KEY"); ok {
		env = setEnvValue(env, "OPENAI_API_KEY", own)
	} else {
		env = stripEnvKeys(env, []string{"OPENAI_API_KEY"})
	}
	env = setEnvValue(env, "NO_COLOR", "1")
	if isTaskWorktree {
		env = append(env, "WUPHF_WORKTREE_PATH="+workspaceDir)
	}
	cmd.Env = env

	configureHeadlessProcess(cmd)
	dumpHeadlessCodexInvocation(slug, workspaceDir, args, cmd.Env, promptText)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("attach %s stdout: %w", spec.ID, err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr

	botStream := l.broker.BotStream(slug)
	taskID := l.turnTaskIDForCtx(ctx, slug)
	target := firstNonEmpty(channel...)
	turnID := newHeadlessTurnID()

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", spec.Name, err)
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			terminateHeadlessProcess(cmd)
			_ = stdout.Close()
		case <-done:
		}
	}()

	startedAt := time.Now()
	metrics := headlessProgressMetrics{TotalMs: -1, FirstEventMs: -1, FirstTextMs: -1, FirstToolMs: -1}
	l.updateHeadlessProgress(slug, "active", "thinking", "reviewing work packet in "+spec.Name, metrics)

	var out strings.Builder
	var firstTextAt time.Time
	scanErr := provider.DrainStreamLines(stdout, func(line string) {
		if out.Len() > 0 {
			out.WriteByte('\n')
		}
		out.WriteString(line)
		if strings.TrimSpace(line) == "" {
			return
		}
		if firstTextAt.IsZero() {
			firstTextAt = time.Now()
			metrics.FirstEventMs = durationMillis(startedAt, firstTextAt)
			metrics.FirstTextMs = metrics.FirstEventMs
			l.updateHeadlessProgress(slug, "active", "text", "drafting response", metrics)
		}
		if botStream != nil {
			botStream.PushTask(taskID, line)
		}
		emitHeadlessText(botStream, turnID, HeadlessProviderCLIAgent, slug, taskID, line+"\n", spec.ID+".stdout")
	})

	fail := func(detail string) {
		metrics.TotalMs = time.Since(startedAt).Milliseconds()
		appendHeadlessCodexLatency(slug, fmt.Sprintf("status=error provider=cli-agent agent=%s total_ms=%d detail=%q", spec.ID, metrics.TotalMs, detail))
		l.updateHeadlessProgress(slug, "error", "error", truncate(detail, 180), metrics)
		emitHeadlessTerminalWithTurn(botStream, turnID, HeadlessProviderCLIAgent, slug, taskID, "", detail, metrics, nil)
		emitHeadlessManifest(botStream, turnID, HeadlessProviderCLIAgent, slug, taskID, detail, nil, out.Len(), metrics, nil)
	}

	if err := cmd.Wait(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			fail(ctxErr.Error())
			return ctxErr
		}
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		appendHeadlessCodexLog(slug, spec.ID+"_stderr: "+detail)
		fail(detail)
		sysTarget := target
		if strings.TrimSpace(sysTarget) == "" {
			sysTarget = DMSlugFor(slug)
		}
		l.broker.PostSystemMessage(sysTarget,
			fmt.Sprintf("@%s (%s) failed: %s. Check that %s is signed in by running it once in a terminal.", slug, spec.Name, truncate(detail, 180), spec.Binaries[0]),
			"error",
		)
		return fmt.Errorf("%s: %w: %s", spec.ID, err, detail)
	}
	if scanErr != nil {
		fail(scanErr.Error())
		return scanErr
	}

	metrics.TotalMs = time.Since(startedAt).Milliseconds()
	text := strings.TrimSpace(out.String())
	appendHeadlessCodexLatency(slug, fmt.Sprintf("status=ok provider=cli-agent agent=%s total_ms=%d first_text_ms=%d final_chars=%d",
		spec.ID, metrics.TotalMs, durationMillis(startedAt, firstTextAt), len(text)))
	summary := "reply ready"
	if s := strings.TrimSpace(formatHeadlessLatencySummary(metrics)); s != "" {
		summary += " · " + s
	}
	l.updateHeadlessProgress(slug, "idle", "idle", summary, metrics)
	emitHeadlessTerminalWithTurn(botStream, turnID, HeadlessProviderCLIAgent, slug, taskID, summary, "", metrics, nil)
	emitHeadlessManifest(botStream, turnID, HeadlessProviderCLIAgent, slug, taskID, "", nil, len(text), metrics, nil)
	if text == "" {
		return fmt.Errorf("%s returned no output", spec.Name)
	}
	appendHeadlessCodexLog(slug, spec.ID+"_result: "+truncate(text, 2000))
	msg, posted, err := l.postHeadlessFinalMessageIfSilent(slug, target, notification, text, startedAt)
	if err != nil {
		appendHeadlessCodexLog(slug, spec.ID+"_post-error: "+err.Error())
		return err
	}
	if posted {
		appendHeadlessCodexLog(slug, fmt.Sprintf("%s_post: posted output to #%s as %s", spec.ID, msg.Channel, msg.ID))
	}
	return nil
}
