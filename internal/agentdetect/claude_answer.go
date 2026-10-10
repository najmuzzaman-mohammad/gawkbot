package agentdetect

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
)

// claudeAnswerReadMax bounds how much of a log ClaudeAnswerAfter reads. A
// turn that wrote more than this after the offset is answered from its last
// part, which is where the final reply is.
const claudeAnswerReadMax = 8 << 20

// ClaudeAnswerAfter reads what a Claude Code session wrote to its log after
// offset (the log's size when a message was handed to it) and reports the
// turn's final reply once the turn has ended on its own: the text of the
// last assistant record, when that record ended with "end_turn" and nothing
// a person or a tool sent came after it. done is false while the turn is
// still going, and for a turn that ended without any text.
//
// A record still being written at the end of the file does not parse and is
// skipped, so a reply is never reported half-written.
func ClaudeAnswerAfter(path string, offset int64) (answer string, done bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || info.Size() <= offset {
		return "", false
	}
	start := offset
	if info.Size()-start > claudeAnswerReadMax {
		start = info.Size() - claudeAnswerReadMax
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return "", false
	}
	raw, err := io.ReadAll(io.LimitReader(f, claudeAnswerReadMax))
	if err != nil {
		return "", false
	}
	lines := bytes.Split(raw, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		var rec struct {
			Type    string `json:"type"`
			Message struct {
				StopReason string          `json:"stop_reason"`
				Content    json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(bytes.TrimSpace(lines[i]), &rec) != nil {
			continue
		}
		switch rec.Type {
		case "user":
			// A tool result or a new prompt: the turn is not over.
			return "", false
		case "assistant":
			if rec.Message.StopReason != "end_turn" {
				return "", false
			}
			var parts []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if json.Unmarshal(rec.Message.Content, &parts) != nil {
				return "", false
			}
			var b strings.Builder
			for _, p := range parts {
				if p.Type == "text" && strings.TrimSpace(p.Text) != "" {
					if b.Len() > 0 {
						b.WriteString("\n\n")
					}
					b.WriteString(strings.TrimSpace(p.Text))
				}
			}
			if b.Len() == 0 {
				return "", false
			}
			return b.String(), true
		}
	}
	return "", false
}
