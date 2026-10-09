package agentdetect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLog(t *testing.T, path string, mod time.Time, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func TestSessionsAreNamedByWhatTheyAreDoing(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects")
	// A busy session with a title that changed as it went: the latest wins.
	writeLog(t, filepath.Join(claude, "-Users-me-shop", "aaa.jsonl"), now.Add(-30*time.Second),
		`{"type":"user","cwd":"/Users/me/shop","message":{"content":"hi"}}`,
		`{"type":"ai-title","aiTitle":"Set up the repo"}`,
		`{"type":"last-prompt","lastPrompt":"now fix the checkout test"}`,
		`{"type":"ai-title","aiTitle":"Fix the flaky checkout test"}`,
	)
	// No title yet: the human's last prompt names it, cut to a line.
	writeLog(t, filepath.Join(claude, "-Users-me-site", "bbb.jsonl"), now.Add(-10*time.Minute),
		`{"type":"user","cwd":"/Users/me/site","message":{"content":"x"}}`,
		`{"type":"last-prompt","lastPrompt":"Rewrite the pricing page so that the three plans read clearly on a phone and the annual toggle is obvious"}`,
	)
	// A sub-agent's log is not a session the human started.
	writeLog(t, filepath.Join(claude, "-Users-me-shop", "side.jsonl"), now.Add(-time.Minute),
		`{"type":"user","cwd":"/Users/me/shop","isSidechain":true}`,
		`{"type":"ai-title","aiTitle":"Sub-agent"}`,
	)
	// Finished long ago: not listed.
	writeLog(t, filepath.Join(claude, "-Users-me-old", "old.jsonl"), now.Add(-3*time.Hour),
		`{"type":"user","cwd":"/Users/me/old"}`,
		`{"type":"ai-title","aiTitle":"Old work"}`,
	)
	// Codex: the folder from the meta record, the opening request as the
	// name, skipping the context Codex injects ahead of it.
	codex := filepath.Join(home, ".codex", "sessions", "2026", "10", "09")
	writeLog(t, filepath.Join(codex, "rollout-1.jsonl"), now.Add(-5*time.Minute),
		`{"type":"session_meta","payload":{"id":"t-1","cwd":"/Users/me/api","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"# AGENTS.md instructions for /Users/me/api"},{"text":"<environment_context>ignored</environment_context>"}]}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"Add rate limits to the login route"}]}}`,
	)
	// Codex named this thread itself: that name wins, and the latest rename.
	writeLog(t, filepath.Join(codex, "rollout-2.jsonl"), now.Add(-20*time.Minute),
		`{"type":"session_meta","payload":{"id":"t-2","cwd":"/Users/me/web","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"make the header sticky please"}]}}`,
	)
	writeLog(t, filepath.Join(home, ".codex", "session_index.jsonl"), now,
		`{"id":"t-2","thread_name":"Header work"}`,
		`{"id":"t-2","thread_name":"Make the header sticky"}`,
	)
	// Codex's own reviewer and sub-agent sessions are not the human's.
	writeLog(t, filepath.Join(codex, "rollout-3.jsonl"), now.Add(-time.Minute),
		`{"type":"session_meta","payload":{"id":"t-3","cwd":"/Users/me/api","thread_source":"guardian_review"}}`,
		`{"type":"response_item","payload":{"role":"user","content":[{"text":"The following is the Codex agent history"}]}}`,
	)
	// A one-word prompt names nothing: the folder does.
	writeLog(t, filepath.Join(claude, "-Users-me-docs", "ccc.jsonl"), now.Add(-25*time.Minute),
		`{"type":"user","cwd":"/Users/me/docs"}`,
		`{"type":"last-prompt","lastPrompt":"continue"}`,
	)

	s := &Scanner{Home: func() (string, error) { return home, nil }}
	scan := []Detection{
		{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}},
		{ID: "codex", Name: "Codex CLI", Running: []Process{{PID: 2}}},
	}
	got := s.Sessions(scan, now)
	if len(got) != 5 {
		t.Fatalf("sessions = %+v, want 5", got)
	}
	// Newest first.
	if got[0].Title != "Fix the flaky checkout test" || got[0].Project != "shop" || got[0].Tool != "claude-code" || !got[0].Active {
		t.Fatalf("first = %+v", got[0])
	}
	if got[1].Tool != "codex" || got[1].Title != "Add rate limits to the login route" || got[1].Project != "api" || got[1].Active {
		t.Fatalf("second = %+v", got[1])
	}
	if got[2].Project != "site" || !strings.HasPrefix(got[2].Title, "Rewrite the pricing page") || !strings.HasSuffix(got[2].Title, "…") || len([]rune(got[2].Title)) > sessionTitleMax+1 {
		t.Fatalf("third = %+v", got[2])
	}
	if got[3].Title != "Make the header sticky" || got[3].Project != "web" {
		t.Fatalf("fourth = %+v", got[3])
	}
	if got[4].Title != "docs" {
		t.Fatalf("fifth = %+v", got[4])
	}

	// A tool with nothing running lists nothing, whatever its logs say.
	if only := s.Sessions(scan[1:], now); len(only) != 2 || only[0].Tool != "codex" {
		t.Fatalf("with claude not running: %+v", only)
	}
	if none := s.Sessions(nil, now); len(none) != 0 {
		t.Fatalf("with nothing running: %+v", none)
	}
}

// The title is read from the tail of a log far larger than the read window.
func TestSessionTitleComesFromTheTailOfALargeLog(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	filler := `{"type":"assistant","message":{"content":"` + strings.Repeat("x", 4000) + `"}}`
	lines := []string{`{"type":"user","cwd":"/Users/me/big"}`, `{"type":"ai-title","aiTitle":"An early title"}`}
	for i := 0; i < 200; i++ {
		lines = append(lines, filler)
	}
	lines = append(lines, `{"type":"ai-title","aiTitle":"The latest title"}`)
	writeLog(t, filepath.Join(home, ".claude", "projects", "-Users-me-big", "big.jsonl"), now, lines...)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := s.Sessions([]Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}, now)
	if len(got) != 1 || got[0].Title != "The latest title" || got[0].Project != "big" {
		t.Fatalf("sessions = %+v", got)
	}
}

// When a long stretch of work has pushed every title out of the tail, the
// log is read through once and the title found there is remembered.
func TestSessionTitleIsFoundBeyondTheTailAndRemembered(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	path := filepath.Join(home, ".claude", "projects", "-Users-me-long", "long.jsonl")
	filler := `{"type":"assistant","message":{"content":"` + strings.Repeat("x", 4000) + `"}}`
	lines := []string{`{"type":"user","cwd":"/Users/me/long"}`}
	for i := 0; i < 40; i++ {
		lines = append(lines, filler)
	}
	lines = append(lines, `{"type":"ai-title","aiTitle":"Buried in the middle"}`)
	for i := 0; i < 200; i++ {
		lines = append(lines, filler)
	}
	writeLog(t, path, now, lines...)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	scan := []Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}
	if got := s.Sessions(scan, now); len(got) != 1 || got[0].Title != "Buried in the middle" {
		t.Fatalf("sessions = %+v", got)
	}
	// Remembered: the next scan does not need the middle of the file.
	if known := claudeTitles.byPath[path]; known != "Buried in the middle" {
		t.Fatalf("remembered %q", known)
	}
}
