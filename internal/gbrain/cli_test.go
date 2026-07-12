package gbrain

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFakeGbrain drops an executable named "gbrain" into dir and returns its
// path, so PATH-fallback behavior can be observed without a real install.
func writeFakeGbrain(t *testing.T, dir string) string {
	t.Helper()
	fake := filepath.Join(dir, "gbrain")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake gbrain: %v", err)
	}
	return fake
}

func TestBinaryPathExplicitCommandResolves(t *testing.T) {
	dir := t.TempDir()
	wrapper := filepath.Join(dir, "gbrain-wrapper.sh")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write wrapper: %v", err)
	}
	t.Setenv("WUPHF_GBRAIN_COMMAND", wrapper)
	if got := BinaryPath(); got != wrapper {
		t.Fatalf("BinaryPath() = %q, want explicit command %q", got, wrapper)
	}
}

func TestBinaryPathExplicitCommandMissingDoesNotFallBack(t *testing.T) {
	dir := t.TempDir()
	writeFakeGbrain(t, dir)
	t.Setenv("PATH", dir)
	// The explicit command points at a file that no longer exists (e.g. a
	// wrapper script reaped by macOS /tmp cleanup). Falling back to the PATH
	// gbrain silently swaps in the user-global brain — the exact thing an
	// explicit command isolates against — so this must disable gbrain instead.
	t.Setenv("WUPHF_GBRAIN_COMMAND", filepath.Join(dir, "missing-wrapper.sh"))
	if got := BinaryPath(); got != "" {
		t.Fatalf("BinaryPath() = %q, want empty: explicit WUPHF_GBRAIN_COMMAND that does not resolve must not fall back to PATH", got)
	}
	if IsInstalled() {
		t.Fatal("IsInstalled() = true, want false when the explicit command does not resolve")
	}
}

func TestBinaryPathExplicitBareNameResolvesViaPath(t *testing.T) {
	dir := t.TempDir()
	wrapper := filepath.Join(dir, "gbrain-wrapper")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write wrapper: %v", err)
	}
	t.Setenv("PATH", dir)
	// A bare name (no path separator) is resolved through PATH by
	// exec.LookPath — same authoritative semantics as an absolute path.
	t.Setenv("WUPHF_GBRAIN_COMMAND", "gbrain-wrapper")
	if got := BinaryPath(); got != wrapper {
		t.Fatalf("BinaryPath() = %q, want bare name resolved via PATH to %q", got, wrapper)
	}
}

func TestBinaryPathEmptyCommandUsesPathFallback(t *testing.T) {
	dir := t.TempDir()
	fake := writeFakeGbrain(t, dir)
	t.Setenv("PATH", dir)
	t.Setenv("WUPHF_GBRAIN_COMMAND", "")
	if got := BinaryPath(); got != fake {
		t.Fatalf("BinaryPath() = %q, want PATH fallback %q", got, fake)
	}
}
