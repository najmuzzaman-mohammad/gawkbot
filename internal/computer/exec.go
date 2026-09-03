package computer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// MaxCommandLength bounds the console command the panel can send.
const MaxCommandLength = 4000

// ExecResult is the console's view of one shell command inside the computer.
type ExecResult struct {
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

// ExecTimeout bounds a console command.
var ExecTimeout = 120 * time.Second

// ExecShell runs one command as the desktop user inside the container. The
// command is passed as a single argv element to `sh -lc`, never
// interpolated, so quoting is the caller's business and never ours.
func ExecShell(ctx context.Context, run Runner, rt Runtime, target Target, command string) (ExecResult, error) {
	if len(command) > MaxCommandLength {
		return ExecResult{}, fmt.Errorf("command is too long (maximum %d characters)", MaxCommandLength)
	}
	args := []string{"exec", "-u", "cua", "-e", "HOME=/home/cua", "-e", "DISPLAY=" + Display, "-w", WorkspaceGuest,
		target.ContainerName, "sh", "-lc", command}
	stdout, stderr, err := run(ctx, string(rt), args, ExecTimeout)
	result := ExecResult{Stdout: tail(stdout, 4000), Stderr: tail(stderr, 2000)}
	if err != nil {
		var cmdErr *CommandError
		if errors.As(err, &cmdErr) {
			result.ExitCode = exitCodeOf(cmdErr.Err)
			if result.ExitCode == 0 {
				result.ExitCode = 1
			}
			return result, nil
		}
		return result, err
	}
	return result, nil
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func exitCodeOf(err error) int {
	type exitCoder interface{ ExitCode() int }
	var ec exitCoder
	if errors.As(err, &ec) {
		return ec.ExitCode()
	}
	return 1
}

// MCPLaunch is the spawn contract handed to a bot runtime for the
// "computer" MCP server: the gawkbot binary bridging stdio into Cua Driver
// inside the container (see bridge.go).
type MCPLaunch struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env,omitempty"`
}

// ControlEndpoint tells the bridge where to ask who is driving.
type ControlEndpoint struct {
	URL   string
	Token string
}

// ContainerMCPLaunch builds the MCP entry for a local container. The control
// pair rides in env, not argv, because argv is world-readable through ps.
func ContainerMCPLaunch(binary string, rt Runtime, target Target, control ControlEndpoint) MCPLaunch {
	launch := MCPLaunch{
		Command: binary,
		Args:    []string{"computer-mcp", string(rt), target.ContainerName, CuaSocket},
		Env:     map[string]string{},
	}
	if control.URL != "" && control.Token != "" {
		launch.Env["WUPHF_COMPUTER_CONTROL_URL"] = control.URL
		launch.Env["WUPHF_COMPUTER_CONTROL_TOKEN"] = control.Token
	}
	return launch
}

// ValidBridgeArgs checks the argv the computer-mcp subcommand accepts.
func ValidBridgeArgs(runtime, container, socket string) error {
	if !IsRuntime(runtime) {
		return fmt.Errorf("invalid computer runtime %q", runtime)
	}
	if !validContainerName(container) {
		return fmt.Errorf("invalid container name")
	}
	if !strings.HasPrefix(socket, "/run/user/1000/") {
		return fmt.Errorf("invalid driver socket")
	}
	return nil
}

func validContainerName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for i, r := range name {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if i > 0 {
			ok = ok || r == '_' || r == '.' || r == '-'
		}
		if !ok {
			return false
		}
	}
	return true
}
