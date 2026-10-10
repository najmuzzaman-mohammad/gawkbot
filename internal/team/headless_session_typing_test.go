package team

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/termsend"
)

// typingWindow is a Claude Code window as its registry entry describes it,
// changed by the test while a message waits, and a stand-in for typing into
// it that records what was typed and can answer in the session's log.
type typingWindow struct {
	t   *testing.T
	f   *sessionMsgFixture
	log string

	mu     sync.Mutex
	looks  int
	status string
	open   bool
	typed  []string
	pids   []int
	// answer, when set, is written to the log as the window's reply to
	// whatever is typed. err makes typing fail instead.
	answer string
	err    error
}

const typingPID = 4242

func newTypingWindow(t *testing.T, f *sessionMsgFixture, status string) *typingWindow {
	t.Helper()
	w := &typingWindow{t: t, f: f, status: status, open: true, log: filepath.Join(t.TempDir(), "session.jsonl")}
	if err := os.WriteFile(w.log, []byte(`{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"An answer from before."}]}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	prevOpen, prevType, prevLog, prevPoll, prevHost := sessionOpenNowFn, sessionTypeFn, sessionLogFileFn, sessionTypingPollEvery, sessionTerminalHostFn
	sessionOpenNowFn = func(context.Context) (map[string]agentdetect.OpenSession, bool) { return w.openness().open, true }
	sessionTypeFn = w.typeInto
	sessionLogFileFn = func(string) (string, bool) { return w.log, true }
	sessionTypingPollEvery = 5 * time.Millisecond
	sessionTerminalHostFn = func(context.Context, int) string { return "Ghostty" }
	t.Cleanup(func() {
		sessionOpenNowFn, sessionTypeFn, sessionLogFileFn, sessionTypingPollEvery, sessionTerminalHostFn = prevOpen, prevType, prevLog, prevPoll, prevHost
	})
	// The registry's own look sees the same window, so the gate does too.
	f.now = f.now.Add(sessionReconcileEvery)
	f.b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{f.sess}, w.openness(), f.now)
	return w
}

func (w *typingWindow) openness() sessionOpenness {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.looks++
	o := sessionOpenness{known: true, open: map[string]agentdetect.OpenSession{}}
	if w.open {
		o.open[w.f.sess.ID] = agentdetect.OpenSession{PID: typingPID, Interactive: true, Status: w.status, Busy: w.status == "busy"}
	}
	return o
}

func (w *typingWindow) set(status string, open bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.status, w.open = status, open
}

func (w *typingWindow) typeInto(_ context.Context, pid int, text string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return "", w.err
	}
	// Typed only into a window that takes input, read right before.
	if w.status != agentdetect.ClaudeStatusIdle {
		w.t.Errorf("typed into a window whose status is %q", w.status)
	}
	w.typed = append(w.typed, text)
	w.pids = append(w.pids, pid)
	if w.answer != "" {
		f, err := os.OpenFile(w.log, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return "", err
		}
		defer f.Close()
		_, _ = f.WriteString(`{"type":"user","message":{"content":"x"}}` + "\n")
		_, _ = f.WriteString(`{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"` + w.answer + `"}]}}` + "\n")
	}
	return termsend.RouteTmux, nil
}

// waitLooks waits until the window has been looked at n more times.
func (w *typingWindow) waitLooks(n int) bool {
	w.mu.Lock()
	target := w.looks + n
	w.mu.Unlock()
	return pollUntil(5*time.Second, func() bool {
		w.mu.Lock()
		defer w.mu.Unlock()
		return w.looks >= target
	})
}

func (w *typingWindow) typedTexts() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.typed...)
}

func (f *sessionMsgFixture) notesSaying(text string) int {
	return len(f.dmMessages(func(m channelMessage) bool { return m.From == "system" && strings.Contains(m.Content, text) }))
}

// The founder's case: a Claude Code session open in a terminal, waiting for
// input. The message is typed into it, and its answer comes back here.
func TestSessionTypingAnIdleWindowDeliversAndBringsBackTheAnswer(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	w := newTypingWindow(t, f, "idle")
	w.answer = sessionAnswer

	if wire := f.sessionWire(); wire["can_message"] != true {
		t.Fatalf("an open window must be messageable: %v", wire)
	}
	if !f.deliver(f.ownerPost("bump the version")) {
		t.Fatal("the message to an open window was not taken")
	}
	if got := w.typedTexts(); len(got) != 1 || got[0] != "bump the version" {
		t.Fatalf("typed %q, want the person's words once", got)
	}
	if w.pids[0] != typingPID {
		t.Fatalf("typed into pid %d, want the window's %d", w.pids[0], typingPID)
	}
	if f.notesSaying(sessionTypedNote) != 1 {
		t.Fatal("no note that the message was typed into the window")
	}
	if f.saidByMember(sessionAnswer) != 1 {
		t.Fatal("the window's answer was not brought back into the conversation")
	}
	for _, run := range f.started() {
		if run[0] == "claude" {
			t.Fatalf("an open window was resumed in the background: %v", run)
		}
	}
}

// The case the founder was warned about: a window showing an approval
// question reads typed text as the answer. The message waits, untyped,
// until the question is gone, and only then goes in.
func TestSessionTypingWaitsOutAPermissionPrompt(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	w := newTypingWindow(t, f, "waiting")
	w.answer = sessionAnswer

	if !f.l.deliverOwnerMessageToSession(f.slug, f.ownerPost("and then run the tests")) {
		t.Fatal("the message was not taken")
	}
	if !pollUntil(5*time.Second, func() bool { return f.notesSaying(sessionHeldNote) == 1 }) {
		t.Fatal("no note that the message is being held")
	}
	// Many looks at a window still asking its question: nothing typed.
	if !w.waitLooks(20) || len(w.typedTexts()) != 0 {
		t.Fatal("typed into a window showing a permission prompt")
	}
	w.set("busy", true) // the person answered; it works
	if !w.waitLooks(10) || len(w.typedTexts()) != 0 {
		t.Fatal("typed into a busy window")
	}
	w.set("idle", true)
	f.l.waitSessionTurns()
	if got := w.typedTexts(); len(got) != 1 || got[0] != "and then run the tests" {
		t.Fatalf("typed %q after the window went idle, want the message once", got)
	}
	if f.saidByMember(sessionAnswer) != 1 {
		t.Fatal("the answer did not come back")
	}
}

// A window that is never free: the message is held until Stop, and never
// typed.
func TestSessionTypingStopWhileHeldTypesNothing(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	w := newTypingWindow(t, f, "busy")
	f.l.deliverOwnerMessageToSession(f.slug, f.ownerPost("hello"))
	if !pollUntil(5*time.Second, func() bool { return f.notesSaying(sessionHeldNote) == 1 }) {
		t.Fatal("no note that the message is being held")
	}
	f.l.cancelSessionTurns(f.slug)
	f.l.waitSessionTurns()
	if len(w.typedTexts()) != 0 {
		t.Fatal("a stopped message was typed")
	}
	if f.notesSaying("it was stopped before the session was free to take it") != 1 {
		t.Fatal("no plain note that the held message was stopped")
	}
}

// The person closes the window while the message waits: it is then delivered
// the way a closed session is, by a background resume, and nothing is typed.
func TestSessionTypingWindowClosedWhileHeldFallsBackToResume(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	w := newTypingWindow(t, f, "busy")
	f.l.deliverOwnerMessageToSession(f.slug, f.ownerPost("bump the version"))
	if !pollUntil(5*time.Second, func() bool { return f.notesSaying(sessionHeldNote) == 1 }) {
		t.Fatal("no note that the message is being held")
	}
	w.set("", false)
	f.l.waitSessionTurns()
	if len(w.typedTexts()) != 0 {
		t.Fatal("typed into a window that had closed")
	}
	resumed := false
	for _, run := range f.started() {
		if run[0] == "claude" {
			resumed = true
		}
	}
	if !resumed || f.saidByMember(sessionAnswer) != 1 {
		t.Fatalf("a closed session was not resumed to answer: runs %v", f.started())
	}
}

// When typing cannot happen, the person is told why in plain words.
func TestSessionTypingFailuresSayWhyInPlainWords(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{termsend.ErrNoRoute, "this session runs in Ghostty, which gawkbot cannot type into yet"},
		{termsend.ErrNotPermitted, "System Settings, Privacy & Security, Automation"},
		{termsend.ErrNeedsLogin, "superset auth login"},
		{termsend.ErrNotForeground, "something else is running in its terminal right now"},
		{termsend.ErrUnsafeStart, "starts with /, !, or #"},
	} {
		t.Run(tc.err.Error(), func(t *testing.T) {
			f := newSessionMsgFixture(t, sessionToolClaude)
			w := newTypingWindow(t, f, "idle")
			w.err = tc.err
			f.deliver(f.ownerPost("hello"))
			if f.notesSaying(tc.want) != 1 {
				t.Fatalf("no note saying %q; notes: %v", tc.want, f.dmMessages(func(m channelMessage) bool { return m.From == "system" }))
			}
			if f.notesSaying(sessionTypedNote) != 0 {
				t.Fatal("said it was typed when it was not")
			}
		})
	}
}

// Open in something that is not a person's window (a background or SDK run):
// nothing can reach it, and the gate says so before anything is posted.
func TestSessionOpenInABackgroundProcessIsNotMessageable(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	o := sessionOpenness{known: true, open: map[string]agentdetect.OpenSession{
		f.sess.ID: {PID: typingPID, Interactive: false, Status: "idle"},
	}}
	f.setLastLook(o)
	f.look(o)
	wire := f.sessionWire()
	if wire["can_message"] == true || wire["message_block"] != sessionBlockOpen {
		t.Fatalf("a session held by a background process must not be messageable: %v", wire)
	}
}
