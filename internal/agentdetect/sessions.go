package agentdetect

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
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
	// State is what the session is doing: SessionWorking while it is
	// writing, SessionYourTurn when its last turn finished and it is waiting
	// for the human, SessionQuiet when it stopped mid-turn (a long command,
	// an approval prompt, or a closed window; the log cannot tell which).
	State string `json:"state"`
	// LastSaid is the end of the session's latest reply, so the human can
	// see what it is waiting on without opening its window.
	LastSaid string `json:"last_said,omitempty"`
	// Model is the model the session last ran on, as its log names it
	// ("claude-opus-5-5"). Empty until the session has taken a turn.
	Model string `json:"model,omitempty"`
	// Open says whether the tool has this session open right now, read from
	// the tool's own list of running sessions and not from how recently the
	// log was written. It means something only when OpenKnown is true: with
	// no such list to read (Codex, or a Claude Code that keeps it somewhere
	// this build does not know), Open is false and says nothing.
	Open      bool `json:"open,omitempty"`
	OpenKnown bool `json:"open_known,omitempty"`
	// PID is the process that has the session open, when Open is true.
	PID int `json:"pid,omitempty"`

	// turnDone: the last thing in the log is a finished turn.
	turnDone bool
}

const (
	SessionWorking  = "working"
	SessionYourTurn = "your_turn"
	SessionQuiet    = "quiet"
)

const (
	// A session that has not written for this long is not listed. A working
	// day, not minutes: a session that finished its turn and is waiting for
	// the human is exactly the one they need to see.
	sessionWindow = 8 * time.Hour
	// A session that wrote within this long is busy right now.
	sessionActiveWindow = 2 * time.Minute
	// At most this many sessions are returned, newest first.
	sessionLimit = 12
	// How much of each log is read: the head carries the folder, the tail
	// the latest title.
	sessionHeadBytes = 64 << 10
	sessionTailBytes = 256 << 10
	sessionTitleMax  = 72
	sessionSaidMax   = 320
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
		claude := recentSessions(filepath.Join(s.claudeConfigDir(home), "projects"), 2, now, func(path string, info os.FileInfo) (Session, bool) {
			return claudeSession(path, info, name)
		})
		if open, known := s.OpenSessions(); known {
			for i := range claude {
				entry, isOpen := open[claude[i].ID]
				claude[i].OpenKnown, claude[i].Open = true, isOpen
				if isOpen {
					claude[i].PID = entry.PID
				}
			}
		}
		out = append(out, claude...)
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
		switch {
		case out[i].Active:
			out[i].State = SessionWorking
		case out[i].turnDone:
			out[i].State = SessionYourTurn
		default:
			out[i].State = SessionQuiet
		}
	}
	return out
}

// recentSessions walks root to at most depth levels and reads the logs
// written within sessionWindow, newest first, stopping once sessionLimit of
// them are sessions: a day of work leaves far more logs than are shown.
func recentSessions(root string, depth int, now time.Time, read func(string, os.FileInfo) (Session, bool)) []Session {
	type candidate struct {
		path string
		info os.FileInfo
	}
	var found []candidate
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
			// Info does not follow a link. Only a plain file is a log: a
			// link could name any file on the machine as a session.
			info, err := e.Info()
			if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) > sessionWindow {
				continue
			}
			found = append(found, candidate{path, info})
		}
	}
	walk(root, depth)
	sort.SliceStable(found, func(i, j int) bool { return found[i].info.ModTime().After(found[j].info.ModTime()) })
	var out []Session
	for _, c := range found {
		if len(out) >= sessionLimit {
			break
		}
		if sess, ok := read(c.path, c.info); ok {
			out = append(out, sess)
		}
	}
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
	sess := baseSession(path, info, claudeCodeID, toolName)
	entrypoint := ""
	// Claude Code files a log under a folder named after the folder the
	// session was started in. A folder a log claims is believed only when
	// the log sits where a session of that folder would: a log dropped
	// somewhere else cannot point a session at a folder of its choosing.
	home := filepath.Base(filepath.Dir(path))
	claimed := false
	// read takes the folder and the entrypoint from the first records in
	// lines that carry them. With judgeSidechain it also reports whether the
	// record that gives the folder marks the log as a sub-agent's.
	read := func(lines [][]byte, judgeSidechain bool) (sidechain bool) {
		for _, line := range lines {
			hasCwd := sess.Cwd == "" && bytes.Contains(line, []byte(`"cwd"`))
			hasEntrypoint := entrypoint == "" && bytes.Contains(line, []byte(`"entrypoint"`))
			if !hasCwd && !hasEntrypoint {
				continue
			}
			var rec struct {
				Cwd         string `json:"cwd"`
				IsSidechain bool   `json:"isSidechain"`
				Entrypoint  string `json:"entrypoint"`
			}
			if json.Unmarshal(line, &rec) != nil {
				continue
			}
			if entrypoint == "" {
				entrypoint = rec.Entrypoint
			}
			if sess.Cwd == "" && rec.Cwd != "" {
				if rec.IsSidechain && judgeSidechain {
					return true
				}
				claimed = true
				if claudeProjectDirName(rec.Cwd) != home {
					continue
				}
				sess.Cwd = rec.Cwd
			}
			if sess.Cwd != "" && entrypoint != "" {
				break
			}
		}
		return false
	}
	if read(head, true) {
		// A sub-agent's log, not a session the human started.
		return Session{}, false
	}
	if sess.Cwd == "" || entrypoint == "" {
		// The head can hold no whole record at all: a run started with a very
		// long prompt opens with a single record bigger than the head. Every
		// record in a log agrees on the folder and the entrypoint, so the
		// tail answers for it. The sub-agent mark is judged from the head
		// alone: a session's own tail can end on a sub-agent's records.
		read(tail, false)
	}
	if sess.Cwd == "" && claimed {
		// Every folder it names belongs to some other project folder.
		return Session{}, false
	}
	// Claude Code stamps how it was started on its records. Anything but the
	// terminal ("sdk-py", "sdk-cli", ...) is a run some program started, not
	// a session a person opened. Older logs carry no stamp and are kept.
	if entrypoint != "" && entrypoint != claudeTerminalEntrypoint {
		return Session{}, false
	}
	title, prompt := claudeTitle(tail)
	title = claudeTitles.resolve(path, title)
	sess.turnDone, sess.LastSaid = claudeLastTurn(tail)
	sess.Model = claudeModel(tail)
	return finishSession(sess, title, prompt)
}

// claudeModel is the model of the last assistant message in a Claude Code
// log. The model can change mid-session (/model), so the latest one wins.
// Claude Code writes "<synthetic>" on messages it made up itself (an API
// error, an interruption notice); those say nothing about the model.
func claudeModel(lines [][]byte) string {
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"model"`)) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Message struct {
				Model string `json:"model"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &rec) != nil || rec.Type != "assistant" {
			continue
		}
		if m := strings.TrimSpace(rec.Message.Model); m != "" && !strings.HasPrefix(m, "<") {
			return m
		}
	}
	return ""
}

// codexModel is the model of the last turn in a Codex log. Codex records it
// on each turn's turn_context, not on the session's meta record.
func codexModel(lines [][]byte) string {
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"turn_context"`)) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Model string `json:"model"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &rec) != nil || rec.Type != "turn_context" {
			continue
		}
		if m := strings.TrimSpace(rec.Payload.Model); m != "" {
			return m
		}
	}
	return ""
}

// claudeLastTurn reads the last message in a Claude Code log: whether it
// is an assistant turn that ended on its own (not one waiting on a tool),
// and the last words the assistant wrote.
func claudeLastTurn(lines [][]byte) (done bool, said string) {
	decided := false
	for i := len(lines) - 1; i >= 0; i-- {
		var rec struct {
			Type    string `json:"type"`
			Message struct {
				StopReason string          `json:"stop_reason"`
				Content    json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &rec) != nil {
			continue
		}
		switch rec.Type {
		case "assistant":
			if !decided {
				decided, done = true, rec.Message.StopReason == "end_turn"
			}
			var parts []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if json.Unmarshal(rec.Message.Content, &parts) != nil {
				continue
			}
			for j := len(parts) - 1; j >= 0; j-- {
				if parts[j].Type == "text" && strings.TrimSpace(parts[j].Text) != "" {
					return done, lastWords(parts[j].Text, sessionSaidMax)
				}
			}
		case "user":
			decided = true
		}
	}
	return done, ""
}

// lastWords keeps the end of a reply: that is where it says what it did
// and what it is asking.
func lastWords(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	r := []rune(text)
	if len(r) <= max {
		return text
	}
	cut := string(r[len(r)-max:])
	if i := strings.Index(cut, " "); i >= 0 && i < max/2 {
		cut = cut[i+1:]
	}
	return "…" + cut
}

// codexTurnDone reports whether the last task event in a Codex log is a
// completed task rather than one still running.
func codexTurnDone(lines [][]byte) bool {
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"task_`)) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Type string `json:"type"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &rec) != nil || rec.Type != "event_msg" {
			continue
		}
		switch rec.Payload.Type {
		case "task_complete":
			return true
		case "task_started":
			return false
		}
	}
	return false
}

// codexLastSaid returns the last words of the latest agent message.
func codexLastSaid(lines [][]byte) string {
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"agent_message"`)) {
			continue
		}
		var rec struct {
			Payload struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &rec) == nil && rec.Payload.Type == "agent_message" && strings.TrimSpace(rec.Payload.Message) != "" {
			return lastWords(rec.Payload.Message, sessionSaidMax)
		}
	}
	return ""
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
	head, tail := headAndTail(path, info.Size())
	sess := baseSession(path, info, "codex", toolName)
	sess.turnDone = codexTurnDone(tail)
	sess.LastSaid = codexLastSaid(tail)
	sess.Model = codexModel(tail)
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
	if officeOwnDir(sess.Cwd) {
		return Session{}, false
	}
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

// officeOwnDir reports whether cwd is one of an office's own working
// folders (a bot's scratch folder or task worktree under a runtime home).
// A session there is a bot turn some office started, already on the roster
// as that bot, not a session the human opened.
func officeOwnDir(cwd string) bool {
	slashed := filepath.ToSlash(cwd) + "/"
	return strings.Contains(slashed, "/.wuphf/") || strings.Contains(slashed, "/wuphf-agent-scratch/")
}

// claudeProjectDirRe matches what Claude Code replaces with a dash when it
// names a project folder after a path.
var claudeProjectDirRe = regexp.MustCompile(`[^A-Za-z0-9]`)

// claudeProjectDirName is the name of the folder under <config dir>/projects
// where Claude Code keeps the logs of sessions started in cwd: the path with
// everything but letters and digits turned into dashes. Read off 179 real
// logs on 2026-10-10 (claude 2.1.296), all of which agreed; undocumented.
func claudeProjectDirName(cwd string) string {
	return claudeProjectDirRe.ReplaceAllString(cwd, "-")
}

const (
	// claudeCodeID is Claude Code's catalog id.
	claudeCodeID       = "claude-code"
	claudeConfigDirEnv = "CLAUDE_CONFIG_DIR"
	// claudeTerminalEntrypoint is the "entrypoint" Claude Code writes for a
	// session started by a person at a terminal.
	claudeTerminalEntrypoint = "cli"
	// claudeInteractiveKind is the registry "kind" of such a session.
	claudeInteractiveKind = "interactive"
	// A registry file is a few hundred bytes; anything far past that is not
	// one, and is not read.
	claudeRegistryFileMax = 64 << 10
)

// claudeConfigDir is where Claude Code keeps its logs and its list of
// running sessions: CLAUDE_CONFIG_DIR when set, else ~/.claude.
func (s *Scanner) claudeConfigDir(home string) string {
	if s.Getenv != nil {
		if dir := strings.TrimSpace(s.Getenv(claudeConfigDirEnv)); dir != "" {
			return dir
		}
	}
	return filepath.Join(home, ".claude")
}

// OpenSession is one session a tool has open right now.
type OpenSession struct {
	// PID is the process that has it open.
	PID int
	// Busy is true while the tool says it is mid-turn.
	Busy bool
	// Interactive is true for a window a person sits at, false for any
	// other process that holds the session (a background or SDK run).
	Interactive bool
}

// ClaudeLogLastWrite is when the log of the Claude Code session with this
// id (a bare uuid) was last written, and whether a log was found at all.
//
// It is the one signal about a session that does not go through Claude
// Code's list of open sessions: a session being written right now is live,
// whatever that list says. A caller about to resume a session reads this
// last, because a resume against a live session forks its conversation.
func (s *Scanner) ClaudeLogLastWrite(sessionID string) (time.Time, bool) {
	id := strings.ToLower(strings.TrimSpace(sessionID))
	if !bareUUIDRe.MatchString(id) {
		return time.Time{}, false
	}
	home := ""
	if s.Home != nil {
		home, _ = s.Home()
	}
	if home == "" {
		return time.Time{}, false
	}
	root := filepath.Join(s.claudeConfigDir(home), "projects")
	dirs, err := os.ReadDir(root)
	if err != nil {
		return time.Time{}, false
	}
	var last time.Time
	found := false
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		info, err := os.Lstat(filepath.Join(root, d.Name(), id+".jsonl"))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if !found || info.ModTime().After(last) {
			last, found = info.ModTime(), true
		}
	}
	return last, found
}

// bareUUIDRe is a whole uuid and nothing else, so an id can be used as a
// file name without being able to name anything outside a project folder.
var bareUUIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// OpenSessions lists the Claude Code sessions that are open right now, keyed
// by Session.ID, from Claude Code's own registry: one small JSON file per
// running process under <config dir>/sessions, removed when it exits.
//
// The file is undocumented and may move or change shape with any release,
// so the answer comes with whether it can be trusted. It is known in exactly
// two cases:
//
//   - the registry names at least one interactive session whose process is
//     running: this build reads the registry correctly, so a session it does
//     not name is closed;
//   - the last Scan listed processes and found no Claude Code process at
//     all: nothing can be open, whatever the registry holds.
//
// Otherwise known is false and "not in the map" is not "closed". That covers
// a failed process listing (a crashed process leaves its file behind, and a
// stale entry cannot then be told from a live one), and Claude Code processes
// running with a registry that is missing, empty, or names none of them:
// that is also what a release that moved the registry would look like while
// windows are open.
//
// Call it after Scan: it checks each entry's pid against the processes that
// scan saw, and never lists processes itself. The office's own child
// processes are not counted as Claude Code running.
func (s *Scanner) OpenSessions() (open map[string]OpenSession, known bool) {
	home := ""
	if s.Home != nil {
		home, _ = s.Home()
	}
	if home == "" || s.alivePIDs == nil {
		return nil, false
	}
	open = map[string]OpenSession{}
	dir := filepath.Join(s.claudeConfigDir(home), "sessions")
	entries, _ := os.ReadDir(dir)
	// unread: an entry was there and could not be understood. Then nothing
	// can be called closed: the session it stands for is exactly the one
	// that would be missing from the answer, and a missing session reads as
	// closed. One such file made a live session read closed in a real run.
	unread := false
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > claudeRegistryFileMax {
			unread = true
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			unread = true
			continue
		}
		var rec struct {
			PID       int    `json:"pid"`
			SessionID string `json:"sessionId"`
			Kind      string `json:"kind"`
			Status    string `json:"status"`
		}
		// The first JSON value in the file is the entry. Claude Code has
		// been seen to leave bytes after it; those are ignored, where a
		// whole-file parse would have thrown the entry away.
		if json.NewDecoder(bytes.NewReader(raw)).Decode(&rec) != nil || rec.PID <= 0 || strings.TrimSpace(rec.SessionID) == "" {
			unread = true
			continue
		}
		// Any kind of entry with a live process holds the session: only an
		// interactive one is a window a person sits at, but a resume against
		// any of them would write a second conversation into one log.
		if !s.alivePIDs[rec.PID] {
			continue
		}
		open[claudeCodeID+":"+strings.TrimSpace(rec.SessionID)] = OpenSession{PID: rec.PID, Busy: rec.Status == "busy", Interactive: rec.Kind == claudeInteractiveKind}
	}
	if unread {
		return nil, false
	}
	if len(open) > 0 {
		return open, true
	}
	if s.claudeProcsKnown && s.claudeProcs == 0 {
		return open, true
	}
	return nil, false
}
