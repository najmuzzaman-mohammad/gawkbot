package termsend

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func showSender(f *fake) *Sender {
	return &Sender{Run: f.run, AppleScript: true, UID: me}
}

func TestShowOpensTheSupersetTerminalTheSessionRunsIn(t *testing.T) {
	f := &fake{
		proc: []string{"501 ttys005 /Users/me/.local/bin/claude --resume x"},
		env:  "claude SUPERSET_WORKSPACE_ID=6d0b457e-e045 SUPERSET_TERMINAL_ID=f533f78a-9247",
	}
	route, err := showSender(f).Show(context.Background(), Target{PID: 8317, Tool: ToolClaudeCode})
	if err != nil || route != RouteSuperset {
		t.Fatalf("route=%q err=%v", route, err)
	}
	last := f.calls[len(f.calls)-1]
	if !strings.HasPrefix(last, "open superset://v2-workspace/6d0b457e-e045?") || !strings.Contains(last, "terminalId=f533f78a-9247") {
		t.Fatalf("opened %q", last)
	}
}

func TestShowSelectsTheTerminalTab(t *testing.T) {
	f := &fake{
		proc:    []string{"501 ttys007 claude"},
		noTmux:  true,
		running: map[string]bool{"Terminal": true},
		scripts: map[string]string{"Terminal": scriptShown},
	}
	route, err := showSender(f).Show(context.Background(), Target{PID: 42, Tool: ToolClaudeCode})
	if err != nil || route != RouteTerminal {
		t.Fatalf("route=%q err=%v", route, err)
	}
	last := f.calls[len(f.calls)-1]
	if !strings.HasPrefix(last, "osascript -e") || !strings.HasSuffix(last, " /dev/ttys007") {
		t.Fatalf("script call %q", last)
	}
}

func TestShowRefusesAProcessThatIsNotTheAgent(t *testing.T) {
	for _, proc := range []string{"501 ttys007 zsh", "0 ttys007 claude"} {
		f := &fake{proc: []string{proc}}
		if _, err := showSender(f).Show(context.Background(), Target{PID: 42, Tool: ToolClaudeCode}); !errors.Is(err, ErrNotAgent) {
			t.Fatalf("%q: err=%v, want ErrNotAgent", proc, err)
		}
	}
}

func TestResumeInTerminalPassesTheFolderAndIdAsArguments(t *testing.T) {
	f := &fake{}
	id := "a0bb134f-ae9f-4809-8b8c-168a65098622"
	if err := showSender(f).ResumeInTerminal(context.Background(), ToolClaudeCode, id, "/Users/me/my app"); err != nil {
		t.Fatal(err)
	}
	if want := "/Users/me/my app claude --resume " + id; !strings.HasSuffix(f.calls[0], want) {
		t.Fatalf("call %q, want the folder and command as separate arguments", f.calls[0])
	}
	for _, bad := range []string{"../x", "a0bb134f; rm -rf ~", ""} {
		if err := showSender(&fake{}).ResumeInTerminal(context.Background(), ToolClaudeCode, bad, "/Users/me"); err == nil {
			t.Fatalf("%q was resumed", bad)
		}
	}
	if err := showSender(&fake{}).ResumeInTerminal(context.Background(), ToolClaudeCode, id, "relative"); err == nil {
		t.Fatal("a relative folder was used")
	}
}
