package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
)

func TestRunLogCmd_EmptyListingDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WUPHF_TASK_LOG_ROOT", dir)

	// Capture stdout so the empty-state message doesn't spam test output.
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	runLogCmd([]string{})

	w.Close()
	os.Stdout = oldStdout
	var buf bytes.Buffer
	_, _ = io.Copy(&buf, r)

	if buf.Len() == 0 {
		t.Fatal("expected some output from empty listing (empty-state message)")
	}
}

func TestRunLogCmd_JSONFlagReturnsValidJSON(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WUPHF_TASK_LOG_ROOT", dir)

	// Seed one task.
	taskDir := filepath.Join(dir, "eng-100")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "output.log"),
		[]byte(`{"tool_name":"grep_search","agent_slug":"eng"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Sanity check the reader sees it before we test the CLI.
	summaries, err := bot.ListRecentTasks(dir, 10)
	if err != nil || len(summaries) != 1 {
		t.Fatalf("reader saw %d tasks, err=%v", len(summaries), err)
	}

	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	runLogCmd([]string{"--json"})

	w.Close()
	os.Stdout = oldStdout
	var buf bytes.Buffer
	_, _ = io.Copy(&buf, r)

	var parsed []map[string]any
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("output was not valid JSON array: %v\noutput: %s", err, buf.String())
	}
	if len(parsed) != 1 {
		t.Fatalf("expected 1 task in JSON, got %d", len(parsed))
	}
}
