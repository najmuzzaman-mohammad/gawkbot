//go:build darwin

package agentdetect

import (
	"context"
	"os/exec"
	"time"
)

// listProcesses shells out to ps, which ships with every macOS install.
// `command` is the full argv joined by spaces; an argument that itself
// contains spaces splits into several, which is harmless for matching
// executable names and package markers.
func listProcesses(ctx context.Context) ([]rawProcess, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, "ps", "-axww", "-o", "pid=,ppid=,command=").Output()
	if err != nil {
		return nil, err
	}
	return parsePSOutput(string(raw)), nil
}
