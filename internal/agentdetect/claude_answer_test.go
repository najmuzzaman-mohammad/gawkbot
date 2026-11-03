package agentdetect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeAnswerAfter(t *testing.T) {
	const (
		before    = `{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"An older answer."}]}}`
		prompt    = `{"type":"user","message":{"content":"bump the version"}}`
		toolCall  = `{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Looking."},{"type":"tool_use","name":"Bash"}]}}`
		toolBack  = `{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}`
		final     = `{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Bumped it to 1.4.0."}]}}`
		summary   = `{"type":"system","subtype":"turn_duration"}`
		halfWrite = `{"type":"assistant","message":{"stop_re`
	)
	cases := []struct {
		name       string
		after      []string
		wantAnswer string
		wantDone   bool
	}{
		{"nothing written yet", nil, "", false},
		{"only the prompt", []string{prompt}, "", false},
		{"waiting on a tool", []string{prompt, toolCall}, "", false},
		{"a tool answered, the turn goes on", []string{prompt, toolCall, toolBack}, "", false},
		{"ended on its own", []string{prompt, toolCall, toolBack, final}, "Bumped it to 1.4.0.", true},
		{"bookkeeping after the end", []string{prompt, final, summary}, "Bumped it to 1.4.0.", true},
		{"a record still being written", []string{prompt, final, halfWrite}, "Bumped it to 1.4.0.", true},
		{"a new prompt after the answer", []string{prompt, final, prompt}, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.jsonl")
			head := before + "\n"
			body := head
			for _, line := range tc.after {
				body += line + "\n"
			}
			body = strings.TrimSuffix(body, "\n")
			if tc.name == "a record still being written" {
				// No newline after a record that is not finished.
			} else {
				body += "\n"
			}
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			answer, done := ClaudeAnswerAfter(path, int64(len(head)))
			if answer != tc.wantAnswer || done != tc.wantDone {
				t.Fatalf("got (%q, %v), want (%q, %v)", answer, done, tc.wantAnswer, tc.wantDone)
			}
		})
	}
	if _, done := ClaudeAnswerAfter(filepath.Join(t.TempDir(), "missing.jsonl"), 0); done {
		t.Fatal("a missing log reported an answer")
	}
}

func TestOpenSessionTakesInputOnlyWhenIdle(t *testing.T) {
	for _, tc := range []struct {
		s    OpenSession
		want bool
	}{
		{OpenSession{PID: 42, Interactive: true, Status: "idle"}, true},
		{OpenSession{PID: 42, Interactive: true, Status: "busy"}, false},
		// What 2.1.296 writes while it shows "Do you want to proceed?".
		{OpenSession{PID: 42, Interactive: true, Status: "waiting"}, false},
		{OpenSession{PID: 42, Interactive: true, Status: ""}, false},
		{OpenSession{PID: 42, Interactive: true, Status: "something new"}, false},
		{OpenSession{PID: 42, Interactive: false, Status: "idle"}, false},
		{OpenSession{PID: 1, Interactive: true, Status: "idle"}, false},
	} {
		if got := tc.s.TakesInput(); got != tc.want {
			t.Errorf("%+v.TakesInput() = %v, want %v", tc.s, got, tc.want)
		}
	}
}
