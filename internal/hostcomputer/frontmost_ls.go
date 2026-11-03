package hostcomputer

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// FrontmostFromLaunchServices names the app in front by asking Launch
// Services' command-line tool, for a broker that is not the Mac app and
// so cannot ask the workspace itself. Two short calls, no permission.
func FrontmostFromLaunchServices() (App, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	asn, err := exec.CommandContext(ctx, "lsappinfo", "front").Output()
	if err != nil {
		return App{}, false
	}
	id := strings.TrimSpace(string(asn))
	if id == "" {
		return App{}, false
	}
	info, err := exec.CommandContext(ctx, "lsappinfo", "info", "-only", "bundleid", "-only", "name", "-only", "pid", id).Output()
	if err != nil {
		return App{}, false
	}
	return parseLSAppInfo(string(info))
}

var (
	lsBundle = regexp.MustCompile(`bundleID="([^"]*)"`)
	lsPID    = regexp.MustCompile(`pid\s*=\s*(\d+)`)
	lsName   = regexp.MustCompile(`^"([^"]*)"`)
)

// parseLSAppInfo reads the few lines lsappinfo prints for one app.
func parseLSAppInfo(out string) (App, bool) {
	app := App{Running: true}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if m := lsBundle.FindStringSubmatch(line); m != nil {
			app.BundleID = m[1]
		}
		if m := lsPID.FindStringSubmatch(line); m != nil {
			app.PID, _ = strconv.Atoi(m[1])
		}
		if m := lsName.FindStringSubmatch(line); m != nil && app.Name == "" {
			app.Name = m[1]
		}
	}
	if app.PID <= 0 {
		return App{}, false
	}
	return app, true
}
