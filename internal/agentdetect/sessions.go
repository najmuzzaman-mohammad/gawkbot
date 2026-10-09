package agentdetect

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Sessions: what each agent session on this machine is about.
//
// "Claude Code" tells the human which tool is running, not what it is
// doing; with four of them open that is no help. Both Claude Code and Codex
// keep a log per session under the user's home, and the log says what the
// session is about: Claude Code writes a title for it as it goes, Codex
// records the folder and the opening request. This reads just enough of
// each recently written log to name the session.
//
// Read-only, and only the head and tail of each file: logs run to tens of
// megabytes and this is called on a timer.

// Session is one agent session seen on this machine.
type Session struct {
	// ID is stable for the life of the session (the log's file name).
	ID string `json:"id"`
	// Tool is the catalog id of the agent running it ("claude-code", "codex").
	Tool     string `json:"tool"`
	ToolName string `json:"tool_name"`
	// Title says what the session is about.
	Title string `json:"title"`
	// Project is the folder the session is working in; Cwd is its full path.
	Project string `json:"project,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	// UpdatedAt is when the session last wrote to its log.
	UpdatedAt string `json:"updated_at"`
	// Active means it wrote something in the last couple of minutes.
	Active bool `json:"active"`
}

const (
	// A session that has not written for this long is not listed.
	sessionWindow = 30 * time.Minute
	// A session that wrote within this long is busy right now.
	sessionActiveWindow = 2 * time.Minute
	// At most this many sessions are returned, newest first.
	sessionLimit = 12
	// How much of each log is read: the head carries the folder, the tail
	// the latest title.
	sessionHeadBytes = 64 << 10
	sessionTailBytes = 256 << 10
	sessionTitleMax  = 72
)

// Sessions lists the agent sessions that wrote to their log recently,
// newest first. Tools with no running process are skipped: a log touched
// by something that has since exited is not a session to show.
func (s *Scanner) Sessions(scan []Detection, now time.Time) []Session {
	home := ""
	if s.Home != nil {
		home, _ = s.Home()
	}
	if home == "" {
		return nil
	}
	running := map[string]string{}
	for _, d := range scan {
		if len(d.Running) > 0 {
			running[d.ID] = d.Name
		}
	}
	var out []Session
	if name, ok := running["claude-code"]; ok {
		out = append(out, recentSessions(filepath.Join(home, ".claude", "projects"), 2, now, func(path string, info os.FileInfo) (Session, bool) {
			return claudeSession(path, info, name)
		})...)
	}
	if name, ok := running["codex"]; ok {
		names := codexThreadNames(filepath.Join(home, ".codex", "session_index.jsonl"))
		out = append(out, recentSessions(filepath.Join(home, ".codex", "sessions"), 4, now, func(path string, info os.FileInfo) (Session, bool) {
			return codexSession(path, info, name, names)
		})...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	if len(out) > sessionLimit {
		out = out[:sessionLimit]
	}
	for i := range out {
		t, err := time.Parse(time.RFC3339, out[i].UpdatedAt)
		out[i].Active = err == nil && now.Sub(t) <= sessionActiveWindow
	}
	return out
}

// recentSessions walks root to at most depth levels and reads every .jsonl
// log written within sessionWindow.
func recentSessions(root string, depth int, now time.Time, read func(string, os.FileInfo) (Session, bool)) []Session {
	var out []Session
	var walk func(dir string, left int)
	walk = func(dir string, left int) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			path := filepath.Join(dir, e.Name())
			if e.IsDir() {
				if left > 1 {
					walk(path, left-1)
				}
				continue
			}
			if !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			info, err := e.Info()
			if err != nil || now.Sub(info.ModTime()) > sessionWindow {
				continue
			}
			if sess, ok := read(path, info); ok {
				out = append(out, sess)
			}
		}
	}
	walk(root, depth)
	return out
}

// headAndTail returns the first and last stretch of a file as whole lines.
func headAndTail(path string, size int64) (head, tail [][]byte) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, sessionHeadBytes)
	n, _ := io.ReadFull(f, buf)
	head = bytes.Split(buf[:n], []byte("\n"))
	if int64(n) < size && len(head) > 0 {
		// The last line is cut off mid-record.
		head = head[:len(head)-1]
	}
	if size <= sessionHeadBytes {
		return head, head
	}
	start := size - sessionTailBytes
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return head, nil
	}
	rest, _ := io.ReadAll(io.LimitReader(f, sessionTailBytes))
	tail = bytes.Split(rest, []byte("\n"))
	if start > 0 && len(tail) > 0 {
		// The first line starts mid-record.
		tail = tail[1:]
	}
	return head, tail
}

func baseSession(path string, info os.FileInfo, tool, toolName string) Session {
	return Session{
		ID:        tool + ":" + strings.TrimSuffix(filepath.Base(path), ".jsonl"),
		Tool:      tool,
		ToolName:  toolName,
		UpdatedAt: info.ModTime().UTC().Format(time.RFC3339),
	}
}

// claudeSession names a Claude Code session: the title it wrote for
// itself, else the human's last prompt, else the folder.
func claudeSession(path string, info os.FileInfo, toolName string) (Session, bool) {
	head, tail := headAndTail(path, info.Size())
	sess := baseSession(path, info, "claude-code", toolName)
	for _, line := range head {
		if !bytes.Contains(line, []byte(`"cwd"`)) {
			continue
		}
		var rec struct {
			Cwd         string `json:"cwd"`
			IsSidechain bool   `json:"isSidechain"`
		}
		if json.Unmarshal(line, &rec) == nil && rec.Cwd != "" {
			if rec.IsSidechain {
				// A sub-agent's log, not a session the human started.
				return Session{}, false
			}
			sess.Cwd = rec.Cwd
			break
		}
	}
	title, prompt := claudeTitle(tail)
	title = claudeTitles.resolve(path, title)
	return finishSession(sess, title, prompt)
}

// titleMemory remembers the last title seen for each log. A long stretch of
// work pushes the latest title out of the tail that is read on every scan;
// the first time that happens the whole log is read once, and after that
// the remembered title stands until the tail shows a newer one.
type titleMemory struct {
	mu     sync.Mutex
	byPath map[string]string
}

var claudeTitles = titleMemory{byPath: map[string]string{}}

func (m *titleMemory) resolve(path, fromTail string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if fromTail != "" {
		m.byPath[path] = fromTail
		return fromTail
	}
	if known, ok := m.byPath[path]; ok {
		return known
	}
	// Unknown and not in the tail: read it all, once. An empty answer is
	// remembered too, so a log with no title is not read again.
	found := lastClaudeTitle(path)
	m.byPath[path] = found
	return found
}

// lastClaudeTitle streams a whole log for its latest title record.
func lastClaudeTitle(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	title := ""
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if bytes.Contains(line, []byte(`"ai-title"`)) {
			var rec struct {
				Type    string `json:"type"`
				AITitle string `json:"aiTitle"`
			}
			if json.Unmarshal(line, &rec) == nil && rec.Type == "ai-title" && rec.AITitle != "" {
				title = rec.AITitle
			}
		}
		if err != nil {
			return title
		}
	}
}

// claudeTitle returns the latest title and the latest prompt in lines.
func claudeTitle(lines [][]byte) (title, prompt string) {
	for i := len(lines) - 1; i >= 0 && title == ""; i-- {
		line := lines[i]
		isTitle := bytes.Contains(line, []byte(`"ai-title"`))
		if !isTitle && (prompt != "" || !bytes.Contains(line, []byte(`"last-prompt"`))) {
			continue
		}
		var rec struct {
			Type       string `json:"type"`
			AITitle    string `json:"aiTitle"`
			LastPrompt string `json:"lastPrompt"`
		}
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		switch rec.Type {
		case "ai-title":
			title = rec.AITitle
		case "last-prompt":
			if prompt == "" {
				prompt = rec.LastPrompt
			}
		}
	}
	return title, prompt
}

// codexThreadNames reads Codex's own index of thread names: one record per
// rename, so the last one for an id is its current name.
func codexThreadNames(path string) map[string]string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	names := map[string]string{}
	for _, line := range bytes.Split(raw, []byte("\n")) {
		var rec struct {
			ID   string `json:"id"`
			Name string `json:"thread_name"`
		}
		if json.Unmarshal(line, &rec) == nil && rec.ID != "" && strings.TrimSpace(rec.Name) != "" {
			names[rec.ID] = rec.Name
		}
	}
	return names
}

// codexSession names a Codex session: the name Codex gave the thread, else
// its opening request, else the folder. Codex's own helper sessions (its
// approval reviewer, sub-agents it spawned) are not listed.
func codexSession(path string, info os.FileInfo, toolName string, names map[string]string) (Session, bool) {
	head, _ := headAndTail(path, info.Size())
	sess := baseSession(path, info, "codex", toolName)
	title, prompt := "", ""
	for _, line := range head {
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Type         string `json:"type"`
				ID           string `json:"id"`
				Cwd          string `json:"cwd"`
				ThreadSource string `json:"thread_source"`
				Role         string `json:"role"`
				Message      string `json:"message"`
				Content      []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		if rec.Type == "session_meta" {
			if src := rec.Payload.ThreadSource; src != "" && src != "user" {
				return Session{}, false
			}
			sess.Cwd = rec.Payload.Cwd
			title = names[rec.Payload.ID]
			continue
		}
		if prompt != "" {
			continue
		}
		switch {
		case rec.Payload.Type == "user_message" && rec.Payload.Message != "":
			prompt = rec.Payload.Message
		case rec.Payload.Role == "user":
			for _, c := range rec.Payload.Content {
				if t := strings.TrimSpace(c.Text); humanWords(t) {
					prompt = t
					break
				}
			}
		}
	}
	return finishSession(sess, title, prompt)
}

// humanWords reports whether text reads as something the human typed, not
// context the tool injected ahead of it (instruction files, environment
// blocks, history hand-offs).
func humanWords(text string) bool {
	if text == "" {
		return false
	}
	for _, prefix := range []string{"<", "#", ">>>", "The following is"} {
		if strings.HasPrefix(text, prefix) {
			return false
		}
	}
	return true
}

// A prompt this short ("continue", "yes", "go on") names nothing.
const sessionPromptMin = 16

func finishSession(sess Session, title, prompt string) (Session, bool) {
	if sess.Cwd != "" {
		sess.Project = filepath.Base(sess.Cwd)
	}
	sess.Title = oneLine(title, sessionTitleMax)
	if sess.Title == "" && len([]rune(strings.TrimSpace(prompt))) >= sessionPromptMin {
		sess.Title = oneLine(prompt, sessionTitleMax)
	}
	if sess.Title == "" {
		sess.Title = sess.Project
	}
	return sess, sess.Title != ""
}

// oneLine collapses whitespace and cuts at max runes, on a word where it can.
func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	cut := string(r[:max])
	if i := strings.LastIndex(cut, " "); i > max/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,.;:") + "…"
}
