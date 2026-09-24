package team

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	wuphf "github.com/nex-crm/wuphf"
)

// WebAssetsOverrideEnv points the UI at an on-disk Vite build instead of the
// bundle compiled into the binary. It exists for one workflow: the dev loop
// that rebuilds web/dist WITHOUT rebuilding the binary (scripts/dev-mvp.sh
// --skip-go), where the on-disk build is deliberately newer than the embed.
const WebAssetsOverrideEnv = "WUPHF_WEB_DIST"

// WebAssetsSource says where the UI is being served from, so a caller can log
// it. "Serving the wrong UI" is otherwise invisible: the page loads, it is
// simply not the version you installed.
type WebAssetsSource struct {
	// FS is the resolved filesystem, nil when there is no usable bundle.
	FS fs.FS
	// Kind is "embedded", "disk" or "missing".
	Kind string
	// Dir is the directory for Kind == "disk".
	Dir string
}

// ResolveWebAssets picks the UI bundle to serve.
//
// The embedded bundle WINS whenever the binary has one. That is the fix for a
// trap that cost real time: resolution used to prefer a `web` directory found
// relative to the PROCESS'S WORKING DIRECTORY, so running a released binary
// from inside a source checkout served that checkout's stale web/dist. The
// office came up, reported the new version, and showed the old UI — a released
// 0.239.0 binary serving a 0.238.1 frontend, with nothing anywhere saying so.
// A release embeds its own UI at build time, so the embed is by definition the
// one that matches the binary.
//
// Two escape hatches, in order:
//
//   - WUPHF_WEB_DIST=<dir> forces that directory. This is the --skip-go dev
//     loop, where on-disk is meant to win.
//   - No embed at all (a dev `go build` without `bun run build`) falls back to
//     an on-disk build: first next to the executable, then relative to the
//     working directory. The working-directory lookup is kept ONLY for this
//     case, because `go run ./cmd/wuphf` from a checkout has nowhere else to
//     look, and a dev build has no embed to be shadowed.
func ResolveWebAssets() WebAssetsSource {
	if dir := strings.TrimSpace(os.Getenv(WebAssetsOverrideEnv)); dir != "" {
		if sub, ok := diskBundle(dir); ok {
			return WebAssetsSource{FS: sub, Kind: "disk", Dir: dir}
		}
		// An override that names a directory with no build in it is a mistake
		// worth failing loudly on rather than silently serving something else.
		return WebAssetsSource{Kind: "missing"}
	}
	if embedded, ok := embeddedWebFS(); ok {
		return WebAssetsSource{FS: embedded, Kind: "embedded"}
	}
	for _, dir := range diskCandidates() {
		if sub, ok := diskBundle(dir); ok {
			return WebAssetsSource{FS: sub, Kind: "disk", Dir: dir}
		}
	}
	return WebAssetsSource{Kind: "missing"}
}

// embeddedWebFS is the compiled-in bundle lookup. It is a package var so a
// test can simulate both a released binary (embed present) and a dev build
// (embed absent) regardless of whether the test binary happens to have one.
// Without this the shadowing regression test would SKIP in any environment
// that runs `go test` without building the frontend first — a test that only
// runs when someone remembers to build is not a regression test.
var embeddedWebFS = wuphf.WebFS

// diskCandidates lists on-disk build locations, nearest the binary first.
func diskCandidates() []string {
	var dirs []string
	if exePath, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Join(filepath.Dir(exePath), "web", "dist"))
	}
	// Working-directory relative. Reachable only when the binary has no embed.
	dirs = append(dirs, filepath.Join("web", "dist"))
	return dirs
}

// diskBundle accepts a directory only when it holds a real build.
func diskBundle(dir string) (fs.FS, bool) {
	if strings.TrimSpace(dir) == "" {
		return nil, false
	}
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return nil, false
	}
	return os.DirFS(dir), true
}
