//go:build linux

package agentdetect

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// procRoot is a var so tests can point the lister at a fake /proc tree.
var procRoot = "/proc"

// listProcesses reads /proc directly rather than shelling out to ps, which
// minimal containers often lack. Processes owned by other users stay in the
// list (cmdline is world-readable) but their cwd is unreadable and left
// empty.
func listProcesses(ctx context.Context) ([]rawProcess, error) {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil, err
	}
	out := make([]rawProcess, 0, len(entries))
	for _, e := range entries {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		dir := filepath.Join(procRoot, e.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "cmdline"))
		if err != nil || len(raw) == 0 {
			// Kernel threads have an empty cmdline; exited processes error.
			continue
		}
		args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
		p := rawProcess{PID: pid, Args: args, PPID: readPPID(dir)}
		if cwd, err := os.Readlink(filepath.Join(dir, "cwd")); err == nil {
			p.Cwd = cwd
		}
		out = append(out, p)
	}
	return out, nil
}

// readPPID parses the parent pid from /proc/<pid>/stat. The comm field is
// parenthesised and may itself contain spaces or parens, so the fields are
// read after the LAST ')'.
func readPPID(dir string) int {
	raw, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return 0
	}
	s := string(raw)
	idx := strings.LastIndexByte(s, ')')
	if idx < 0 || idx+2 >= len(s) {
		return 0
	}
	fields := strings.Fields(s[idx+2:])
	if len(fields) < 2 {
		return 0
	}
	ppid, _ := strconv.Atoi(fields[1])
	return ppid
}
