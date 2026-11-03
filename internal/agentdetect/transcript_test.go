package agentdetect

import (
	"path/filepath"
	"testing"
	"time"
)

func TestReadTranscriptFromClaudeCode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	writeLog(t, path, time.Now(),
		`{"type":"user","timestamp":"2026-10-11T10:00:00Z","message":{"role":"user","content":"Fix the flaky test"}}`,
		`{"type":"assistant","timestamp":"2026-10-11T10:00:05Z","message":{"content":[{"type":"thinking","thinking":"secret"},{"type":"text","text":"Looking at it."},{"type":"tool_use"}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}`,
		`{"type":"user","isMeta":true,"message":{"content":"<system-reminder>x</system-reminder>"}}`,
		`{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sub-agent chatter"}]}}`,
		`{"type":"assistant","timestamp":"2026-10-11T10:01:00Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Fixed.\nPushed."}]}}`,
	)
	got, err := ReadTranscript(path, claudeCodeID)
	if err != nil {
		t.Fatal(err)
	}
	want := []Turn{
		{From: TurnHuman, Text: "Fix the flaky test", At: "2026-10-11T10:00:00Z"},
		{From: TurnAgent, Text: "Looking at it.", At: "2026-10-11T10:00:05Z"},
		{From: TurnAgent, Text: "Fixed.\nPushed.", At: "2026-10-11T10:01:00Z"},
	}
	if len(got) != len(want) {
		t.Fatalf("turns = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("turn %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestReadTranscriptFromCodex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	writeLog(t, path, time.Now(),
		`{"type":"session_meta","payload":{"id":"x","cwd":"/a"}}`,
		`{"timestamp":"2026-10-11T10:00:00Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"instructions"}]}}`,
		`{"timestamp":"2026-10-11T10:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}`,
		`{"timestamp":"2026-10-11T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Tidy the scripts"}]}}`,
		`{"timestamp":"2026-10-11T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Tidy the scripts"}}`,
		`{"timestamp":"2026-10-11T10:00:02Z","type":"response_item","payload":{"type":"reasoning","summary":[]}}`,
		`{"timestamp":"2026-10-11T10:00:09Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Tidy. Run on staging?"}]}}`,
		`{"timestamp":"2026-10-11T10:00:09Z","type":"event_msg","payload":{"type":"agent_message","message":"Tidy. Run on staging?"}}`,
	)
	got, err := ReadTranscript(path, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != (Turn{From: TurnHuman, Text: "Tidy the scripts", At: "2026-10-11T10:00:01Z"}) ||
		got[1] != (Turn{From: TurnAgent, Text: "Tidy. Run on staging?", At: "2026-10-11T10:00:09Z"}) {
		t.Fatalf("turns = %+v", got)
	}
}

func TestSessionLogFileFindsOnlyAPlainCodexLog(t *testing.T) {
	home := t.TempDir()
	name := "rollout-2026-10-09T21-43-16-01a12230-f471-7e60-aa99-b6ab59ee2ffa"
	writeLog(t, filepath.Join(home, ".codex", "sessions", "2026", "10", "09", name+".jsonl"), time.Now(), `{}`)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	if path, ok := s.SessionLogFile("codex:" + name); !ok || filepath.Base(path) != name+".jsonl" {
		t.Fatalf("path = %q, %v", path, ok)
	}
	for _, bad := range []string{"codex:../../etc/passwd", "codex:" + name + "/../x", "nope", "other:" + name} {
		if _, ok := s.SessionLogFile(bad); ok {
			t.Fatalf("%q resolved to a log", bad)
		}
	}
}
