package team

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/termsend"
)

// Messaging a Claude Code session that is open in a window: the message is
// typed into that window, as if the person had typed it, and the window's
// answer is read back from the session's log.
//
// Typing into a terminal is only safe when what is reading it takes the text
// as a new prompt. Claude Code says what its window is doing in its registry
// entry, and only "idle" is that. Measured on 2.1.296: "busy" while it works,
// "waiting" while it shows a question of its own (a permission prompt reads
// typed digits as its answer), absent before the first prompt. So the
// message waits, in its session's lane, until a fresh read says "idle", and
// is typed right after that read. termsend then checks that the process is
// the agent and is what its terminal is reading.
//
// What is not seen from here: text the person has half-typed in that window
// (the message is appended to it), and the instant between the read and the
// keystrokes. Both are the person's own window on their own machine, and the
// same is true of anything they paste into it.

// sessionTypeFn types text into the terminal of the Claude Code process pid
// and reports the route it used. Swapped by tests.
var sessionTypeFn = func(ctx context.Context, pid int, text string) (string, error) {
	return termsend.New().Send(ctx, termsend.Target{PID: pid, Tool: termsend.ToolClaudeCode}, text)
}

// sessionLogFileFn finds a Claude Code session's log. Swapped by tests.
var sessionLogFileFn = func(nativeID string) (string, bool) {
	path, _, found := agentdetect.NewScanner().ClaudeLogFile(nativeID)
	return path, found
}

// sessionTerminalHostFn names the app hosting pid's terminal, or "". Swapped
// by tests.
var sessionTerminalHostFn = terminalHostName

// sessionTypingPollEvery is how often a waiting message, or a typed one
// waiting for its answer, looks again. A var so tests can shorten it.
var sessionTypingPollEvery = 1500 * time.Millisecond

const (
	// sessionIdleRounds is how many looks in a row a window must read idle,
	// with no answer in its log, before a typed message is taken to have
	// ended without one (the person interrupted it). sessionIdleRoundsUnseen
	// is the same when the window was never seen working at all.
	sessionIdleRounds       = 3
	sessionIdleRoundsUnseen = 10

	sessionHeldNote  = "This session is working or asking you something in its terminal. Your message goes in as soon as it is waiting for you."
	sessionTypedNote = "Typed into this session's terminal window. Its answer will show here when it is done."
)

// typeIntoClaudeSession delivers req to the open window entry describes. It
// reports true only when the window closed before the message went in, so the
// caller may resume the closed session instead; every other outcome, answered
// or failed, has been posted.
func (l *Launcher) typeIntoClaudeSession(ctx context.Context, req sessionTurnRequest, entry agentdetect.OpenSession) (closed bool) {
	if !entry.Interactive || entry.PID <= 1 {
		l.postSessionFailure(req, "it is open in a background process, not a terminal window, so nothing can be typed into it")
		return false
	}
	if n := len([]rune(termsend.Flatten(req.Prompt))); n > termsend.MaxText {
		l.postSessionFailure(req, fmt.Sprintf("your message is %d characters long and the most typed into a terminal at once is %d", n, termsend.MaxText))
		return false
	}
	entry, state := l.waitForSessionInput(ctx, req, entry)
	switch state {
	case sessionWindowClosed:
		return true
	case sessionWindowGaveUp:
		return false
	}

	logPath, hasLog := sessionLogFileFn(req.NativeID)
	var offset int64
	if hasLog {
		if info, err := os.Stat(logPath); err == nil {
			offset = info.Size()
		}
	}
	route, err := sessionTypeFn(ctx, entry.PID, req.Prompt)
	if err != nil {
		appendHeadlessCodexLog(req.Slug, "session-type-refused: "+err.Error())
		l.postSessionFailure(req, sessionTypingFailure(ctx, err, entry.PID))
		return false
	}
	// Who got what, never the words: those are the person's.
	appendHeadlessCodexLog(req.Slug, fmt.Sprintf("session-typed: route=%s pid=%d runes=%d", route, entry.PID, len([]rune(req.Prompt))))
	if _, silent := l.sessionTurnMark(req.Slug); !silent {
		l.broker.PostSystemMessage(req.Channel, sessionTypedNote, sessionDeliveredNoteKind)
	}
	if hasLog {
		l.awaitTypedAnswer(ctx, req, logPath, offset)
	}
	return false
}

type sessionWindowState int

const (
	sessionWindowReady sessionWindowState = iota
	sessionWindowClosed
	sessionWindowGaveUp
)

// waitForSessionInput holds req until its window reads idle, saying once that
// it is holding. It returns the fresh entry the decision was made on.
func (l *Launcher) waitForSessionInput(ctx context.Context, req sessionTurnRequest, entry agentdetect.OpenSession) (agentdetect.OpenSession, sessionWindowState) {
	held := false
	for {
		if entry.TakesInput() {
			return entry, sessionWindowReady
		}
		if !entry.Interactive || entry.PID <= 1 {
			l.postSessionFailure(req, "it is open in a background process, not a terminal window, so nothing can be typed into it")
			return entry, sessionWindowGaveUp
		}
		if !held {
			held = true
			if _, silent := l.sessionTurnMark(req.Slug); !silent {
				l.broker.PostSystemMessage(req.Channel, sessionHeldNote, sessionDeliveredNoteKind)
			}
		}
		select {
		case <-ctx.Done():
			l.postSessionFailure(req, l.sessionWaitEndedReason(ctx, req.Slug))
			return entry, sessionWindowGaveUp
		case <-time.After(sessionTypingPollEvery):
		}
		open, known := sessionOpenNowFn(ctx)
		if !known {
			// Nothing can be said about the window this round: keep waiting,
			// and type nothing.
			entry = agentdetect.OpenSession{PID: entry.PID, Interactive: entry.Interactive}
			continue
		}
		next, isOpen := sessionRequestOpenEntry(req, open)
		if !isOpen {
			return entry, sessionWindowClosed
		}
		entry = next
	}
}

// awaitTypedAnswer posts the window's answer to a typed message once its turn
// ends. It stops without a word when the window closes, when it sits idle
// with no answer (the person interrupted it), or when the turn's time is up:
// the note already said the answer is in the window.
func (l *Launcher) awaitTypedAnswer(ctx context.Context, req sessionTurnRequest, logPath string, offset int64) {
	sawWorking := false
	idleRounds := 0
	for {
		if answer, done := agentdetect.ClaudeAnswerAfter(logPath, offset); done {
			if n := []rune(answer); len(n) > sessionMessageMaxRunes {
				answer = string(n[:sessionMessageMaxRunes]) + "…"
			}
			l.postSessionReply(req, answer)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(sessionTypingPollEvery):
		}
		open, known := sessionOpenNowFn(ctx)
		if !known {
			continue
		}
		entry, isOpen := sessionRequestOpenEntry(req, open)
		if !isOpen {
			return
		}
		if entry.Status != agentdetect.ClaudeStatusIdle {
			sawWorking, idleRounds = true, 0
			continue
		}
		idleRounds++
		if (sawWorking && idleRounds >= sessionIdleRounds) || idleRounds >= sessionIdleRoundsUnseen {
			// One last read: the answer may have landed with the idle.
			if answer, done := agentdetect.ClaudeAnswerAfter(logPath, offset); done {
				l.postSessionReply(req, answer)
			}
			return
		}
	}
}

// sessionWaitEndedReason is why a message waiting for its window stopped
// waiting, as a clause.
func (l *Launcher) sessionWaitEndedReason(ctx context.Context, slug string) string {
	switch {
	case l.sessionTurnWasStopped(slug):
		return "it was stopped before the session was free to take it"
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return fmt.Sprintf("the session was not free to take it within %s", sessionTurnTimeout)
	}
	return "the office was shutting down"
}

// sessionTypingFailure says, as a clause for one plain sentence, why a
// message could not be typed into a session's window and what to do.
func sessionTypingFailure(ctx context.Context, err error, pid int) string {
	switch {
	case errors.Is(err, termsend.ErrNoRoute):
		if host := sessionTerminalHostFn(ctx, pid); host != "" {
			return fmt.Sprintf("this session runs in %s, which gawkbot cannot type into yet. It can type into sessions running in Superset, Terminal, iTerm2, or tmux", host)
		}
		return "this session runs in a terminal app gawkbot cannot type into yet. It can type into sessions running in Superset, Terminal, iTerm2, or tmux"
	case errors.Is(err, termsend.ErrNeedsLogin):
		return "this session runs in Superset, whose command-line tool is not logged in. Log it in once with: superset auth login, then send it again"
	case errors.Is(err, termsend.ErrNotPermitted):
		return "macOS has not allowed gawkbot to control your terminal app. Allow it in System Settings, Privacy & Security, Automation, then send it again"
	case errors.Is(err, termsend.ErrNotForeground):
		return "something else is running in its terminal right now (a shell or another program), so typing there would not reach the session"
	case errors.Is(err, termsend.ErrUnsafeStart):
		return "it starts with /, !, or #, which the session would run as one of its own commands instead of reading it. Start it with a word"
	case errors.Is(err, termsend.ErrEmpty):
		return "nothing was left of it once made safe to type"
	case errors.Is(err, termsend.ErrNoTerminal):
		return "it is not running in a terminal window"
	case errors.Is(err, termsend.ErrNotAgent):
		return "the process behind it is no longer that Claude Code session"
	}
	return "typing it into the session's terminal failed"
}

// terminalHostApps maps a word in a process name to the app it belongs to,
// for naming the terminal a session runs in.
var terminalHostApps = []struct{ match, name string }{
	{"ghostty", "Ghostty"},
	{"warp", "Warp"},
	{"cursor", "Cursor's terminal"},
	{"code helper", "VS Code's terminal"},
	{"visual studio code", "VS Code's terminal"},
	{"wezterm", "WezTerm"},
	{"kitty", "kitty"},
	{"alacritty", "Alacritty"},
	{"zed", "Zed's terminal"},
	{"hyper", "Hyper"},
	{"tabby", "Tabby"},
}

// terminalHostName walks up from pid to the app that hosts its terminal and
// names it, or returns "" when no known app is found. Best effort: it only
// improves a sentence.
func terminalHostName(ctx context.Context, pid int) string {
	for i := 0; i < 16 && pid > 1; i++ {
		out, err := exec.CommandContext(ctx, "ps", "-o", "ppid=", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
		if err != nil {
			return ""
		}
		fields := strings.Fields(strings.TrimSpace(string(out)))
		if len(fields) < 2 {
			return ""
		}
		command := strings.ToLower(strings.Join(fields[1:], " "))
		for _, app := range terminalHostApps {
			if strings.Contains(command, app.match) {
				return app.name
			}
		}
		next, err := strconv.Atoi(fields[0])
		if err != nil {
			return ""
		}
		pid = next
	}
	return ""
}
