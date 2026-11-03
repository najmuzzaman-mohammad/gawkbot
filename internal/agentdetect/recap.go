package agentdetect

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
)

// A recap is what someone needs to pick a session back up without opening
// its window: what they asked for at the start, what they asked last, and
// the latest reply in full (it is usually the session's own account of what
// is done and what is left).

const (
	recapAskedMax = 500
	recapReplyMax = 1200
	// The opening request can sit past the head that is read on every
	// scan (the desktop app writes long instructions first). This much of
	// a log is read for it, once.
	recapOpeningBytes = 4 << 20
)

// openingAsks remembers each log's opening request: it never changes, so
// a log is read past its head for it at most once.
var openingAsks = struct {
	mu     sync.Mutex
	byPath map[string]string
}{byPath: map[string]string{}}

// openingAsk is the first request in the log at path, read up to
// recapOpeningBytes, with read picking it out of a record.
func openingAsk(path string, read func([]byte) string) string {
	openingAsks.mu.Lock()
	defer openingAsks.mu.Unlock()
	if ask, ok := openingAsks.byPath[path]; ok {
		return ask
	}
	ask := ""
	if f, err := os.Open(path); err == nil {
		r := bufio.NewReaderSize(io.LimitReader(f, recapOpeningBytes), 1<<20)
		for ask == "" {
			line, err := r.ReadBytes('\n')
			ask = read(line)
			if err != nil {
				break
			}
		}
		_ = f.Close()
	}
	if len(openingAsks.byPath) > 256 {
		openingAsks.byPath = map[string]string{}
	}
	openingAsks.byPath[path] = ask
	return ask
}

// firstWords keeps the start of text, cut on a word, line breaks kept so
// a reply's list still reads as one.
func firstWords(text string, max int) string {
	text = strings.TrimSpace(text)
	r := []rune(text)
	if len(r) <= max {
		return text
	}
	cut := string(r[:max])
	if i := strings.LastIndexAny(cut, " \n"); i > max/2 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut) + "…"
}

// claudeUserText is what the human typed in a Claude Code user record, or
// "" for a tool result, a command, or context the tool added.
func claudeUserText(line []byte) string {
	if !bytes.Contains(line, []byte(`"user"`)) {
		return ""
	}
	var rec struct {
		Type    string `json:"type"`
		IsMeta  bool   `json:"isMeta"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "user" || rec.IsMeta {
		return ""
	}
	var text string
	if json.Unmarshal(rec.Message.Content, &text) != nil {
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(rec.Message.Content, &parts) != nil {
			return ""
		}
		for _, p := range parts {
			if p.Type == "tool_result" {
				return ""
			}
			if p.Type == "text" && text == "" {
				text = p.Text
			}
		}
	}
	text = strings.TrimSpace(text)
	if !humanWords(text) {
		return ""
	}
	return text
}

// claudeAsks returns the first request in head and the latest in tail.
func claudeAsks(head, tail [][]byte) (first, latest string) {
	for _, line := range head {
		if first = claudeUserText(line); first != "" {
			break
		}
	}
	for i := len(tail) - 1; i >= 0 && latest == ""; i-- {
		latest = claudeUserText(tail[i])
	}
	return first, latest
}

// codexUserText is what the human typed in a Codex record, or "".
func codexUserText(line []byte) string {
	if !bytes.Contains(line, []byte(`"user`)) {
		return ""
	}
	var rec struct {
		Type    string `json:"type"`
		Payload struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Message string `json:"message"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil {
		return ""
	}
	switch {
	case rec.Payload.Type == "user_message":
		if t := strings.TrimSpace(rec.Payload.Message); humanWords(t) {
			return t
		}
	case rec.Payload.Role == "user":
		for _, c := range rec.Payload.Content {
			if t := strings.TrimSpace(c.Text); humanWords(t) {
				return t
			}
		}
	}
	return ""
}

// codexLatestAsk is the latest request in a Codex log's tail.
func codexLatestAsk(tail [][]byte) string {
	for i := len(tail) - 1; i >= 0; i-- {
		if t := codexUserText(tail[i]); t != "" {
			return t
		}
	}
	return ""
}

// codexReply is the latest reply in a Codex log, in full. The CLI writes it
// as an agent_message event; the desktop app as the assistant message the
// turn ends on, and both put it on task_complete.
func codexReply(lines [][]byte) string {
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !bytes.Contains(line, []byte(`"task_complete"`)) &&
			!bytes.Contains(line, []byte(`"agent_message"`)) &&
			!bytes.Contains(line, []byte(`"assistant"`)) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Type             string `json:"type"`
				Role             string `json:"role"`
				Message          string `json:"message"`
				LastAgentMessage string `json:"last_agent_message"`
				Content          []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		p := rec.Payload
		switch {
		case p.Type == "task_complete" && strings.TrimSpace(p.LastAgentMessage) != "":
			return strings.TrimSpace(p.LastAgentMessage)
		case p.Type == "agent_message" && strings.TrimSpace(p.Message) != "":
			return strings.TrimSpace(p.Message)
		case rec.Type == "response_item" && p.Type == "message" && p.Role == "assistant":
			for j := len(p.Content) - 1; j >= 0; j-- {
				if t := strings.TrimSpace(p.Content[j].Text); t != "" {
					return t
				}
			}
		}
	}
	return ""
}

// recapShortReply is a reply too short to say where the work stands on its
// own ("Restarted it."): the turn before it is shown too.
const recapShortReply = 240

// codexEarlierReply is the reply of the turn before the latest one, from
// the turn ends Codex records.
func codexEarlierReply(lines [][]byte) string {
	seen := 0
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"task_complete"`)) {
			continue
		}
		var rec struct {
			Payload struct {
				Type             string `json:"type"`
				LastAgentMessage string `json:"last_agent_message"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &rec) != nil || rec.Payload.Type != "task_complete" {
			continue
		}
		if seen++; seen == 2 {
			return strings.TrimSpace(rec.Payload.LastAgentMessage)
		}
	}
	return ""
}

// claudeEarlierReply is the text of the finished turn before the latest.
func claudeEarlierReply(lines [][]byte) string {
	seen := 0
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"end_turn"`)) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Message struct {
				StopReason string `json:"stop_reason"`
				Content    []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &rec) != nil || rec.Type != "assistant" || rec.Message.StopReason != "end_turn" {
			continue
		}
		if seen++; seen < 2 {
			continue
		}
		for j := len(rec.Message.Content) - 1; j >= 0; j-- {
			if t := strings.TrimSpace(rec.Message.Content[j].Text); t != "" {
				return t
			}
		}
	}
	return ""
}

// withEarlier keeps the turn before a reply too short to stand alone.
func withEarlier(sess *Session, reply string, earlier func() string) {
	if len([]rune(reply)) >= recapShortReply {
		return
	}
	if e := earlier(); e != "" && e != reply {
		sess.EarlierReply = firstWords(e, recapReplyMax)
	}
}
