package team

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// stubEmbed makes ResolveWebAssets see a binary that carries its own bundle,
// so the shadowing test runs everywhere rather than only where the frontend
// happened to be built first.
func stubEmbed(t *testing.T, marker string) {
	t.Helper()
	dir := writeBundle(t, filepath.Join(t.TempDir(), "embedded"), marker)
	prev := embeddedWebFS
	embeddedWebFS = func() (fs.FS, bool) { return os.DirFS(dir), true }
	t.Cleanup(func() { embeddedWebFS = prev })
}

// stubNoEmbed simulates a dev `go build` with no frontend compiled in.
func stubNoEmbed(t *testing.T) {
	t.Helper()
	prev := embeddedWebFS
	embeddedWebFS = func() (fs.FS, bool) { return nil, false }
	t.Cleanup(func() { embeddedWebFS = prev })
}

// writeBundle creates a minimal on-disk Vite build and returns its directory.
func writeBundle(t *testing.T, dir, marker string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(marker), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	return dir
}

func readIndex(t *testing.T, src WebAssetsSource) string {
	t.Helper()
	if src.FS == nil {
		t.Fatalf("no filesystem resolved (kind %q)", src.Kind)
	}
	raw, err := fs.ReadFile(src.FS, "index.html")
	if err != nil {
		t.Fatalf("read index.html from %q bundle: %v", src.Kind, err)
	}
	return string(raw)
}

// The regression this whole file exists for. A released binary was run from
// inside a source checkout and served THAT checkout's stale web/dist: the
// office reported the new version and rendered the old UI, with nothing
// saying so. Resolution used to prefer a working-directory-relative `web`
// directory; it must not.
func TestStaleCheckoutCannotShadowTheBinarysOwnUI(t *testing.T) {
	stubEmbed(t, "EMBEDDED RELEASE BUILD")
	checkout := t.TempDir()
	writeBundle(t, filepath.Join(checkout, "web", "dist"), "STALE CHECKOUT BUILD")
	t.Chdir(checkout)
	t.Setenv(WebAssetsOverrideEnv, "")

	got := ResolveWebAssets()
	if got.Kind != "embedded" {
		t.Fatalf("a stale checkout shadowed the embedded UI: kind=%q dir=%q", got.Kind, got.Dir)
	}
	if body := readIndex(t, got); body != "EMBEDDED RELEASE BUILD" {
		t.Fatalf("served %q instead of the binary's own bundle", body)
	}
}

// The dev loop that rebuilds web/dist without rebuilding the binary needs the
// on-disk build to win, which is what the override is for.
func TestOverrideServesTheOnDiskBuild(t *testing.T) {
	stubEmbed(t, "EMBEDDED RELEASE BUILD")
	dir := writeBundle(t, filepath.Join(t.TempDir(), "dist"), "DEV BUILD")
	t.Setenv(WebAssetsOverrideEnv, dir)

	got := ResolveWebAssets()
	if got.Kind != "disk" {
		t.Fatalf("override ignored: kind=%q", got.Kind)
	}
	if body := readIndex(t, got); body != "DEV BUILD" {
		t.Fatalf("served %q, wanted the overridden build", body)
	}
}

// An override naming a directory with no build must fail loudly rather than
// quietly falling through to a different bundle, which would reintroduce the
// original bug by another route.
func TestOverrideWithoutABuildResolvesToMissing(t *testing.T) {
	stubEmbed(t, "EMBEDDED RELEASE BUILD")
	t.Setenv(WebAssetsOverrideEnv, t.TempDir())

	if got := ResolveWebAssets(); got.Kind != "missing" {
		t.Fatalf("an empty override should be missing, got kind=%q dir=%q", got.Kind, got.Dir)
	}
}

// A dev build has no embed, so the working-directory lookup is still its only
// way to find a bundle. That path is kept deliberately.
func TestDevBuildWithoutAnEmbedUsesTheWorkingDirectory(t *testing.T) {
	stubNoEmbed(t)
	checkout := t.TempDir()
	writeBundle(t, filepath.Join(checkout, "web", "dist"), "DEV CHECKOUT BUILD")
	t.Chdir(checkout)
	t.Setenv(WebAssetsOverrideEnv, "")

	got := ResolveWebAssets()
	if got.Kind != "disk" {
		t.Fatalf("a dev build should fall back to disk, got kind=%q", got.Kind)
	}
	if body := readIndex(t, got); body != "DEV CHECKOUT BUILD" {
		t.Fatalf("served %q, wanted the checkout build", body)
	}
}
