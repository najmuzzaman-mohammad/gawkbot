package team

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The scaffold is a template the App Builder copies and edits, so its
// invariants cannot be unit-tested per app — guard them here against silent
// drift. These are the exact regressions the 2026-08-17 app-quality audit found.

func scaffoldFile(t *testing.T, rel string) string {
	t.Helper()
	path := filepath.Join("..", "..", "templates", "app-scaffold", rel)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read scaffold %s: %v", rel, err)
	}
	return string(data)
}

func TestScaffoldMountsNotifications(t *testing.T) {
	// AI_RULES mandates "every user-triggered write gets visible feedback" via
	// @mantine/notifications, but notifications.show() renders NOTHING unless
	// <Notifications /> is mounted — the rule silently no-oped without it.
	main := scaffoldFile(t, "src/main.tsx")
	if !strings.Contains(main, "<Notifications") {
		t.Fatal("scaffold main.tsx does not mount <Notifications /> — notifications.show() will silently no-op")
	}
	if !strings.Contains(main, "@mantine/notifications/styles.css") {
		t.Fatal("scaffold main.tsx does not import @mantine/notifications styles — notifications render unstyled")
	}
}

func TestScaffoldHasStatusColorHelper(t *testing.T) {
	// DESIGN.md points at src/statusColor.ts as "the scaffold's pattern"; it must
	// actually exist so the reference is not a dangling promise.
	src := scaffoldFile(t, "src/statusColor.ts")
	if !strings.Contains(src, "export function statusColor") {
		t.Fatal("scaffold statusColor.ts missing the exported helper DESIGN.md references")
	}
}
