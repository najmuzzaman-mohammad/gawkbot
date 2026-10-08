//go:build linux

package agentdetect

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestListProcessesReadsProcTree(t *testing.T) {
	root := t.TempDir()
	mk := func(pid, cmdline, stat string) {
		dir := filepath.Join(root, pid)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "cmdline"), []byte(cmdline), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("42", "claude\x00--resume\x00", "42 (weird ) name) S 7 42 42")
	mk("43", "", "43 (kthreadd) S 2 0 0") // kernel thread: skipped
	if err := os.MkdirAll(filepath.Join(root, "self"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/src/app", filepath.Join(root, "42", "cwd")); err != nil {
		t.Fatal(err)
	}

	prev := procRoot
	procRoot = root
	t.Cleanup(func() { procRoot = prev })

	got, err := listProcesses(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d processes, want 1: %+v", len(got), got)
	}
	p := got[0]
	if p.PID != 42 || p.PPID != 7 || p.Cwd != "/src/app" || len(p.Args) != 2 || p.Args[1] != "--resume" {
		t.Fatalf("process = %+v", p)
	}
}
