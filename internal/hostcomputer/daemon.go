// Package hostcomputer gives bots hands on the person's own Mac through an
// embedded Cua Driver daemon.
//
// The daemon is a child of the desktop app process, started in the driver's
// embedded mode: macOS attributes Accessibility and Screen Recording to the
// process that spawned it, so the daemon inherits the grants the person gave
// gawkbot and never shows a prompt of its own. Nothing here imports Wails or
// Cocoa; the desktop shell decides where the binary lives and asks for the
// permissions, this package runs the daemon and talks to it.
//
// The daemon follows its host's stdin: closing the pipe ends it, so a crashed
// app never leaves a driver behind.
package hostcomputer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// SocketStartTimeout bounds how long Start waits for the daemon to listen.
var SocketStartTimeout = 15 * time.Second

// stopGrace is how long Stop gives the daemon after closing its stdin
// before it is killed.
var stopGrace = 3 * time.Second

// Daemon is one embedded driver process.
type Daemon struct {
	// Binary is the bundled cua-driver executable.
	Binary string
	// Socket is the private endpoint the daemon binds. macOS caps a Unix
	// socket path at about a hundred bytes, so SocketPath keeps it short.
	Socket string
	// HostBundleID is echoed in the driver's permission reports; it is a
	// label, never a trust signal.
	HostBundleID string
	// Home is where the driver keeps its own state (themes, telemetry
	// choice). Empty means the driver's default.
	Home string
	// Overlay shows each session's agent cursor on screen. Off for tests.
	Overlay bool
	// Stderr receives the daemon's log lines; nil discards them.
	Stderr io.Writer

	// argsOverride replaces Args in tests that run a stand-in process.
	argsOverride []string

	mu  sync.Mutex
	run *daemonRun
}

// daemonRun is one process generation. Its waiter writes err and then
// closes exited, so readers that saw exited closed may read err without a
// lock, and Stop can wait on exited while holding the Daemon's mutex.
type daemonRun struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	exited chan struct{}
	err    error
}

// socketDir is where the daemon's socket lives. Not os.TempDir(): on macOS
// that is the long per-user /var/folders path, and the kernel refuses a
// Unix socket path past about a hundred bytes. The same decision as the
// broker's token file (internal/brokeraddr/addr.go); the socket is private
// to the user through its mode.
const socketDir = "/tmp"

// SocketPrefix is the start of every gawkbot driver socket path, so the
// office can tell its own sockets from anything else under that directory.
func SocketPrefix() string {
	return filepath.Join(socketDir, "gawkbot-cua-")
}

// SocketPath is this user's endpoint.
func SocketPath() string {
	return SocketPrefix() + strconv.Itoa(os.Getuid()) + ".sock"
}

// Args is the daemon's argv after the binary.
func (d *Daemon) Args() []string {
	args := []string{"serve", "--embedded", "--socket", d.Socket, "--no-permissions-gate"}
	if d.HostBundleID != "" {
		args = append(args, "--host-bundle-id", d.HostBundleID)
	}
	if !d.Overlay {
		args = append(args, "--no-overlay")
	}
	return args
}

// Env is the daemon's environment: the embedded-mode switch (only the exact
// value "1" enables it), the advisory host id, the standard permission mode
// fixed for the daemon's lifetime, and its own home.
func (d *Daemon) Env() []string {
	env := append([]string{}, os.Environ()...)
	env = append(env,
		"CUA_DRIVER_EMBEDDED=1",
		"CUA_DRIVER_PERMISSION_MODE=standard",
		"CUA_DRIVER_PARENT_LIVENESS_STDIN=1",
	)
	if d.HostBundleID != "" {
		env = append(env, "CUA_DRIVER_HOST_BUNDLE_ID="+d.HostBundleID)
	}
	if d.Home != "" {
		env = append(env, "CUA_DRIVER_RS_HOME="+d.Home)
	}
	return env
}

// Start spawns the daemon and waits until its socket accepts connections.
// It is idempotent while the daemon runs.
func (d *Daemon) Start(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.runningLocked() {
		return nil
	}
	if d.Binary == "" || d.Socket == "" {
		return errors.New("host computer: driver binary and socket are required")
	}
	_ = os.Remove(d.Socket)
	if d.Home != "" {
		_ = os.MkdirAll(d.Home, 0o700)
	}
	args := d.Args()
	if d.argsOverride != nil {
		args = d.argsOverride
	}
	// The daemon lives as long as the app, not as long as the call that
	// started it, so it is not bound to ctx.
	cmd := exec.CommandContext(context.Background(), d.Binary, args...)
	cmd.Env = d.Env()
	cmd.Stderr = d.Stderr
	cmd.Stdout = d.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("host computer: start driver: %w", err)
	}
	run := &daemonRun{cmd: cmd, stdin: stdin, exited: make(chan struct{})}
	d.run = run
	go func() {
		run.err = cmd.Wait()
		close(run.exited)
	}()
	if err := waitForSocket(ctx, d.Socket, run.exited); err != nil {
		d.stopLocked()
		return err
	}
	return nil
}

func waitForSocket(ctx context.Context, path string, exited <-chan struct{}) error {
	deadline := time.Now().Add(SocketStartTimeout)
	for {
		dialer := &net.Dialer{Timeout: 200 * time.Millisecond}
		if c, err := dialer.DialContext(ctx, "unix", path); err == nil {
			_ = c.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-exited:
			return errors.New("host computer: the driver exited before listening")
		case <-time.After(150 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			return errors.New("host computer: the driver did not start listening in time")
		}
	}
}

// Running reports whether the daemon process is alive.
func (d *Daemon) Running() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.runningLocked()
}

func (d *Daemon) runningLocked() bool {
	if d.run == nil {
		return false
	}
	select {
	case <-d.run.exited:
		return false
	default:
		return true
	}
}

// ExitError is the error the last daemon run ended with, once it ended.
func (d *Daemon) ExitError() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.run == nil || d.runningLocked() {
		return nil
	}
	return d.run.err
}

// Stop closes the daemon's stdin (its liveness signal) and kills it if it
// lingers. Safe to call twice.
func (d *Daemon) Stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stopLocked()
}

func (d *Daemon) stopLocked() {
	run := d.run
	if run == nil {
		return
	}
	_ = run.stdin.Close()
	select {
	case <-run.exited:
	case <-time.After(stopGrace):
		if run.cmd.Process != nil {
			_ = run.cmd.Process.Kill()
		}
		<-run.exited
	}
	_ = os.Remove(d.Socket)
	d.run = nil
}
