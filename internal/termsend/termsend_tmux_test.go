package termsend

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The real thing, end to end, against a private tmux server: an "agent"
// reading its terminal receives the line, a shell is never typed into even
// though it is in front of its own terminal, and nothing is typed once the
// agent is gone. Skipped where tmux is not installed.
func TestSendReachesARealProgramThroughTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	// A socket directory of its own: the developer's tmux server is never
	// touched, and Send (which inherits the environment) sees only this one.
	// A short path, because a unix socket path has a small length limit.
	sock, err := os.MkdirTemp("/tmp", "ts")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_TMPDIR", sock)
	t.Setenv("TMUX", "")
	tmux := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("tmux", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	t.Cleanup(func() {
		_ = exec.Command("tmux", "kill-server").Run()
		_ = os.RemoveAll(sock)
	})

	// A stand-in agent: cat under the agent's name, which is all the
	// identity check has to go on.
	agent := filepath.Join(t.TempDir(), "claude")
	cat, err := exec.LookPath("cat")
	if err != nil {
		t.Skip("cat is not installed")
	}
	if err := os.Symlink(cat, agent); err != nil {
		t.Fatal(err)
	}
	got := filepath.Join(t.TempDir(), "got.txt")
	// exec, so the reader is the pane's own process and its foreground job.
	tmux("new-session", "-d", "-s", "reader", "exec "+agent+" > "+got)
	pid, err := strconv.Atoi(tmux("list-panes", "-t", "reader", "-F", "#{pane_pid}"))
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	route, err := New().Send(ctx, Target{PID: pid, Tool: ToolClaudeCode}, "keep the clock freeze\nand push")
	if err != nil || route != RouteTmux {
		t.Fatalf("route %q err %v", route, err)
	}
	waitFor(t, "the line to reach the program", func() bool {
		raw, _ := os.ReadFile(got)
		return string(raw) == "keep the clock freeze and push\n"
	})

	// An interactive shell waiting at its prompt is in front of its own
	// terminal, which is exactly where a typed line would run as a command.
	// It is not the agent, so it is refused.
	typedAt := filepath.Join(t.TempDir(), "ran.txt")
	tmux("new-session", "-d", "-s", "shell", "env PS1= sh -i")
	shellPID, err := strconv.Atoi(tmux("list-panes", "-t", "shell", "-F", "#{pane_pid}"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New().Send(ctx, Target{PID: shellPID, Tool: ToolClaudeCode}, "touch "+typedAt); !errors.Is(err, ErrNotAgent) {
		t.Fatalf("err %v, want ErrNotAgent", err)
	}
	// Prove the shell would have run it, and that it did not: a marker
	// typed by the test itself runs, the refused line never did.
	marker := filepath.Join(t.TempDir(), "marker.txt")
	tmux("send-keys", "-t", "shell", "-l", "touch "+marker+"\r")
	waitFor(t, "the shell to run the test's own marker", func() bool {
		_, err := os.Stat(marker)
		return err == nil
	})
	if _, err := os.Stat(typedAt); err == nil {
		t.Fatal("the refused message was typed into the shell and ran")
	}

	// The reader is gone: there is no terminal of its to type into.
	tmux("kill-session", "-t", "reader")
	waitFor(t, "the reader to exit", func() bool {
		return exec.Command("ps", "-p", strconv.Itoa(pid)).Run() != nil
	})
	if _, err := New().Send(ctx, Target{PID: pid, Tool: ToolClaudeCode}, "anyone there"); !errors.Is(err, ErrNoTerminal) {
		t.Fatalf("err %v, want ErrNoTerminal", err)
	}
}

// waitFor polls until ok or a deadline, without a fixed sleep.
func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		if ok() {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		case <-tick.C:
		}
	}
}
