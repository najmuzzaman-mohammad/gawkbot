package team

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

const testSessionNativeID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

// officeEnvForSessionTests is an environment as an office process has it:
// the person's own variables, plus the office's.
func officeEnvForSessionTests() []string {
	return []string{
		"PATH=/usr/bin:/bin",
		"HOME=/Users/me",
		"ANTHROPIC_API_KEY=person-key",
		"CODEX_HOME=/Users/me/.codex",
		"WUPHF_BROKER_TOKEN=office-secret",
		"WUPHF_AGENT_SLUG=cos",
		"WUPHF_BROKER_BASE_URL=http://127.0.0.1:1",
		"WUPHF_HEADLESS_PROVIDER=claude",
		"wuphf_lowercase=also-office",
		"CODEX_THREAD_ID=office-thread",
		"PWD=/somewhere/else",
	}
}

func TestSessionCommandsAreExactlyTheThreeObserved(t *testing.T) {
	dir := "/Users/me/shop"
	prompt := "Can you also bump the version?"
	cases := []struct {
		name      string
		build     func(id, dir, prompt string, env []string) (sessionTurnCommand, error)
		wantName  string
		wantArgs  []string
		wantStdin string
	}{
		{
			name: "claude resume", build: claudeSessionResumeCommand, wantName: "claude",
			wantArgs:  []string{"--print", "--resume", testSessionNativeID, "--output-format", "stream-json", "--verbose"},
			wantStdin: prompt,
		},
		{
			name: "codex resume", build: codexSessionResumeCommand, wantName: "codex",
			wantArgs:  []string{"exec", "--json", "resume", testSessionNativeID, "-"},
			wantStdin: prompt,
		},
		{
			name: "codex queue", build: codexSessionQueueCommand, wantName: "codex",
			wantArgs: []string{"queue", "--thread", testSessionNativeID, "--message=" + prompt},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd, err := tc.build(testSessionNativeID, dir, prompt, officeEnvForSessionTests())
			if err != nil {
				t.Fatalf("build: %v", err)
			}
			if cmd.Name != tc.wantName {
				t.Errorf("binary = %q, want %q (a bare name, resolved through PATH like the office's own runners)", cmd.Name, tc.wantName)
			}
			if !reflect.DeepEqual(cmd.Args, tc.wantArgs) {
				t.Errorf("argv = %q\nwant   %q", cmd.Args, tc.wantArgs)
			}
			if cmd.Stdin != tc.wantStdin {
				t.Errorf("stdin = %q, want %q", cmd.Stdin, tc.wantStdin)
			}
			if cmd.Dir != dir {
				t.Errorf("cwd = %q, want the session's own folder %q", cmd.Dir, dir)
			}
		})
	}
}

// The assertion every later edit to the builders must keep passing: no
// command to a person's session carries a flag that widens what the tool may
// do, or that replaces the session's own model, prompt, or settings.
func TestSessionCommandsCarryNoForbiddenFlag(t *testing.T) {
	if len(sessionForbiddenArgs) < 15 {
		t.Fatalf("the forbidden list holds %d flags; it has been cut down, and this test would pass on less", len(sessionForbiddenArgs))
	}
	for _, must := range []string{
		"--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--setting-sources",
		"--mcp-config", "--append-system-prompt", "--model", "--dangerously-bypass-approvals-and-sandbox",
		"--dangerously-bypass-hook-trust", "-a", "-s",
	} {
		if !containsString(sessionForbiddenArgs, must) {
			t.Fatalf("the forbidden list no longer names %q", must)
		}
	}
	builders := map[string]func(id, dir, prompt string, env []string) (sessionTurnCommand, error){
		"claude resume": claudeSessionResumeCommand,
		"codex resume":  codexSessionResumeCommand,
		"codex queue":   codexSessionQueueCommand,
	}
	// A message made of forbidden flags is still only a message.
	prompts := []string{"hello", "--dangerously-skip-permissions", "-a never --model gpt-x"}
	for name, build := range builders {
		for _, prompt := range prompts {
			cmd, err := build(testSessionNativeID, "/Users/me/shop", prompt, officeEnvForSessionTests())
			if err != nil {
				t.Fatalf("%s: build: %v", name, err)
			}
			for _, arg := range cmd.Args {
				if containsString(sessionForbiddenArgs, arg) {
					t.Errorf("%s with message %q: argv carries the forbidden %q: %q", name, prompt, arg, cmd.Args)
				}
			}
			// The message is never its own argv element, where a leading dash
			// would make it a flag: it is stdin, or fused to --message=.
			for _, arg := range cmd.Args {
				if arg == prompt {
					t.Errorf("%s: the message %q is a bare argv element: %q", name, prompt, cmd.Args)
				}
			}
			if cmd.Stdin != prompt && !containsString(cmd.Args, "--message="+prompt) {
				t.Errorf("%s: the message %q reached neither stdin nor --message=: argv %q stdin %q", name, prompt, cmd.Args, cmd.Stdin)
			}
		}
	}
}

func TestSessionCommandEnvDropsTheOfficeAndKeepsThePerson(t *testing.T) {
	builders := map[string]func(id, dir, prompt string, env []string) (sessionTurnCommand, error){
		"claude resume": claudeSessionResumeCommand,
		"codex resume":  codexSessionResumeCommand,
		"codex queue":   codexSessionQueueCommand,
	}
	for name, build := range builders {
		cmd, err := build(testSessionNativeID, "/Users/me/shop", "hello", officeEnvForSessionTests())
		if err != nil {
			t.Fatalf("%s: build: %v", name, err)
		}
		if len(cmd.Env) == 0 {
			t.Fatalf("%s: empty environment; the checks below would pass on nothing", name)
		}
		for _, kv := range cmd.Env {
			if strings.HasPrefix(strings.ToUpper(kv), "WUPHF_") {
				t.Errorf("%s: the office variable %q reached a person's session", name, kv)
			}
			if strings.Contains(kv, "office-secret") {
				t.Errorf("%s: the broker token reached a person's session in %q", name, kv)
			}
			if strings.HasPrefix(kv, "CODEX_THREAD_ID=") {
				t.Errorf("%s: the office's own Codex thread id was passed on: %q", name, kv)
			}
		}
		for _, keep := range []string{"PATH=/usr/bin:/bin", "HOME=/Users/me", "ANTHROPIC_API_KEY=person-key", "CODEX_HOME=/Users/me/.codex", "PWD=/Users/me/shop"} {
			if !containsString(cmd.Env, keep) {
				t.Errorf("%s: the person's own %q is missing from the environment %q", name, keep, cmd.Env)
			}
		}
		if containsString(cmd.Env, "PWD=/somewhere/else") {
			t.Errorf("%s: the office's own PWD was passed on", name)
		}
	}
}

func TestSessionCommandsRefuseWhatTheyCannotPassSafely(t *testing.T) {
	cases := []struct{ name, id, dir, prompt string }{
		{"an id that is not a bare uuid", "codex:rollout-" + testSessionNativeID, "/Users/me/shop", "hi"},
		{"an id with a flag in it", testSessionNativeID + " --model x", "/Users/me/shop", "hi"},
		{"no id", "", "/Users/me/shop", "hi"},
		{"a relative folder", testSessionNativeID, "shop", "hi"},
		{"no folder", testSessionNativeID, "", "hi"},
		{"an empty message", testSessionNativeID, "/Users/me/shop", "   "},
		{"a NUL in the message", testSessionNativeID, "/Users/me/shop", "hi\x00there"},
	}
	for _, tc := range cases {
		for name, build := range map[string]func(id, dir, prompt string, env []string) (sessionTurnCommand, error){
			"claude resume": claudeSessionResumeCommand, "codex resume": codexSessionResumeCommand, "codex queue": codexSessionQueueCommand,
		} {
			if cmd, err := build(tc.id, tc.dir, tc.prompt, nil); err == nil {
				t.Errorf("%s with %s: built %q, want a refusal", name, tc.name, cmd.Args)
			}
		}
	}
}

func TestCodexActiveWriterRefusalNeedsBothTheExitAndTheMessage(t *testing.T) {
	failed := errors.New("exit status 1")
	cases := []struct {
		name   string
		err    error
		output string
		want   bool
	}{
		{"failed and said so", failed, "Error: session 0199 already has an active writer", true},
		{"failed, said so in other case", failed, "ALREADY HAS AN ACTIVE WRITER", true},
		{"failed for another reason", failed, "Error: stream disconnected before completion", false},
		{"failed and said nothing", failed, "", false},
		{"said so but did not fail", nil, "already has an active writer", false},
	}
	for _, tc := range cases {
		if got := isCodexActiveWriterRefusal(tc.err, tc.output); got != tc.want {
			t.Errorf("%s: refusal = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestSessionReopenCommandNamesTheToolsOwnCommand(t *testing.T) {
	if got := sessionReopenCommand(sessionToolClaude, testSessionNativeID); got != "claude --resume "+testSessionNativeID {
		t.Errorf("claude: %q", got)
	}
	if got := sessionReopenCommand(sessionToolCodex, testSessionNativeID); got != "codex resume "+testSessionNativeID {
		t.Errorf("codex: %q", got)
	}
}
