//go:build darwin || linux

package team

import (
	"os"
	"os/exec"
	"syscall"
)

func configureHeadlessProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func terminateHeadlessProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	terminateHeadlessProcessPID(cmd.Process.Pid)
}

func terminateHeadlessProcessPID(pid int) {
	if pid <= 0 {
		return
	}
	if pgid, err := syscall.Getpgid(pid); err == nil && pgid > 0 {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return
	}
	// The lookup above fails for a group leader that was already killed and
	// not yet reaped (measured on macOS: getpgid of a zombie is "no such
	// process"), which is how exec.CommandContext leaves a command when its
	// context ends first. Every command here is started as the leader of
	// its own group (configureHeadlessProcess), so the group id is the pid:
	// signal the group directly, or the one-pid fallback below leaves
	// everything the tool started running. For a pid that leads no group
	// this signals nothing and falls through.
	if err := syscall.Kill(-pid, syscall.SIGKILL); err == nil {
		return
	}
	if proc, err := os.FindProcess(pid); err == nil {
		_ = proc.Kill()
	}
}
