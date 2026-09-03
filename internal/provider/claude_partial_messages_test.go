package provider

import (
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
)

// The office showed a "Working…" pill and nothing else for ~1 minute after the
// human's first question (reported 2026-09-03). Without
// --include-partial-messages the CLI emits one event per COMPLETED assistant
// message, and RULE ZERO in prompt_builder forces the first message to be a
// team_task tool call — so the first human-visible text only landed after a
// full tool round-trip. These two tests pin the flag and the delta handling.

func TestClaudeArgsRequestPartialMessages(t *testing.T) {
	t.Parallel()
	args := buildClaudeArgs("system prompt", "", false)
	if !containsArg(args, "--include-partial-messages") {
		t.Fatalf("claude args missing --include-partial-messages; the office cannot paint a reply until the whole message is done.\nargs: %v", args)
	}
	// The flag only does anything alongside stream-json.
	if !containsArg(args, "stream-json") {
		t.Fatalf("--include-partial-messages requires --output-format stream-json.\nargs: %v", args)
	}
}

// Deltas reach the human as they generate, and the completed block that
// follows them must NOT be emitted a second time.
func TestClaudeStreamEmitsDeltasOnceNotTwice(t *testing.T) {
	// Deliberately NOT parallel. These drive runClaudeAttemptCommand, which
	// reads the package-level claudeConfigureProcess; sibling tests reassign
	// that (and claudeCommand) around their own runs, so interleaving loses
	// the process entirely — chunks came back empty under -race in CI.
	lines := []string{
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Spinning "}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"up a prospector."}}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Spinning up a prospector."}]}}`,
		`{"type":"result","subtype":"success","result":"Spinning up a prospector."}`,
	}
	chunks := runFixtureStream(t, lines)

	var text []string
	for _, c := range chunks {
		if c.Type == "text" {
			text = append(text, c.Content)
		}
	}
	if len(text) == 0 {
		t.Fatalf("no text reached the human at all; chunks=%+v", chunks)
	}
	// The FIRST thing the human sees is a partial, not the finished message —
	// that is the whole point of the change.
	if text[0] != "Spinning " {
		t.Errorf("first text chunk = %q, want the first delta %q (text is not painting live)", text[0], "Spinning ")
	}
	if got := strings.Join(text, ""); got != "Spinning up a prospector." {
		t.Errorf("joined text = %q, want it exactly once — the completed block must not re-emit what the deltas already painted", got)
	}
}

// A turn emits several assistant messages (a tool call, then the reply). A
// message with no deltas must still be emitted, or the guard from the previous
// message would swallow it.
func TestClaudeStreamStillEmitsMessageWithoutDeltas(t *testing.T) {
	// Not parallel, for the same reason as the test above.
	lines := []string{
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Scoping that."}}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Scoping that."}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Done — task-12 is running."}]}}`,
		`{"type":"result","subtype":"success","result":"Done — task-12 is running."}`,
	}
	chunks := runFixtureStream(t, lines)

	var joined strings.Builder
	for _, c := range chunks {
		if c.Type == "text" {
			joined.WriteString(c.Content)
		}
	}
	got := joined.String()
	if !strings.Contains(got, "Scoping that.") {
		t.Errorf("lost the delta-streamed message: %q", got)
	}
	if !strings.Contains(got, "Done — task-12 is running.") {
		t.Errorf("lost the second assistant message, which had no deltas: %q", got)
	}
}

// runFixtureStream feeds canned CLI output through the real stream reader.
// No subprocess: consumeClaudeStream takes an io.Reader precisely so this
// contract can be checked without one (spawning a child was flaky on CI).
func runFixtureStream(t *testing.T, lines []string) []bot.StreamChunk {
	t.Helper()
	ch := make(chan bot.StreamChunk, 64)
	go func() {
		defer close(ch)
		if _, err := consumeClaudeStream(
			strings.NewReader(strings.Join(lines, "\n")+"\n"), ch,
		); err != nil {
			t.Errorf("consumeClaudeStream: %v", err)
		}
	}()

	var chunks []bot.StreamChunk
	for c := range ch {
		chunks = append(chunks, c)
	}
	return chunks
}
