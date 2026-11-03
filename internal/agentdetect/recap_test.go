package agentdetect

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The Codex desktop app ends a turn with an assistant message and
// task_complete, and writes no agent_message event: the reply is still read.
func TestSessionRecapFromTheCodexDesktopApp(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	codex := filepath.Join(home, ".codex", "sessions", "2026", "10", "11")
	writeLog(t, filepath.Join(codex, "rollout-glass.jsonl"), now.Add(-time.Hour),
		`{"type":"session_meta","payload":{"id":"g-1","cwd":"/Users/me/gawkbot","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Redo the liquid glass design system on a new branch"}]}}`,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"is it finished?"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Not fully finished.\n\n- Renderer done.\n- Commit pending."}],"phase":"final_answer"}}`,
		`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Not fully finished.\n\n- Renderer done.\n- Commit pending."}}`,
	)
	writeLog(t, filepath.Join(codex, "rollout-short.jsonl"), now.Add(-2*time.Hour),
		`{"type":"session_meta","payload":{"id":"g-2","cwd":"/Users/me/site","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Rebuild the pricing page"}]}}`,
		`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Pricing page rebuilt; two plans left to write."}}`,
		`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Restarted the preview."}}`,
	)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := s.Sessions([]Detection{{ID: "codex", Name: "Codex", Running: []Process{{PID: 2}}}}, now)
	if len(got) != 2 {
		t.Fatalf("sessions = %+v", got)
	}
	// A short latest reply brings the turn before with it; a full one not.
	if short := got[1]; short.Reply != "Restarted the preview." || short.EarlierReply != "Pricing page rebuilt; two plans left to write." {
		t.Fatalf("short reply recap = %q / %q", short.Reply, short.EarlierReply)
	}
	sess := got[0]
	if sess.EarlierReply != "" {
		t.Fatalf("earlier reply on a full one = %q", sess.EarlierReply)
	}
	if sess.State != SessionYourTurn || sess.LastSaid != "Not fully finished. - Renderer done. - Commit pending." {
		t.Fatalf("state=%q last said=%q", sess.State, sess.LastSaid)
	}
	if sess.Asked != "Redo the liquid glass design system on a new branch" || sess.LastAsked != "is it finished?" {
		t.Fatalf("asked=%q last asked=%q", sess.Asked, sess.LastAsked)
	}
	// The reply keeps its lines, so its list still reads as a list.
	if sess.Reply != "Not fully finished.\n\n- Renderer done.\n- Commit pending." {
		t.Fatalf("reply = %q", sess.Reply)
	}
}

func TestSessionRecapFromClaudeCode(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	claude := filepath.Join(home, ".claude", "projects")
	writeLog(t, filepath.Join(claude, "-Users-me-shop", "s.jsonl"), now.Add(-time.Hour),
		`{"type":"user","cwd":"/Users/me/shop","entrypoint":"cli","message":{"role":"user","content":"Fix the flaky checkout test"}}`,
		`{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use"}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}`,
		`{"type":"user","isMeta":true,"message":{"content":"<system-reminder>x</system-reminder>"}}`,
		`{"type":"user","message":{"content":[{"type":"text","text":"keep the faster fix"}]}}`,
		`{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Kept the faster fix.\nPushed to main."}]}}`,
	)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := s.Sessions([]Detection{{ID: "claude-code", Name: "Claude Code", Running: []Process{{PID: 1}}}}, now)
	if len(got) != 1 {
		t.Fatalf("sessions = %+v", got)
	}
	sess := got[0]
	if sess.Asked != "Fix the flaky checkout test" || sess.LastAsked != "keep the faster fix" || sess.Reply != "Kept the faster fix.\nPushed to main." {
		t.Fatalf("recap = %q / %q / %q", sess.Asked, sess.LastAsked, sess.Reply)
	}
}

func TestFirstWordsCutsOnAWord(t *testing.T) {
	got := firstWords(strings.Repeat("word ", 50), 23)
	if got != "word word word word…" {
		t.Fatalf("firstWords = %q", got)
	}
}

// The desktop app writes tens of kilobytes of instructions before the
// first thing the human typed; the opening request is still found.
func TestOpeningAskPastTheHead(t *testing.T) {
	home := t.TempDir()
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	codex := filepath.Join(home, ".codex", "sessions", "2026", "10", "11")
	long := strings.Repeat("x", sessionHeadBytes+1000)
	writeLog(t, filepath.Join(codex, "rollout-long.jsonl"), now.Add(-time.Hour),
		`{"type":"session_meta","payload":{"id":"l-1","cwd":"/Users/me/app","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"`+long+`"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Make Cuphead-style prototypes"}]}}`,
		`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Four previews load."}}`,
	)
	s := &Scanner{Home: func() (string, error) { return home, nil }}
	got := s.Sessions([]Detection{{ID: "codex", Name: "Codex", Running: []Process{{PID: 2}}}}, now)
	if len(got) != 1 || got[0].Asked != "Make Cuphead-style prototypes" {
		t.Fatalf("sessions = %+v", got)
	}
}
