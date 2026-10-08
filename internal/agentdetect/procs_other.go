//go:build !linux && !darwin

package agentdetect

import (
	"context"
	"errors"
)

// listProcesses is not implemented on this platform; detection falls back to
// installed binaries and config directories.
func listProcesses(context.Context) ([]rawProcess, error) {
	return nil, errors.New("process listing not supported on this platform")
}
