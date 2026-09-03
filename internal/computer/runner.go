// Package computer gives every bot its own Linux desktop: a hardened
// container per bot on the user's machine (Docker, Podman, or Apple
// container) built from a digest-pinned Cua desktop image, or a rented VM
// from ascii.dev. The bot process never moves; the desktop is reached as
// one MCP server named "computer" (see bridge.go) and watched through a
// loopback noVNC proxy (see viewer.go).
//
// The package owns the sandbox boundary only: runtime detection, image
// preparation, container lifecycle, hardening verification, screenshots, the
// who-is-driving record, and the viewer proxy. Desktop automation itself is
// Cua Driver inside the container; nothing here reimplements a click.
//
// Ported from milind-soni/OpenMausBot (Apache-2.0) server/container-computer.ts
// and server/box.ts, reshaped for a Go broker whose bots are local CLIs.
package computer

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/runtimebin"
)

// Runner executes one runtime CLI command and returns its output. It is the
// single seam every lifecycle and inspection call goes through, so tests can
// script a whole container runtime without a daemon.
type Runner func(ctx context.Context, name string, args []string, timeout time.Duration) (stdout string, stderr string, err error)

// StreamRunner executes a long command and delivers each output line as it
// arrives. Image builds take minutes; the Computer tab shows these lines.
type StreamRunner func(ctx context.Context, name string, args []string, onLine func(string)) error

// CommandError carries the stderr of a failed runtime command so the panel
// can name the actual problem instead of "exit status 1".
type CommandError struct {
	Name   string
	Args   []string
	Stderr string
	Err    error
}

func (e *CommandError) Error() string {
	detail := strings.TrimSpace(e.Stderr)
	if detail == "" {
		detail = e.Err.Error()
	}
	return fmt.Sprintf("%s %s: %s", e.Name, strings.Join(firstN(e.Args, 2), " "), truncate(detail, 320))
}

func (e *CommandError) Unwrap() error { return e.Err }

// DefaultTimeout bounds inspection commands. Lifecycle mutations pass their
// own, longer budgets.
const DefaultTimeout = 8 * time.Second

// MaxOutputBytes caps captured stdout/stderr so a runaway command cannot
// exhaust memory. Screenshots are far below this.
const MaxOutputBytes = 64 << 20

// ExecRunner is the production Runner: resolves the binary through the same
// PATH augmentation the bot CLIs use, applies the timeout, and captures
// bounded output.
func ExecRunner(ctx context.Context, name string, args []string, timeout time.Duration) (string, string, error) {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	path, err := runtimebin.LookPath(name)
	if err != nil {
		return "", "", &CommandError{Name: name, Args: args, Err: err}
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, path, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &stdout, remaining: MaxOutputBytes}
	cmd.Stderr = &limitedWriter{w: &stderr, remaining: MaxOutputBytes}
	err = cmd.Run()
	if err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			err = fmt.Errorf("timed out after %s: %w", timeout, err)
		}
		return stdout.String(), stderr.String(), &CommandError{Name: name, Args: args, Stderr: stderr.String(), Err: err}
	}
	return stdout.String(), stderr.String(), nil
}

// ExecStreamRunner is the production StreamRunner. stdout and stderr are
// interleaved line by line, which is what `docker build --progress=plain`
// and `docker pull` emit.
func ExecStreamRunner(ctx context.Context, name string, args []string, onLine func(string)) error {
	path, err := runtimebin.LookPath(name)
	if err != nil {
		return &CommandError{Name: name, Args: args, Err: err}
	}
	cmd := exec.CommandContext(ctx, path, args...)
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		return &CommandError{Name: name, Args: args, Err: err}
	}
	done := make(chan struct{})
	var tail []string
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
		for scanner.Scan() {
			line := strings.TrimRight(scanner.Text(), "\r")
			if strings.TrimSpace(line) == "" {
				continue
			}
			tail = append(tail, line)
			if len(tail) > 12 {
				tail = tail[1:]
			}
			if onLine != nil {
				onLine(line)
			}
		}
	}()
	waitErr := cmd.Wait()
	_ = pw.Close()
	<-done
	if waitErr != nil {
		return &CommandError{Name: name, Args: args, Stderr: strings.Join(tail, "\n"), Err: waitErr}
	}
	return nil
}

type limitedWriter struct {
	w         io.Writer
	remaining int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.remaining <= 0 {
		return len(p), nil
	}
	n := len(p)
	if n > l.remaining {
		n = l.remaining
	}
	if _, err := l.w.Write(p[:n]); err != nil {
		return 0, err
	}
	l.remaining -= n
	return len(p), nil
}

func firstN(items []string, n int) []string {
	if len(items) <= n {
		return items
	}
	return items[:n]
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
