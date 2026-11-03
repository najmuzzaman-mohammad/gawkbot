package agentdetect

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// A session's own conversation, read back from its log, so the person can
// follow it inside gawkbot as they would in its terminal: what they typed
// and what the agent wrote, in order. Tool calls, their output, and the
// agent's private reasoning are left out; the terminal folds them away too.

// Turn is one message in a session's conversation.
type Turn struct {
	// From is TurnHuman or TurnAgent.
	From string `json:"from"`
	Text string `json:"text"`
	// At is when the log recorded it (RFC 3339), when it says.
	At string `json:"at,omitempty"`
}

const (
	TurnHuman = "human"
	TurnAgent = "agent"
)

const (
	// transcriptTailBytes is how much of the end of a log is read: tool
	// output fills most of a log, so it takes this much for a long
	// conversation's latest turns.
	transcriptTailBytes = 8 << 20
	// TranscriptMax is the most turns returned, the latest ones.
	TranscriptMax = 120
	// transcriptTextMax bounds one turn.
	transcriptTextMax = 8000
)

// codexLogNameRe is a Codex rollout log's name: it carries the day the
// session started, which names the folder it is filed in.
var codexLogNameRe = regexp.MustCompile(`^rollout-(\d{4})-(\d{2})-(\d{2})T[0-9-]+-[0-9a-f-]+$`)

// SessionLogFile is the log of the session with this scanner id
// ("claude-code:<uuid>" or "codex:rollout-..."), when there is one. Only a
// plain file where the tool files its logs is returned.
func (s *Scanner) SessionLogFile(id string) (string, bool) {
	tool, rest, ok := strings.Cut(id, ":")
	if !ok {
		return "", false
	}
	switch tool {
	case claudeCodeID:
		path, _, found := s.ClaudeLogFile(rest)
		return path, found
	case "codex":
		m := codexLogNameRe.FindStringSubmatch(rest)
		if m == nil || s.Home == nil {
			return "", false
		}
		home, _ := s.Home()
		if home == "" {
			return "", false
		}
		path := filepath.Join(home, ".codex", "sessions", m[1], m[2], m[3], rest+".jsonl")
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return "", false
		}
		return path, true
	}
	return "", false
}

// transcripts keeps the last read of each log, so a page that polls reads
// a log again only after it has changed.
var transcripts = struct {
	mu     sync.Mutex
	byPath map[string]transcriptRead
}{byPath: map[string]transcriptRead{}}

type transcriptRead struct {
	size  int64
	mod   time.Time
	turns []Turn
}

// ReadTranscript reads the latest turns of the log at path, oldest first.
// The result is shared: callers must not change it.
func ReadTranscript(path, tool string) ([]Turn, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	transcripts.mu.Lock()
	last, ok := transcripts.byPath[path]
	transcripts.mu.Unlock()
	if ok && last.size == info.Size() && last.mod.Equal(info.ModTime()) {
		return last.turns, nil
	}
	turns, err := readTranscript(path, tool)
	if err != nil {
		return nil, err
	}
	transcripts.mu.Lock()
	if len(transcripts.byPath) > 64 {
		transcripts.byPath = map[string]transcriptRead{}
	}
	transcripts.byPath[path] = transcriptRead{info.Size(), info.ModTime(), turns}
	transcripts.mu.Unlock()
	return turns, nil
}

func readTranscript(path, tool string) ([]Turn, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - transcriptTailBytes
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	lines := bytes.Split(raw, []byte("\n"))
	if start > 0 && len(lines) > 0 {
		lines = lines[1:] // starts mid-record
	}
	read := claudeTurn
	if tool == "codex" {
		read = codexTurn
	}
	var out []Turn
	for _, line := range lines {
		t, ok := read(line)
		if !ok {
			continue
		}
		t.Text = firstWords(t.Text, transcriptTextMax)
		if n := len(out); n > 0 && out[n-1].From == t.From && out[n-1].Text == t.Text {
			continue // the same message written twice
		}
		out = append(out, t)
	}
	if len(out) > TranscriptMax {
		out = out[len(out)-TranscriptMax:]
	}
	return out, nil
}

func claudeTurn(line []byte) (Turn, bool) {
	var rec struct {
		Type        string `json:"type"`
		Timestamp   string `json:"timestamp"`
		IsSidechain bool   `json:"isSidechain"`
		Message     struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if (!bytes.Contains(line, []byte(`"user"`)) && !bytes.Contains(line, []byte(`"assistant"`))) ||
		json.Unmarshal(line, &rec) != nil || rec.IsSidechain {
		return Turn{}, false
	}
	switch rec.Type {
	case "user":
		if text := claudeUserText(line); text != "" {
			return Turn{From: TurnHuman, Text: text, At: rec.Timestamp}, true
		}
	case "assistant":
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(rec.Message.Content, &parts) != nil {
			return Turn{}, false
		}
		var texts []string
		for _, p := range parts {
			if t := strings.TrimSpace(p.Text); p.Type == "text" && t != "" {
				texts = append(texts, t)
			}
		}
		if len(texts) > 0 {
			return Turn{From: TurnAgent, Text: strings.Join(texts, "\n\n"), At: rec.Timestamp}, true
		}
	}
	return Turn{}, false
}

// codexTurn reads the response items, which both the CLI and the desktop
// app write; the event copies of the same messages are skipped.
func codexTurn(line []byte) (Turn, bool) {
	if !bytes.Contains(line, []byte(`"response_item"`)) {
		return Turn{}, false
	}
	var rec struct {
		Type      string `json:"type"`
		Timestamp string `json:"timestamp"`
		Payload   struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "response_item" || rec.Payload.Type != "message" {
		return Turn{}, false
	}
	switch rec.Payload.Role {
	case "user":
		if text := codexUserText(line); text != "" {
			return Turn{From: TurnHuman, Text: text, At: rec.Timestamp}, true
		}
	case "assistant":
		var texts []string
		for _, c := range rec.Payload.Content {
			if t := strings.TrimSpace(c.Text); t != "" {
				texts = append(texts, t)
			}
		}
		if len(texts) > 0 {
			return Turn{From: TurnAgent, Text: strings.Join(texts, "\n\n"), At: rec.Timestamp}, true
		}
	}
	return Turn{}, false
}
