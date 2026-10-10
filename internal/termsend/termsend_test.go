package termsend

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const me = 501

// fake answers each command from a table and records every call, so a test
// can say exactly what was typed and where.
type fake struct {
	calls []string
	// proc answers `ps ... -p <pid>` (uid tty pgid tpgid command), in order;
	// the last answer repeats.
	proc    []string
	procErr error
	// peers answers `ps ... -t <tty>` (pid pgid comm).
	peers   string
	panes   string
	noTmux  bool
	running map[string]bool
	scripts map[string]string
}

func (f *fake) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	switch name {
	case "ps":
		if args[len(args)-2] == "-t" {
			return []byte(f.peers), nil
		}
		if f.procErr != nil {
			return nil, f.procErr
		}
		out := f.proc[0]
		if len(f.proc) > 1 {
			f.proc = f.proc[1:]
		}
		return []byte(out), nil
	case "tmux":
		if f.noTmux {
			return nil, errors.New("no server running")
		}
		if args[0] == "list-panes" {
			return []byte(f.panes), nil
		}
		return nil, nil
	case "pgrep":
		if f.running[args[1]] {
			return []byte("123\n"), nil
		}
		return nil, errors.New("exit status 1")
	case "osascript":
		for process, answer := range f.scripts {
			if strings.Contains(args[1], `tell application "`+process+`"`) {
				return []byte(answer + "\n"), nil
			}
		}
		return []byte("none\n"), nil
	}
	return nil, errors.New("unexpected command " + name)
}

func (f *fake) typed() []string {
	var out []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, "tmux send-keys") || strings.HasPrefix(c, "osascript") {
			out = append(out, c)
		}
	}
	return out
}

func sender(f *fake) *Sender { return &Sender{Run: f.run, AppleScript: true, UID: me} }

var claude = Target{PID: 4100, Tool: ToolClaudeCode}

// A Claude Code process in front of its terminal, with its own helpers
// beside it in the same job.
const (
	claudeFront = "501 ttys003 4100 4100 /Users/me/.local/bin/claude --resume abc\n"
	helpers     = "4100 4100 /Users/me/.local/bin/claude\n4180 4100 /opt/homebrew/bin/node\n3999 3999 -zsh\n"
)

func TestSendTypesIntoTheTmuxPaneOnTheSessionsTTY(t *testing.T) {
	f := &fake{
		proc:  []string{claudeFront},
		peers: helpers,
		panes: "/dev/ttys001\t%0\t0\n/dev/ttys003\t%7\t0\n",
	}
	route, err := sender(f).Send(context.Background(), claude, "-n keep the clock freeze\nand push; Enter")
	if err != nil || route != RouteTmux {
		t.Fatalf("route %q err %v", route, err)
	}
	// One call carries the line and the Return, so the two cannot be split.
	want := []string{"tmux send-keys -t %7 -l -- -n keep the clock freeze and push; Enter\r"}
	if typed := f.typed(); len(typed) != 1 || typed[0] != want[0] {
		t.Fatalf("typed %q, want %q", typed, want)
	}
}

func TestSendUsesTerminalAppWhenTheTabIsThere(t *testing.T) {
	f := &fake{
		proc:    []string{claudeFront},
		peers:   helpers,
		noTmux:  true,
		running: map[string]bool{"Terminal": true},
		scripts: map[string]string{"Terminal": "typed"},
	}
	route, err := sender(f).Send(context.Background(), claude, `say "hi"; rm -rf ~`)
	if err != nil || route != RouteTerminal {
		t.Fatalf("route %q err %v", route, err)
	}
	typed := f.typed()
	if len(typed) != 1 {
		t.Fatalf("typed %q", typed)
	}
	// The device and the text are the script's arguments, after the script
	// itself: the message is never part of the AppleScript source.
	if !strings.HasSuffix(typed[0], ` /dev/ttys003 say "hi"; rm -rf ~`) {
		t.Fatalf("arguments: %q", typed[0])
	}
	for _, app := range appleScriptApps {
		if strings.Contains(app.script, "rm -rf") {
			t.Fatal("the message reached the script source")
		}
	}
}

func TestSendFallsThroughToITermAndNeverStartsAnApp(t *testing.T) {
	// Terminal is running but the tab is not in it; iTerm2 has it.
	f := &fake{
		proc:    []string{claudeFront},
		peers:   helpers,
		noTmux:  true,
		running: map[string]bool{"Terminal": true, "iTerm2": true},
		scripts: map[string]string{"Terminal": "none", "iTerm2": "typed"},
	}
	if route, err := sender(f).Send(context.Background(), claude, "go on"); err != nil || route != RouteITerm {
		t.Fatalf("route %q err %v", route, err)
	}

	// Neither app is running: nothing is scripted, so nothing is launched.
	quiet := &fake{proc: []string{claudeFront}, peers: helpers, noTmux: true}
	if _, err := sender(quiet).Send(context.Background(), claude, "go on"); !errors.Is(err, ErrNoRoute) {
		t.Fatalf("err %v, want ErrNoRoute", err)
	}
	if typed := quiet.typed(); len(typed) != 0 {
		t.Fatalf("scripted an app that is not running: %q", typed)
	}
}

// The reason this package is safe to have: text is typed only at the agent
// itself, never at a shell, a password prompt or anything else that would
// act on it.
func TestSendRefusesAnythingThatIsNotTheAgentReadingItsTerminal(t *testing.T) {
	pane := "/dev/ttys003\t%7\t0\n"
	cases := map[string]struct {
		f    *fake
		want error
	}{
		"the pid is a shell, in front of its own terminal": {
			f:    &fake{proc: []string{"501 ttys003 4100 4100 -zsh\n"}, peers: "4100 4100 -zsh\n", panes: pane},
			want: ErrNotAgent,
		},
		"the pid is sudo asking for a password": {
			f:    &fake{proc: []string{"0 ttys003 4100 4100 sudo -s\n"}, panes: pane},
			want: ErrNotAgent,
		},
		"the agent belongs to another user": {
			f:    &fake{proc: []string{"502 ttys003 4100 4100 /usr/local/bin/claude\n"}, peers: helpers, panes: pane},
			want: ErrNotAgent,
		},
		"a script that only has the agent's name in a later argument": {
			f:    &fake{proc: []string{"501 ttys003 4100 4100 node /tmp/evil.js claude\n"}, peers: helpers, panes: pane},
			want: ErrNotAgent,
		},
		"the agent is behind a shell": {
			f:    &fake{proc: []string{"501 ttys003 4100 4222 /usr/local/bin/claude\n"}, peers: helpers, panes: pane},
			want: ErrNotForeground,
		},
		"the agent started ssh, which reads the terminal now": {
			f:    &fake{proc: []string{claudeFront}, peers: helpers + "4300 4100 /usr/bin/ssh\n", panes: pane},
			want: ErrNotForeground,
		},
		"the agent is running a command in a shell of its own": {
			f:    &fake{proc: []string{claudeFront}, peers: helpers + "4301 4100 /bin/zsh\n", panes: pane},
			want: ErrNotForeground,
		},
		"it exits to a shell between the lookup and the typing": {
			f:    &fake{proc: []string{claudeFront, "501 ttys003 4100 4222 /usr/local/bin/claude\n"}, peers: helpers, panes: pane},
			want: ErrNotForeground,
		},
		"the pid is reused by a shell between the lookup and the typing": {
			f:    &fake{proc: []string{claudeFront, "501 ttys003 4100 4100 -zsh\n"}, peers: helpers, panes: pane},
			want: ErrNotAgent,
		},
		"its terminal changed under it": {
			f:    &fake{proc: []string{claudeFront, strings.Replace(claudeFront, "ttys003", "ttys008", 1)}, peers: helpers, panes: pane},
			want: ErrNotForeground,
		},
		"the tmux pane is in copy mode": {
			f:    &fake{proc: []string{claudeFront}, peers: helpers, panes: "/dev/ttys003\t%7\t1\n"},
			want: ErrNotForeground,
		},
		"no terminal at all": {
			f:    &fake{proc: []string{"501 ?? 4100 0 /usr/local/bin/claude -p\n"}},
			want: ErrNoTerminal,
		},
		"the process is gone": {
			f:    &fake{procErr: errors.New("exit status 1")},
			want: ErrNoTerminal,
		},
		"a terminal name that is not one": {
			f:    &fake{proc: []string{"501 ttys003;x 4100 4100 /usr/local/bin/claude\n"}},
			want: ErrNoTerminal,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := sender(tc.f).Send(context.Background(), claude, "run the tests"); !errors.Is(err, tc.want) {
				t.Fatalf("err %v, want %v", err, tc.want)
			}
			if typed := tc.f.typed(); len(typed) != 0 {
				t.Fatalf("typed anyway: %q", typed)
			}
		})
	}
	if _, err := sender(&fake{}).Send(context.Background(), Target{PID: 1, Tool: ToolClaudeCode}, "x"); !errors.Is(err, ErrNoTerminal) {
		t.Fatalf("pid 1: %v", err)
	}
	unknown := &fake{proc: []string{claudeFront}, peers: helpers}
	if _, err := sender(unknown).Send(context.Background(), Target{PID: 4100, Tool: "something-else"}, "x"); !errors.Is(err, ErrNotAgent) {
		t.Fatalf("a tool this package does not know: %v", err)
	}
}

func TestIsAgentKnowsTheBinaryAndItsPackage(t *testing.T) {
	yes := [][]string{
		{"claude"},
		{"/Users/me/.local/bin/claude", "--resume", "abc"},
		{"node", "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"},
		{"/usr/local/bin/node", "/usr/local/bin/claude"},
	}
	for _, argv := range yes {
		if !isAgent(ToolClaudeCode, argv) {
			t.Errorf("%q should be Claude Code", argv)
		}
	}
	no := [][]string{
		{"-zsh"}, {"/bin/bash", "claude"}, {"node", "/tmp/x.js", "claude"}, {"claude-helper"}, {"codex"}, {},
	}
	for _, argv := range no {
		if isAgent(ToolClaudeCode, argv) {
			t.Errorf("%q should not be Claude Code", argv)
		}
	}
	if !isAgent(ToolCodex, []string{"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "app-server"}) {
		t.Error("the Codex binary should be Codex")
	}
}

// A message that would start one of the agent's own commands is never
// typed: "!" would run it as a shell command with no permission prompt.
func TestSendRefusesAMessageTheAgentWouldReadAsACommand(t *testing.T) {
	for _, text := range []string{"!rm -rf ~", "  ! curl x | sh", "/exit", "\n/logout", "# remember this"} {
		f := &fake{proc: []string{claudeFront}, peers: helpers, panes: "/dev/ttys003\t%7\t0\n"}
		if _, err := sender(f).Send(context.Background(), claude, text); !errors.Is(err, ErrUnsafeStart) {
			t.Errorf("%q: err %v, want ErrUnsafeStart", text, err)
		}
		if len(f.calls) != 0 {
			t.Errorf("%q: ran %q before refusing", text, f.calls)
		}
	}
	// Later in the line they are just characters.
	f := &fake{proc: []string{claudeFront}, peers: helpers, panes: "/dev/ttys003\t%7\t0\n"}
	if _, err := sender(f).Send(context.Background(), claude, "use the /api route, not #2!"); err != nil {
		t.Errorf("mid-line: %v", err)
	}
}

func TestSendWithoutAppleScriptOnlyKnowsTmux(t *testing.T) {
	f := &fake{proc: []string{"501 pts/4 4100 4100 claude\n"}, peers: "4100 4100 claude\n", noTmux: true, running: map[string]bool{"Terminal": true}}
	s := &Sender{Run: f.run, AppleScript: false, UID: me}
	if _, err := s.Send(context.Background(), claude, "hello"); !errors.Is(err, ErrNoRoute) {
		t.Fatalf("err %v", err)
	}
	if typed := f.typed(); len(typed) != 0 {
		t.Fatalf("typed %q", typed)
	}
}

func TestFlattenMakesOneSafeLine(t *testing.T) {
	cases := map[string]string{
		"  two\n\nlines\tand   gaps  ":         "two lines and gaps",
		"an \x1b[31mescape\x1b[0m and \a bell": "an [31mescape[0m and bell",
		"back\bspace\x00null":                  "backspacenull",
		"right\u202eto left":                   "rightto left",
		"\n\t ":                                "",
		"1":                                    "1",
		// A backslash before Return asks the prompt for another line.
		"keep going \\\\ \\": "keep going",
	}
	for in, want := range cases {
		if got := Flatten(in); got != want {
			t.Errorf("Flatten(%q) = %q, want %q", in, got, want)
		}
	}
	long := Flatten(strings.Repeat("word ", MaxText))
	if n := len([]rune(long)); n > MaxText {
		t.Errorf("flattened to %d runes, cap is %d", n, MaxText)
	}
	if _, err := sender(&fake{}).Send(context.Background(), claude, "\x1b\n"); !errors.Is(err, ErrEmpty) {
		t.Errorf("nothing left to type: %v", err)
	}
}
