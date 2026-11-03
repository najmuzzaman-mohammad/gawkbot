package team

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Messaging a terminal session: the three commands, and nothing else.
//
// A session member is a Claude Code or Codex session the person opened in
// their own terminal. Messaging it from here runs the person's own tool on
// the person's own session, in the person's own folder, with the person's
// own settings and permissions. So these commands are deliberately NOT the
// office's runner commands: no permission or sandbox bypass, no model, no
// system prompt, no MCP config, and none of the office's WUPHF_* variables,
// which would hand a session the office's broker token.
//
// What the tools allow was observed in docs/specs/session-bots.md:
//
//   - Claude Code: `claude -p --resume <id>` keeps the id and appends to the
//     same log. Run against a session that is OPEN in a terminal it is
//     accepted in silence and forks the conversation inside the same file,
//     so it may run only when the session is KNOWN to be closed.
//   - Codex: `codex exec resume <id>` does the same for an ended session and
//     refuses, "already has an active writer", for an open one; then
//     `codex queue --thread <id> --message <text>` delivers to the open
//     window as a real user prompt.
//
// The builders are pure: they return what would run and run nothing, so a
// test can assert the exact argv and the absence of every forbidden flag.

const (
	sessionToolClaude = "claude-code"
	sessionToolCodex  = "codex"

	// codexActiveWriterRefusal is what `codex exec resume` says when the
	// session is open in a terminal. Matched together with a failed exit.
	codexActiveWriterRefusal = "already has an active writer"

	// sessionEnvStripPrefix is the office's own namespace. Nothing in it may
	// reach a person's session: WUPHF_BROKER_TOKEN is the office's authority.
	sessionEnvStripPrefix = "WUPHF_"
)

// Variables, not constants, only so a test can shorten them.
var (
	// sessionTurnTimeout is how long a background resume may run before its
	// process group is killed. The office's own default turn budget.
	sessionTurnTimeout = 15 * time.Minute
	// sessionQueueTimeout bounds `codex queue`, which only hands the message
	// to the open window and returns.
	sessionQueueTimeout = 60 * time.Second
)

// sessionTurnCommand is one command, ready to run without a shell: Name is
// resolved through PATH exactly as the office's own runners resolve it, the
// prompt travels on Stdin or as a single argv element, and Dir is the
// session's own folder.
type sessionTurnCommand struct {
	Name  string
	Args  []string
	Env   []string
	Dir   string
	Stdin string
}

// sessionForbiddenArgs are flags no session command may carry, whatever a
// later edit does to the builders: each one widens what the tool may do
// beyond what the person set up, or replaces the session's own context.
var sessionForbiddenArgs = []string{
	"--dangerously-skip-permissions",
	"--permission-mode",
	"bypassPermissions",
	"--setting-sources",
	"--mcp-config",
	"--strict-mcp-config",
	"--append-system-prompt",
	"--append-system-prompt-file",
	"--system-prompt",
	"--model",
	"-m",
	"--dangerously-bypass-approvals-and-sandbox",
	"--dangerously-bypass-hook-trust",
	"--full-auto",
	"--yolo",
	"-a",
	"--ask-for-approval",
	"-s",
	"--sandbox",
	"-c",
	"--config",
}

// sessionForbiddenArg returns the first forbidden flag in args, or "".
func sessionForbiddenArg(args []string) string {
	for _, arg := range args {
		if containsString(sessionForbiddenArgs, arg) {
			return arg
		}
	}
	return ""
}

// claudeSessionResumeCommand resumes a closed Claude Code session with one
// message. The prompt is the whole of stdin, never an argument, so a message
// that starts with a dash cannot be read as a flag.
func claudeSessionResumeCommand(nativeID, dir, prompt string, inherited []string) (sessionTurnCommand, error) {
	if err := validateSessionCommandInput(nativeID, dir, prompt); err != nil {
		return sessionTurnCommand{}, err
	}
	return sessionTurnCommand{
		Name: "claude",
		Args: []string{
			"--print",
			"--resume", nativeID,
			"--output-format", "stream-json",
			"--verbose",
		},
		Env:   sessionCommandEnv(inherited, dir),
		Dir:   dir,
		Stdin: prompt,
	}, nil
}

// codexSessionResumeCommand resumes an ended Codex session with one message.
// The trailing "-" tells Codex to read the prompt from stdin.
func codexSessionResumeCommand(nativeID, dir, prompt string, inherited []string) (sessionTurnCommand, error) {
	if err := validateSessionCommandInput(nativeID, dir, prompt); err != nil {
		return sessionTurnCommand{}, err
	}
	return sessionTurnCommand{
		Name:  "codex",
		Args:  []string{"exec", "--json", "resume", nativeID, "-"},
		Env:   sessionCommandEnv(inherited, dir),
		Dir:   dir,
		Stdin: prompt,
	}, nil
}

// codexSessionQueueCommand hands one message to a Codex session that is open
// in a terminal. The text rides in the same argv element as its flag, so a
// message that starts with a dash is still the message.
func codexSessionQueueCommand(nativeID, dir, prompt string, inherited []string) (sessionTurnCommand, error) {
	if err := validateSessionCommandInput(nativeID, dir, prompt); err != nil {
		return sessionTurnCommand{}, err
	}
	return sessionTurnCommand{
		Name: "codex",
		Args: []string{"queue", "--thread", nativeID, "--message=" + prompt},
		Env:  sessionCommandEnv(inherited, dir),
		Dir:  dir,
	}, nil
}

func validateSessionCommandInput(nativeID, dir, prompt string) error {
	// The id reaches argv: only the tool's own bare uuid is ever passed.
	if nativeID == "" || sessionNativeID(nativeID) != nativeID {
		return fmt.Errorf("session id %q is not a bare session uuid", nativeID)
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("session folder %q is not an absolute path", dir)
	}
	if strings.TrimSpace(prompt) == "" {
		return fmt.Errorf("the message is empty")
	}
	if strings.ContainsRune(prompt, 0) {
		return fmt.Errorf("the message holds a NUL byte")
	}
	return nil
}

// sessionCommandEnv is the environment a session command runs in: the
// person's own, as the office process inherited it (the runner passes
// gitexec.CleanEnv(), so git variables that describe the office process are
// already gone), minus what belongs to the office (every WUPHF_* variable),
// minus the Codex variables that name the office's own thread.
func sessionCommandEnv(inherited []string, dir string) []string {
	env := stripEnvKeys(inherited, headlessCodexEnvVarsToStrip)
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), sessionEnvStripPrefix) {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "PWD="+dir)
}

// sessionFolderState says whether a session's recorded folder can be worked
// in: it must be recorded, absolute, and a directory that exists now.
func sessionFolderState(cwd string) bool {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" || !filepath.IsAbs(cwd) {
		return false
	}
	info, err := os.Stat(cwd)
	return err == nil && info.IsDir()
}

// isCodexActiveWriterRefusal reports whether a failed `codex exec resume`
// failed because the session is open in a terminal. Both must hold: it
// exited with an error, and it said so. Anything else is a real failure and
// must never be taken as "open, so queue it".
func isCodexActiveWriterRefusal(exitErr error, output string) bool {
	return exitErr != nil && strings.Contains(strings.ToLower(output), codexActiveWriterRefusal)
}

// sessionReopenCommand is what the person types to open the session in
// their terminal again, for the note left after a background resume.
func sessionReopenCommand(tool, nativeID string) string {
	if tool == sessionToolCodex {
		return "codex resume " + nativeID
	}
	return "claude --resume " + nativeID
}
