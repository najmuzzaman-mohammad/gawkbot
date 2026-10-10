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

// The real thing, end to end, against a private tmux server: a program
// reading its terminal receives the line, and once a shell is all that is
// left there nothing is typed. Skipped where tmux is not installed.
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

	got := filepath.Join(t.TempDir(), "got.txt")
	// exec, so the reader is the pane's own process and its foreground job.
	tmux("new-session", "-d", "-s", "reader", "exec cat > "+got)
	pid, err := strconv.Atoi(tmux("list-panes", "-t", "reader", "-F", "#{pane_pid}"))
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	route, err := New().Send(ctx, pid, "keep the clock freeze\nand push")
	if err != nil || route != RouteTmux {
		t.Fatalf("route %q err %v", route, err)
	}
	waitFor(t, "the line to reach the program", func() bool {
		raw, _ := os.ReadFile(got)
		return string(raw) == "keep the clock freeze and push\n"
	})

	// An interactive shell that has started a program of its own: the shell
	// is alive but is not what the terminal is reading, so a message for it
	// is refused and never typed.
	tmux("new-session", "-d", "-s", "shell", "env PS1= sh -i")
	shellPID, err := strconv.Atoi(tmux("list-panes", "-t", "shell", "-F", "#{pane_pid}"))
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "other.txt")
	tmux("send-keys", "-t", "shell", "-l", "cat > "+other)
	tmux("send-keys", "-t", "shell", "Enter")
	waitFor(t, "the shell's program to take the terminal", func() bool {
		out, _ := exec.Command("ps", "-o", "pgid=,tpgid=", "-p", strconv.Itoa(shellPID)).Output()
		f := strings.Fields(string(out))
		return len(f) == 2 && f[0] != f[1]
	})
	if _, err := New().Send(ctx, shellPID, "rm -rf ~"); !errors.Is(err, ErrNotForeground) {
		t.Fatalf("err %v, want ErrNotForeground", err)
	}
	if raw, _ := os.ReadFile(other); len(raw) != 0 {
		t.Fatalf("typed into the other program anyway: %q", raw)
	}

	// The reader is gone: there is no terminal of its to type into.
	tmux("kill-session", "-t", "reader")
	waitFor(t, "the reader to exit", func() bool {
		return exec.Command("ps", "-p", strconv.Itoa(pid)).Run() != nil
	})
	if _, err := New().Send(ctx, pid, "anyone there"); !errors.Is(err, ErrNoTerminal) {
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
