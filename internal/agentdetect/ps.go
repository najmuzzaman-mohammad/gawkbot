package agentdetect

import (
	"strconv"
	"strings"
)

// parsePSOutput parses `ps -o pid=,ppid=,command=` output. Kept out of the
// darwin-only file so it is tested on every platform.
func parsePSOutput(raw string) []rawProcess {
	var out []rawProcess
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		ppid, _ := strconv.Atoi(fields[1])
		out = append(out, rawProcess{PID: pid, PPID: ppid, Args: fields[2:]})
	}
	return out
}
