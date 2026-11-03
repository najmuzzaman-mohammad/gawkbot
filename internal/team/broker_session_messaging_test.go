//go:build darwin || linux

// The fake tools here are shell scripts, and the kill checks use process
// groups: neither exists on Windows.

package team

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/bot"
)

// sessionMsgFixture is an office with one session member and fake `claude`
// and `codex` binaries. Nothing here starts a real tool: the command seams
// point at shell scripts in a temp folder that record how they were run.
type sessionMsgFixture struct {
	t    *testing.T
	b    *Broker
	l    *Launcher
	sess agentdetect.Session
	slug string
	dm   string
	cwd  string
	// out is where the fake binaries write what they saw.
	out string
	now time.Time

	mu   sync.Mutex
	runs [][]string
}

const (
	claudeFinalLine = `{"type":"result","result":"Bumped the version to 1.4.0."}`
	codexFinalLine  = `{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Bumped the version to 1.4.0."}}`
	sessionAnswer   = "Bumped the version to 1.4.0."
)

// newSessionMsgFixture makes a session member for tool ("claude-code" or
// "codex") whose folder exists. A Claude Code session starts out open, as it
// must be to become a member at all; closeSession closes it.
func newSessionMsgFixture(t *testing.T, tool string) *sessionMsgFixture {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("WUPHF_RUNTIME_HOME", home)
	t.Setenv(sessionMessagingEnabledEnv, "1")
	// The office's own variables, which must never reach a session.
	t.Setenv("WUPHF_BROKER_TOKEN", "office-secret-token")
	t.Setenv("WUPHF_AGENT_SLUG", "cos")

	f := &sessionMsgFixture{t: t, b: newTestBroker(t), cwd: t.TempDir(), out: t.TempDir()}
	f.b.token = "owner-token"
	f.sess = claudeTestSession(testClaudeSessionID, "Fix the flaky checkout test")
	if tool == sessionToolCodex {
		f.sess = agentdetect.Session{
			ID: testCodexSessionID, Tool: "codex", ToolName: "Codex CLI", Title: "Port the importer",
			State: agentdetect.SessionYourTurn, UpdatedAt: "2026-10-10T09:00:00Z", Model: "gpt-5.5",
		}
	}
	f.sess.Cwd, f.sess.Project = f.cwd, filepath.Base(f.cwd)
	f.slug = sessionSlugCandidates(f.sess)[0]
	f.dm = DMSlugFor(f.slug)

	start := time.Now().Add(-time.Hour)
	open := f.openNow(true)
	f.b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{f.sess}, open, start)
	f.now = start.Add(sessionMemberMinAge + time.Second)
	f.b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{f.sess}, open, f.now)
	mustSessionMember(t, f.b, f.slug)

	f.l = &Launcher{pack: bot.GetPack("founding-team"), cwd: t.TempDir(), broker: f.b, headless: headlessWorkerPool{ctx: t.Context()}}
	f.b.SetHeadlessDispatchController(f.l)
	t.Cleanup(func() {
		f.l.cancelSessionTurns("")
		f.l.waitSessionTurns()
		// A fake that ended on its own leaves the child it started behind.
		raw, _ := os.ReadFile(filepath.Join(f.out, "children"))
		for _, line := range strings.Fields(string(raw)) {
			if pid, err := strconv.Atoi(line); err == nil && pid > 0 {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})
	f.fakeTools(fakeTool{stdout: claudeFinalLine}, fakeTool{stdout: codexFinalLine})
	stubLocalSessions(t, []agentdetect.Session{})
	// The session's log was last written long ago, unless a test says
	// otherwise: quiet, so the log check does not decide the other tests.
	f.logWritten(func() (time.Time, bool) { return time.Unix(0, 0), true })
	return f
}

// logWritten sets what reading the session's log's last write returns, for
// the registry's look and for the runner's last look before a resume.
func (f *sessionMsgFixture) logWritten(when func() (time.Time, bool)) {
	f.t.Helper()
	prev := sessionLogLastWriteFn
	sessionLogLastWriteFn = func(string) (time.Time, bool) { return when() }
	f.t.Cleanup(func() { sessionLogLastWriteFn = prev })
}

// openNow is the openness the tools report when the session is (or is not)
// open, and makes the runner's own last look report the same.
func (f *sessionMsgFixture) openNow(isOpen bool) sessionOpenness {
	f.t.Helper()
	o := openness()
	if isOpen {
		o = openness(f.sess.ID)
	}
	f.setLastLook(o)
	return o
}

// setLastLook sets what the runner's look immediately before a resume sees.
func (f *sessionMsgFixture) setLastLook(o sessionOpenness) {
	f.t.Helper()
	prev := sessionOpenNowFn
	sessionOpenNowFn = func(context.Context) (map[string]agentdetect.OpenSession, bool) { return o.open, o.known }
	f.t.Cleanup(func() { sessionOpenNowFn = prev })
}

// look runs the registry once more with the given openness.
func (f *sessionMsgFixture) look(o sessionOpenness, sessions ...agentdetect.Session) {
	f.t.Helper()
	if sessions == nil {
		sessions = []agentdetect.Session{f.sess}
	}
	f.now = f.now.Add(sessionReconcileEvery)
	f.b.reconcileSessionMembersWith(f.t.Context(), sessions, o, f.now)
}

// closeSession closes the session's window, as its tool reports it.
func (f *sessionMsgFixture) closeSession() {
	f.t.Helper()
	f.look(f.openNow(false))
}

// fakeTool is how a fake binary behaves. body, when set, replaces the whole
// behaviour and is run as shell.
type fakeTool struct {
	stdout, stderr string
	exit           int
	body           string
}

// fakeTools installs fake `claude` and `codex`. Each run records its argv,
// its environment, its folder, and its stdin under f.out, then behaves as
// told. A Codex run whose first argument is "queue" always succeeds.
func (f *sessionMsgFixture) fakeTools(claude, codex fakeTool) {
	f.t.Helper()
	script := func(name string, tool fakeTool) string {
		path := filepath.Join(f.out, name)
		var sh strings.Builder
		sh.WriteString("#!/bin/sh\n")
		fmt.Fprintf(&sh, "out=%q\n", f.out)
		sh.WriteString("n=$(ls \"$out\" | grep -c '^run-')\nrun=\"$out/run-$n\"\nmkdir \"$run\"\n")
		sh.WriteString("env > \"$run/env\"\npwd > \"$run/pwd\"\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"$run/args\"\n")
		if name == "codex" {
			sh.WriteString("if [ \"$1\" = queue ]; then exit 0; fi\n")
		}
		sh.WriteString("cat > \"$run/stdin\"\n")
		if tool.body != "" {
			sh.WriteString(tool.body + "\n")
		} else {
			fmt.Fprintf(&sh, "printf '%%s\\n' %q\nprintf '%%s' %q >&2\nexit %d\n", tool.stdout, tool.stderr, tool.exit)
		}
		if err := os.WriteFile(path, []byte(sh.String()), 0o755); err != nil {
			f.t.Fatalf("write fake %s: %v", name, err)
		}
		return path
	}
	claudePath, codexPath := script("claude", claude), script("codex", codex)
	seam := func(path string) func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return func(ctx context.Context, name string, args ...string) *exec.Cmd {
			f.mu.Lock()
			f.runs = append(f.runs, append([]string{name}, args...))
			f.mu.Unlock()
			return exec.CommandContext(ctx, path, args...)
		}
	}
	prevClaude, prevCodex, prevCLI := headlessClaudeCommandContext, headlessCodexCommandContext, headlessCLIAgentCommandContext
	prevClaudeLook, prevCodexLook := headlessClaudeLookPath, headlessCodexLookPath
	headlessClaudeCommandContext, headlessCodexCommandContext = seam(claudePath), seam(codexPath)
	headlessCLIAgentCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		f.t.Errorf("a message to a session started the CLI agent runner: %s %v", name, args)
		return exec.CommandContext(ctx, "true")
	}
	headlessClaudeLookPath = func(string) (string, error) { return claudePath, nil }
	headlessCodexLookPath = func(string) (string, error) { return codexPath, nil }
	f.t.Cleanup(func() {
		headlessClaudeCommandContext, headlessCodexCommandContext, headlessCLIAgentCommandContext = prevClaude, prevCodex, prevCLI
		headlessClaudeLookPath, headlessCodexLookPath = prevClaudeLook, prevCodexLook
	})
}

// started is every command started so far, binary name first.
func (f *sessionMsgFixture) started() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.runs...)
}

// runFile reads what run n recorded under name.
func (f *sessionMsgFixture) runFile(n int, name string) string {
	f.t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.out, "run-"+strconv.Itoa(n), name))
	if err != nil {
		f.t.Fatalf("run %d left no %s: %v", n, name, err)
	}
	return string(raw)
}

// sessionPost is one POST /messages, with what the request proves.
type sessionPost struct {
	From, Channel, Content, Kind string
	Tagged                       []string
	// Operator: the request carries this process's operator key, as the web
	// UI's own proxy stamps it. JoinedHuman: it is a joined human's session.
	Operator, JoinedHuman bool
}

// post sends p through the real handler and returns the stored message. A
// post the broker refuses is returned as it would have been stored, so the
// dispatcher is still tried with it: the gate must hold on its own.
func (f *sessionMsgFixture) post(p sessionPost) channelMessage {
	f.t.Helper()
	body, err := json.Marshal(map[string]any{"from": p.From, "channel": p.Channel, "content": p.Content, "kind": p.Kind, "tagged": p.Tagged})
	if err != nil {
		f.t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/messages", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.b.token)
	if p.Operator {
		req.Header.Set(dataOperatorHeader, f.b.dataOperatorKey)
	}
	actor := requestActor{Kind: requestActorKindBroker}
	if p.JoinedHuman {
		actor = requestActor{Kind: requestActorKindHuman, Slug: "alex", DisplayName: "Alex"}
	}
	rec := httptest.NewRecorder()
	f.b.handlePostMessage(rec, requestWithActor(req, actor))
	forged := channelMessage{ID: "msg-refused", From: p.From, Channel: p.Channel, Content: p.Content, Kind: p.Kind, Tagged: p.Tagged}
	if p.JoinedHuman {
		forged.From = humanMessageSender("alex")
	}
	if rec.Code != http.StatusOK {
		return forged
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp.ID == "" {
		f.t.Fatalf("post response %q: %v", rec.Body.String(), err)
	}
	f.b.mu.Lock()
	defer f.b.mu.Unlock()
	for _, msg := range f.b.messages {
		if msg.ID == resp.ID {
			return msg
		}
	}
	f.t.Fatalf("posted message %s is not in the log", resp.ID)
	return channelMessage{}
}

// ownerPost is the owner typing into the session's DM in the web UI.
func (f *sessionMsgFixture) ownerPost(content string) channelMessage {
	f.t.Helper()
	return f.post(sessionPost{From: "you", Channel: f.dm, Content: content, Operator: true})
}

// deliver hands msg to the dispatcher's session gate and waits for whatever
// it started to finish.
func (f *sessionMsgFixture) deliver(msg channelMessage) bool {
	f.t.Helper()
	took := f.l.deliverOwnerMessageToSession(f.slug, msg)
	f.l.waitSessionTurns()
	return took
}

// dmMessages are the messages in the session's DM matching keep.
func (f *sessionMsgFixture) dmMessages(keep func(channelMessage) bool) []channelMessage {
	var out []channelMessage
	for _, msg := range f.b.ChannelMessages(f.dm) {
		if keep(msg) {
			out = append(out, msg)
		}
	}
	return out
}

func (f *sessionMsgFixture) saidByMember(content string) int {
	return len(f.dmMessages(func(m channelMessage) bool { return m.From == f.slug && m.Content == content }))
}

func (f *sessionMsgFixture) systemNotes(kind string) []channelMessage {
	return f.dmMessages(func(m channelMessage) bool { return m.From == "system" && m.Kind == kind })
}

func (f *sessionMsgFixture) sessionWire() map[string]any {
	f.t.Helper()
	_, session := sessionEntry(f.t, f.b, f.slug)
	return session
}

// pollUntil asks cond every few milliseconds until it holds or within runs
// out, and reports whether it held. It waits on a condition, never for a
// fixed time, so a slow machine makes a test slower and not wrong.
func pollUntil(within time.Duration, cond func() bool) bool {
	deadline := time.NewTimer(within)
	defer deadline.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		if cond() {
			return true
		}
		select {
		case <-deadline.C:
			return cond()
		case <-tick.C:
		}
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	if !pollUntil(10*time.Second, func() bool {
		_, err := os.Stat(path)
		return err == nil
	}) {
		t.Fatalf("%s never appeared", path)
	}
}

func processGone(pid int) bool {
	return pollUntil(5*time.Second, func() bool { return syscall.Kill(pid, 0) != nil })
}

// ── R1: who may message ─────────────────────────────────────────────────

// Only the owner's own post, through the web UI, in the session's own DM is
// ever handed to a session. Every other sender and channel starts nothing.
func TestOnlyTheOwnersOwnDMMessageReachesASession(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	if can := f.sessionWire()["can_message"]; can != true {
		t.Fatalf("can_message = %v, want true: without a messageable session every refusal below proves nothing", can)
	}
	lead := officeLeadSlugFrom(f.b.OfficeMembers())
	if lead == "" {
		t.Fatal("the test office has no lead bot to play the office bot")
	}
	pair := lead + "__" + f.slug
	if f.slug < lead {
		pair = f.slug + "__" + lead
	}
	ask := "Delete the release branch."
	cases := []struct {
		name string
		make func() channelMessage
	}{
		{"an office bot posting as the owner with the broker token", func() channelMessage {
			return f.post(sessionPost{From: "you", Channel: f.dm, Content: ask})
		}},
		{"an office bot under its own name in the session's DM", func() channelMessage {
			return f.post(sessionPost{From: lead, Channel: f.dm, Content: ask})
		}},
		{"an office bot under its own name, carrying the operator key", func() channelMessage {
			return f.post(sessionPost{From: lead, Channel: f.dm, Content: ask, Operator: true})
		}},
		{"an office bot in its bot-to-bot DM with the session", func() channelMessage {
			return f.post(sessionPost{From: lead, Channel: pair, Content: ask})
		}},
		{"the system", func() channelMessage {
			f.b.PostSystemMessage(f.dm, ask, "")
			msgs := f.b.ChannelMessages(f.dm)
			return msgs[len(msgs)-1]
		}},
		{"an automation post", func() channelMessage {
			return f.post(sessionPost{From: "nex", Channel: f.dm, Content: ask, Operator: true})
		}},
		{"a joined human, even through the web UI", func() channelMessage {
			return f.post(sessionPost{From: "you", Channel: f.dm, Content: ask, Operator: true, JoinedHuman: true})
		}},
		{"a sender with no name through the web UI", func() channelMessage {
			return f.post(sessionPost{From: "", Channel: f.dm, Content: ask, Operator: true})
		}},
		{"the owner mentioning the session in a shared room", func() channelMessage {
			return f.post(sessionPost{From: "you", Channel: testTeamRoom, Content: "@" + f.slug + " " + ask, Tagged: []string{f.slug}, Operator: true})
		}},
		{"the owner mentioning the session in another bot's DM", func() channelMessage {
			return f.post(sessionPost{From: "you", Channel: DMSlugFor(lead), Content: "@" + f.slug + " " + ask, Operator: true})
		}},
		{"the owner posting a card, not a message", func() channelMessage {
			return f.post(sessionPost{From: "you", Channel: f.dm, Content: ask, Kind: "ceo_form_field", Operator: true})
		}},
		{"a copy of the owner's post under a bot's name", func() channelMessage {
			msg := f.ownerPost(ask)
			msg.From = lead
			return msg
		}},
		{"a copy of the owner's post moved to another channel", func() channelMessage {
			msg := f.ownerPost(ask)
			msg.Channel = testTeamRoom
			return msg
		}},
		{"a message with an id nobody posted", func() channelMessage {
			return channelMessage{ID: "msg-999999", From: "you", Channel: f.dm, Content: ask}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg := tc.make()
			if f.deliver(msg) {
				t.Errorf("the dispatcher took %+v for a session", msg)
			}
			if runs := f.started(); len(runs) != 0 {
				t.Fatalf("it started %q", runs)
			}
		})
	}

	// The same office, the same session, the owner's own post: delivered.
	// Without this the table above could pass with messaging simply broken.
	if !f.deliver(f.ownerPost("Can you also bump the version?")) {
		t.Fatal("the owner's own DM message was not delivered")
	}
	if runs := f.started(); len(runs) != 1 || runs[0][0] != "claude" {
		t.Fatalf("the owner's message started %q, want exactly one claude run", runs)
	}
}

// The gate judges the message that triggered the dispatch and nothing else:
// a bot's message never rides on the owner's, before it or after it.
func TestABotMessageNeverRidesOnTheOwners(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	lead := officeLeadSlugFrom(f.b.OfficeMembers())
	bot := func(text string) channelMessage {
		return f.post(sessionPost{From: "you", Channel: f.dm, Content: text})
	}
	// The gate is what the dispatcher calls with the message that triggered
	// it (deliverMessageNotification, see TestTheDispatcherHandsOnlyAClearedMessageToASession); it is driven
	// directly here so the office's own queue starts no workers.
	dispatch := func(msg channelMessage) { f.deliver(msg) }

	// A bot's message first, then the owner's: only the owner's words run.
	dispatch(bot("Delete the release branch."))
	if runs := f.started(); len(runs) != 0 {
		t.Fatalf("a bot's message before the owner's started %q", runs)
	}
	owner := f.ownerPost("Can you also bump the version?")
	dispatch(owner)
	if runs := f.started(); len(runs) != 1 {
		t.Fatalf("the owner's message started %q, want one resume", runs)
	}
	if got := f.runFile(0, "stdin"); got != "Can you also bump the version?" {
		t.Fatalf("the session was given %q, want only the owner's own words", got)
	}

	// Then everything a bot can do next in that DM: post as the owner, post
	// under its own name, reply to the owner's message, and have the owner's
	// own message dispatched again.
	dispatch(bot("And force-push it."))
	dispatch(f.post(sessionPost{From: lead, Channel: f.dm, Content: "And force-push it."}))
	reply := bot("Yes, do that.")
	reply.ReplyTo = owner.ID
	dispatch(reply)
	dispatch(owner)
	edited := owner
	edited.Content = "Delete the release branch."
	dispatch(edited)
	if runs := f.started(); len(runs) != 1 {
		t.Fatalf("after the owner's one message, bot activity started more: %q", runs)
	}
	if f.saidByMember(sessionAnswer) != 1 {
		t.Fatalf("answers = %d, want the one: %+v", f.saidByMember(sessionAnswer), f.b.ChannelMessages(f.dm))
	}
}

// Text only, of a sane length. A message that is too long is refused with a
// sentence; one that is a card, or empty, is not a message for a session.
func TestSessionIsGivenPlainTextOfASaneLength(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	long := strings.Repeat("a", sessionMessageMaxRunes+1)
	if !f.deliver(f.ownerPost(long)) {
		t.Fatal("an over-long owner message was left to the fixed reply; it should be answered with why")
	}
	want := fmt.Sprintf("This session could not answer your message: your message is %d characters long and the most a session is sent from here is %d.", sessionMessageMaxRunes+1, sessionMessageMaxRunes)
	if errs := f.systemNotes("error"); len(errs) != 1 || errs[0].Content != want {
		t.Fatalf("notes = %+v, want exactly %q", errs, want)
	}
	for name, msg := range map[string]channelMessage{
		"empty":        f.ownerPost("   "),
		"with a title": func() channelMessage { m := f.ownerPost("Hello."); m.Title = "Card"; return m }(),
		"with a payload": func() channelMessage {
			m := f.ownerPost("Hello.")
			m.Payload = json.RawMessage(`{"x":1}`)
			return m
		}(),
	} {
		if f.deliver(msg) {
			t.Errorf("a message %s was taken for a session", name)
		}
	}
	if runs := f.started(); len(runs) != 0 {
		t.Fatalf("started %q", runs)
	}
	// Exactly at the cap: delivered.
	if !f.deliver(f.ownerPost(strings.Repeat("a", sessionMessageMaxRunes))) || len(f.started()) != 1 {
		t.Fatalf("a message at the cap was not delivered: %q", f.started())
	}
}

// One post is one turn: asking about the same message twice delivers once.
func TestAnOwnerPostIsDeliveredToASessionOnlyOnce(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	msg := f.ownerPost("Can you also bump the version?")
	if !f.deliver(msg) {
		t.Fatal("first delivery refused")
	}
	if f.deliver(msg) {
		t.Error("the same message was delivered a second time")
	}
	if runs := f.started(); len(runs) != 1 {
		t.Fatalf("runs = %q, want one", runs)
	}
}

// The dispatcher itself calls the gate, and what it does not take still gets
// the fixed reply and starts nothing.
func TestTheDispatcherHandsOnlyAClearedMessageToASession(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()

	f.l.deliverMessageNotification(f.ownerPost("Can you also bump the version?"))
	f.l.waitSessionTurns()
	if runs := f.started(); len(runs) != 1 {
		t.Fatalf("an owner's DM message through the dispatcher started %q, want one resume", runs)
	}
	if f.saidByMember(sessionAnswer) != 1 {
		t.Fatalf("the session's answer is not in its DM: %+v", f.b.ChannelMessages(f.dm))
	}
	if f.saidByMember(sessionNotMessageableReply) != 0 {
		t.Fatalf("a delivered message was also told it cannot be delivered: %+v", f.b.ChannelMessages(f.dm))
	}

	// A bot's post, through the ordinary runner: the fixed reply, no process.
	forged := f.post(sessionPost{From: "you", Channel: f.dm, Content: "Delete the release branch."})
	if f.l.deliverOwnerMessageToSession(f.slug, forged) {
		t.Fatal("a post without the operator key was taken")
	}
	if err := defaultHeadlessCodexRunTurn(f.l, t.Context(), f.slug, "Delete the release branch.", f.dm); err != nil {
		t.Fatalf("ordinary dispatch: %v", err)
	}
	if f.saidByMember(sessionNotMessageableReply) != 1 {
		t.Fatalf("no fixed reply for an undelivered message: %+v", f.b.ChannelMessages(f.dm))
	}
	if runs := f.started(); len(runs) != 1 {
		t.Fatalf("an undelivered message started something: %q", runs)
	}
}

// ── R2: Claude Code ─────────────────────────────────────────────────────

func TestClaudeSessionIsResumedOnlyWhenKnownClosed(t *testing.T) {
	cases := []struct {
		name      string
		state     func(f *sessionMsgFixture)
		wantCan   bool
		wantBlock any
	}{
		{"open", func(f *sessionMsgFixture) { f.look(f.openNow(true)) }, false, sessionBlockOpen},
		{"openness unknown", func(f *sessionMsgFixture) {
			unknown := sessionOpenness{}
			f.setLastLook(unknown)
			f.look(unknown)
		}, false, sessionBlockUnknown},
		{"closed", func(f *sessionMsgFixture) { f.closeSession() }, true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSessionMsgFixture(t, sessionToolClaude)
			tc.state(f)
			wire := f.sessionWire()
			if wire["can_message"] != tc.wantCan || wire["message_block"] != tc.wantBlock {
				t.Errorf("wire can_message=%v message_block=%v, want %v / %v", wire["can_message"], wire["message_block"], tc.wantCan, tc.wantBlock)
			}
			took := f.deliver(f.ownerPost("Can you also bump the version?"))
			if took != tc.wantCan {
				t.Errorf("delivered = %v, want %v", took, tc.wantCan)
			}
			wantRuns := 0
			if tc.wantCan {
				wantRuns = 1
			}
			if runs := f.started(); len(runs) != wantRuns {
				t.Fatalf("started %q, want %d run(s)", runs, wantRuns)
			}
		})
	}
}

// The registry said this session was closed. Its log was being written the
// same second: it was live, and missing from the registry because its entry
// could not be read. Closed in the registry is not enough to resume.
func TestClaudeSessionBeingWrittenIsNotResumedWhateverTheRegistrySays(t *testing.T) {
	cases := []struct {
		name string
		// when is the log's last write relative to the moment it is read.
		when    func(f *sessionMsgFixture) (time.Time, bool)
		wantCan bool
	}{
		{"written this second", func(f *sessionMsgFixture) (time.Time, bool) { return f.now, true }, false},
		{"written a minute ago", func(f *sessionMsgFixture) (time.Time, bool) { return f.now.Add(-time.Minute), true }, false},
		{"written just inside the margin", func(f *sessionMsgFixture) (time.Time, bool) {
			return f.now.Add(-sessionQuietMargin + time.Second), true
		}, false},
		{"still for the whole margin", func(f *sessionMsgFixture) (time.Time, bool) { return f.now.Add(-sessionQuietMargin), true }, true},
		{"no log to be found", func(f *sessionMsgFixture) (time.Time, bool) { return time.Time{}, false }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSessionMsgFixture(t, sessionToolClaude)
			f.logWritten(func() (time.Time, bool) { return tc.when(f) })
			f.closeSession() // the registry: closed
			wire := f.sessionWire()
			if wire["can_message"] != tc.wantCan {
				t.Fatalf("can_message = %v, want %v (block %v)", wire["can_message"], tc.wantCan, wire["message_block"])
			}
			if !tc.wantCan && wire["message_block"] != sessionBlockOpen {
				t.Errorf("message_block = %v, want %q: to the person it is open", wire["message_block"], sessionBlockOpen)
			}
			if took := f.deliver(f.ownerPost("Can you also bump the version?")); took != tc.wantCan {
				t.Errorf("delivered = %v, want %v", took, tc.wantCan)
			}
			f.l.waitSessionTurns()
			// The runner reads the wall clock, where f.now is an hour old, so
			// only the "nothing may start" half is asserted here; the runner's
			// own last look has its own test below.
			if !tc.wantCan {
				if runs := f.started(); len(runs) != 0 {
					t.Fatalf("a resume was started against a session being written: %q", runs)
				}
			}
		})
	}
}

// The gate works from the registry's last look, a few seconds old. The
// runner reads the log again immediately before it starts anything: a
// session someone began typing into in between must not be resumed.
func TestClaudeResumeReadsTheLogAgainRightBeforeItStarts(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	if f.sessionWire()["can_message"] != true {
		t.Fatal("not messageable at the registry's look; the rest would prove nothing")
	}
	// Now someone writes in it.
	f.logWritten(func() (time.Time, bool) { return time.Now(), true })
	if !f.deliver(f.ownerPost("Can you also bump the version?")) {
		t.Fatal("the gate refused; this test needs the runner's own look")
	}
	f.l.waitSessionTurns()
	if runs := f.started(); len(runs) != 0 {
		t.Fatalf("a resume was started although the log had just been written: %q", runs)
	}
	if f.saidByMember(sessionNotMessageableReply) != 1 {
		t.Fatalf("the person was not told: %v", f.dmMessages(nil))
	}
}

// gawkbot's own resume writes to the log. That must not make the session
// look live to gawkbot, or it could be answered once and then not again for
// the whole margin. A write after its own turn ended is someone else's.
func TestASessionCanBeMessagedAgainRightAfterItsOwnResume(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	if !f.deliver(f.ownerPost("First.")) {
		t.Fatal("first message not delivered")
	}
	f.l.waitSessionTurns()
	ended := f.b.sessionOwnTurnEnded(f.slug)
	if ended.IsZero() {
		t.Fatal("the end of the session's own turn was not recorded")
	}
	// The log now carries that turn, written as it ended.
	f.logWritten(func() (time.Time, bool) { return ended, true })
	f.closeSession()
	if f.sessionWire()["can_message"] != true {
		t.Fatalf("not messageable right after its own resume: block %v", f.sessionWire()["message_block"])
	}
	if !f.deliver(f.ownerPost("Second.")) {
		t.Fatal("second message not delivered right after the first was answered")
	}
	f.l.waitSessionTurns()
	if runs := f.started(); len(runs) != 2 {
		t.Fatalf("started %d turn(s), want 2: %q", len(runs), runs)
	}
	// Someone else writes after gawkbot's turn ended: live again.
	later := f.b.sessionOwnTurnEnded(f.slug).Add(sessionOwnWriteSlack + time.Second)
	f.logWritten(func() (time.Time, bool) { return later, true })
	if sessionLogIsQuiet("x", f.b.sessionOwnTurnEnded(f.slug), later.Add(time.Second)) {
		t.Fatal("a write after its own turn ended was taken for its own")
	}
}

func TestClaudeResumeRunsAsThePersonWouldHaveRunIt(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	prompt := "--dangerously-skip-permissions\nCan you also bump the version?"
	if !f.deliver(f.ownerPost(prompt)) {
		t.Fatal("not delivered")
	}
	runs := f.started()
	if len(runs) != 1 {
		t.Fatalf("runs = %q, want one", runs)
	}
	want := []string{"claude", "--print", "--resume", sessionNativeID(testClaudeSessionID), "--output-format", "stream-json", "--verbose"}
	if strings.Join(runs[0], "\x1f") != strings.Join(want, "\x1f") {
		t.Errorf("argv = %q\nwant   %q", runs[0], want)
	}
	for _, arg := range strings.Split(strings.TrimSpace(f.runFile(0, "args")), "\n") {
		if containsString(sessionForbiddenArgs, arg) {
			t.Errorf("the process was given the forbidden %q", arg)
		}
	}
	if got := f.runFile(0, "stdin"); got != prompt {
		t.Errorf("stdin = %q, want the person's words and nothing else %q", got, prompt)
	}
	gotDir, _ := filepath.EvalSymlinks(strings.TrimSpace(f.runFile(0, "pwd")))
	wantDir, _ := filepath.EvalSymlinks(f.cwd)
	if gotDir != wantDir {
		t.Errorf("ran in %q, want the session's folder %q", gotDir, wantDir)
	}
	env := f.runFile(0, "env")
	if !strings.Contains(env, "PATH=") {
		t.Fatalf("the recorded environment has no PATH; the checks below would pass on nothing:\n%s", env)
	}
	for _, line := range strings.Split(env, "\n") {
		if strings.HasPrefix(strings.ToUpper(line), "WUPHF_") {
			t.Errorf("the office variable %q reached the session's process", line)
		}
	}
	if strings.Contains(env, "office-secret-token") {
		t.Error("the broker token reached the session's process")
	}
}

// The window can reopen between the message and the resume. The last look,
// immediately before anything starts, decides.
func TestClaudeResumeIsCheckedAgainImmediatelyBeforeItStarts(t *testing.T) {
	for _, tc := range []struct {
		name string
		last func(f *sessionMsgFixture) sessionOpenness
		// told is how the person hears that nothing ran: the fixed reply,
		// or, for a session now held by a process that is not a window
		// (openness() makes no window), a plain note saying exactly that.
		told func(f *sessionMsgFixture) bool
	}{
		{"reopened since", func(f *sessionMsgFixture) sessionOpenness { return openness(f.sess.ID) },
			func(f *sessionMsgFixture) bool {
				return f.notesSaying("open in a background process, not a terminal window") == 1
			}},
		{"no longer known", func(*sessionMsgFixture) sessionOpenness { return sessionOpenness{} },
			func(f *sessionMsgFixture) bool { return f.saidByMember(sessionNotMessageableReply) == 1 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newSessionMsgFixture(t, sessionToolClaude)
			f.closeSession()
			msg := f.ownerPost("Can you also bump the version?")
			// The registry still says closed; the tool, asked now, does not.
			f.setLastLook(tc.last(f))
			if !f.deliver(msg) {
				t.Fatal("the gate refused a message the registry called deliverable; this test needs it to reach the runner")
			}
			if runs := f.started(); len(runs) != 0 {
				t.Fatalf("a resume ran against a session that is not known closed: %q", runs)
			}
			if !tc.told(f) {
				t.Fatalf("not told why nothing ran: %+v", f.b.ChannelMessages(f.dm))
			}
		})
	}
}

func TestSessionWhoseFolderIsGoneIsNotResumed(t *testing.T) {
	for _, tool := range []string{sessionToolClaude, sessionToolCodex} {
		t.Run(tool, func(t *testing.T) {
			f := newSessionMsgFixture(t, tool)
			f.closeSession()
			msg := f.ownerPost("Can you also bump the version?")
			if err := os.RemoveAll(f.cwd); err != nil {
				t.Fatal(err)
			}
			// Gone since the registry's last look: the runner's own check.
			if !f.deliver(msg) {
				t.Fatal("the gate refused before the registry had looked; this half needs the runner's check")
			}
			if runs := f.started(); len(runs) != 0 {
				t.Fatalf("ran in a folder that is gone: %q", runs)
			}
			if f.saidByMember(sessionNotMessageableReply) != 1 {
				t.Fatalf("no fixed reply: %+v", f.b.ChannelMessages(f.dm))
			}
			// Once the registry has looked, the gate and the wire say so.
			f.look(f.openNow(false))
			wire := f.sessionWire()
			if wire["can_message"] != false || wire["message_block"] != sessionBlockFolderGone {
				t.Errorf("wire = can_message %v, message_block %v; want false, %q", wire["can_message"], wire["message_block"], sessionBlockFolderGone)
			}
			if f.deliver(f.ownerPost("Still there?")) {
				t.Error("delivered to a session whose folder is gone")
			}
		})
	}
}

// Two messages to one session never run two resumes at once: the second
// waits behind the first.
func TestMessagesToOneSessionRunOneAtATime(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	log := filepath.Join(f.out, "order")
	f.fakeTools(fakeTool{body: fmt.Sprintf("echo start >> %q\nsleep 0.4\necho end >> %q\nprintf '%%s\\n' %q", log, log, claudeFinalLine)}, fakeTool{})
	first, second := f.ownerPost("First."), f.ownerPost("Second.")
	if !f.l.deliverOwnerMessageToSession(f.slug, first) || !f.l.deliverOwnerMessageToSession(f.slug, second) {
		t.Fatal("a message was refused; the second must queue, not be dropped")
	}
	f.l.waitSessionTurns()
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Fields(string(raw)); strings.Join(got, " ") != "start end start end" {
		t.Fatalf("resumes overlapped or went missing: %q", got)
	}
	if f.runFile(0, "stdin") != "First." || f.runFile(1, "stdin") != "Second." {
		t.Errorf("order = %q then %q, want First. then Second.", f.runFile(0, "stdin"), f.runFile(1, "stdin"))
	}
}

// ── R3: Codex ───────────────────────────────────────────────────────────

func TestCodexSessionResumeQueueAndFailure(t *testing.T) {
	native := sessionNativeID(testCodexSessionID)
	resume := []string{"codex", "exec", "--json", "resume", native, "-"}
	prompt := "Can you also bump the version?"
	queue := []string{"codex", "queue", "--thread", native, "--message=" + prompt}
	cases := []struct {
		name      string
		codex     fakeTool
		wantRuns  [][]string
		wantReply string
		wantNote  bool
		wantError string
	}{
		{"ended session: resumed", fakeTool{stdout: codexFinalLine}, [][]string{resume}, sessionAnswer, true, ""},
		{
			"open session: refused, then queued",
			fakeTool{stderr: "Error: thread " + native + " already has an active writer", exit: 1},
			[][]string{resume, queue}, "", false, "",
		},
		{
			"any other failure: reported, never queued",
			fakeTool{stderr: "Error: stream disconnected before completion\nstack: secret-internal-detail", exit: 1},
			[][]string{resume}, "", false, "This session could not answer your message: Codex exited with an error.",
		},
		{
			"failure with the tool's own error: one line of it",
			fakeTool{stdout: `{"type":"error","message":"You have hit your usage limit."}`, stderr: "secret-internal-detail", exit: 1},
			[][]string{resume}, "", false, "This session could not answer your message: Codex reported an error: You have hit your usage limit.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSessionMsgFixture(t, sessionToolCodex)
			f.fakeTools(fakeTool{}, tc.codex)
			if !f.deliver(f.ownerPost(prompt)) {
				t.Fatal("not delivered")
			}
			runs := f.started()
			if fmt.Sprint(runs) != fmt.Sprint(tc.wantRuns) {
				t.Fatalf("ran  %q\nwant %q", runs, tc.wantRuns)
			}
			for n := range runs {
				for _, arg := range strings.Split(strings.TrimSpace(f.runFile(n, "args")), "\n") {
					if containsString(sessionForbiddenArgs, arg) {
						t.Errorf("run %d was given the forbidden %q", n, arg)
					}
				}
				if env := f.runFile(n, "env"); strings.Contains(strings.ToUpper(env), "\nWUPHF_") || strings.HasPrefix(strings.ToUpper(env), "WUPHF_") || strings.Contains(env, "office-secret-token") {
					t.Errorf("run %d saw the office's environment", n)
				}
			}
			if got := f.runFile(0, "stdin"); got != prompt {
				t.Errorf("resume stdin = %q, want %q", got, prompt)
			}
			if tc.wantReply != "" && f.saidByMember(tc.wantReply) != 1 {
				t.Errorf("replies %q = %d, want 1; DM = %+v", tc.wantReply, f.saidByMember(tc.wantReply), f.b.ChannelMessages(f.dm))
			}
			if got := len(f.systemNotes(sessionResumedNoteKind)); (got == 1) != tc.wantNote {
				t.Errorf("resumed notes = %d, want one: %v", got, tc.wantNote)
			}
			// Handed to an open window: one note saying so, and nothing
			// posted as the session's own words.
			delivered := f.systemNotes(sessionDeliveredNoteKind)
			if queued := len(tc.wantRuns) == 2; queued != (len(delivered) == 1) {
				t.Errorf("delivered notes = %+v, want one exactly when the message was queued", delivered)
			}
			if len(delivered) == 1 && delivered[0].Content != "Delivered to this session's window. Its answer will appear there." {
				t.Errorf("delivered note = %q", delivered[0].Content)
			}
			if len(tc.wantRuns) == 2 && len(f.dmMessages(func(m channelMessage) bool { return m.From == f.slug })) != 0 {
				t.Errorf("something was posted as the session's own words after a queue delivery: %+v", f.b.ChannelMessages(f.dm))
			}
			errs := f.systemNotes("error")
			if tc.wantError == "" && len(errs) != 0 {
				t.Errorf("unexpected failure note: %+v", errs)
			}
			if tc.wantError != "" && (len(errs) != 1 || errs[0].Content != tc.wantError) {
				t.Errorf("failure notes = %+v, want exactly %q", errs, tc.wantError)
			}
			for _, msg := range f.b.ChannelMessages(f.dm) {
				if strings.Contains(msg.Content, "secret-internal-detail") || strings.Contains(msg.Content, "stream disconnected") {
					t.Errorf("the tool's raw error output was posted: %q", msg.Content)
				}
			}
		})
	}
}

// ── R4: the reply ───────────────────────────────────────────────────────

func TestSessionResumeReplyNoteAndFailureSentence(t *testing.T) {
	t.Run("answer and note, once each", func(t *testing.T) {
		f := newSessionMsgFixture(t, sessionToolClaude)
		f.closeSession()
		if !f.deliver(f.ownerPost("Can you also bump the version?")) {
			t.Fatal("not delivered")
		}
		if got := f.saidByMember(sessionAnswer); got != 1 {
			t.Fatalf("answers in the DM = %d, want 1: %+v", got, f.b.ChannelMessages(f.dm))
		}
		notes := f.systemNotes(sessionResumedNoteKind)
		if len(notes) != 1 {
			t.Fatalf("resumed notes = %d, want 1", len(notes))
		}
		wantCmd := "claude --resume " + sessionNativeID(testClaudeSessionID)
		if !strings.Contains(notes[0].Content, wantCmd) || !strings.Contains(notes[0].Content, "resumed in the background") {
			t.Errorf("note = %q, want it to say it was resumed in the background and give %q", notes[0].Content, wantCmd)
		}
		if strings.ContainsAny(notes[0].Content, "—–") {
			t.Errorf("note uses a dash: %q", notes[0].Content)
		}
	})
	failures := []struct {
		name   string
		claude fakeTool
		want   string
	}{
		{"non-zero exit", fakeTool{stderr: "TypeError: secret-internal-detail\n  at x (y.js:1)", exit: 3}, "This session could not answer your message: Claude Code exited with an error."},
		{
			"non-zero exit with the tool's own reason",
			fakeTool{stdout: `{"type":"result","is_error":true,"result":"Not logged in. Please run /login"}`, stderr: "secret-internal-detail", exit: 1},
			"This session could not answer your message: Claude Code reported an error: Not logged in. Please run /login.",
		},
		{"nothing parseable", fakeTool{stdout: "not json at all... wait, it is not"}, "This session could not answer your message: it finished without an answer that could be read."},
		{"no output", fakeTool{}, "This session could not answer your message: it finished without an answer that could be read."},
	}
	for _, tc := range failures {
		t.Run(tc.name, func(t *testing.T) {
			f := newSessionMsgFixture(t, sessionToolClaude)
			f.closeSession()
			f.fakeTools(tc.claude, fakeTool{})
			if !f.deliver(f.ownerPost("Can you also bump the version?")) {
				t.Fatal("not delivered")
			}
			errs := f.systemNotes("error")
			if len(errs) != 1 || errs[0].Content != tc.want {
				t.Fatalf("failure notes = %+v, want exactly %q", errs, tc.want)
			}
			if len(f.systemNotes(sessionResumedNoteKind)) != 0 {
				t.Error("a failed resume left a resumed note")
			}
			for _, msg := range f.b.ChannelMessages(f.dm) {
				if strings.Contains(msg.Content, "secret-internal-detail") {
					t.Errorf("raw stderr was posted: %q", msg.Content)
				}
			}
		})
	}
}

// ── R5: limits ──────────────────────────────────────────────────────────

// holdingTool is a fake that starts a child, says it has started, and then
// waits: for a file named release, or to be killed.
func (f *sessionMsgFixture) holdingTool(final string) fakeTool {
	return fakeTool{body: fmt.Sprintf(
		"sleep 300 >/dev/null 2>&1 &\necho $! > %q\necho $! >> %q\ntouch %q\nwhile [ ! -f %q ]; do sleep 0.05; done\nprintf '%%s\\n' %q",
		filepath.Join(f.out, "child"), filepath.Join(f.out, "children"), filepath.Join(f.out, "holding"), filepath.Join(f.out, "release"), final)}
}

func (f *sessionMsgFixture) heldChild() int {
	f.t.Helper()
	waitForFile(f.t, filepath.Join(f.out, "holding"))
	raw, err := os.ReadFile(filepath.Join(f.out, "child"))
	if err != nil {
		f.t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		f.t.Fatalf("child pid %q: %v", raw, err)
	}
	return pid
}

func TestSessionResumeTimesOutAndKillsItsWholeProcessGroup(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	f.fakeTools(f.holdingTool(claudeFinalLine), fakeTool{})
	prev := sessionTurnTimeout
	sessionTurnTimeout = 2 * time.Second
	t.Cleanup(func() { sessionTurnTimeout = prev })

	if !f.l.deliverOwnerMessageToSession(f.slug, f.ownerPost("Can you also bump the version?")) {
		t.Fatal("not delivered")
	}
	child := f.heldChild()
	f.l.waitSessionTurns()
	if !processGone(child) {
		_ = syscall.Kill(child, syscall.SIGKILL)
		t.Fatal("the resume's child process outlived the timeout: the process group was not killed")
	}
	errs := f.systemNotes("error")
	want := "This session could not answer your message: it did not finish within 2s and was stopped."
	if len(errs) != 1 || errs[0].Content != want {
		t.Fatalf("failure notes = %+v, want exactly %q", errs, want)
	}
	if f.saidByMember(sessionAnswer) != 0 {
		t.Error("a timed-out resume posted an answer")
	}
}

// Stop is the office's own Stop control (the governor calls
// CancelHeadlessTurns): it kills the running resume and drops what waits.
func TestStopCancelsARunningSessionResume(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	f.fakeTools(f.holdingTool(claudeFinalLine), fakeTool{})
	if !f.l.deliverOwnerMessageToSession(f.slug, f.ownerPost("First.")) || !f.l.deliverOwnerMessageToSession(f.slug, f.ownerPost("Second.")) {
		t.Fatal("not delivered")
	}
	child := f.heldChild()
	f.l.CancelHeadlessTurns(f.slug)
	drained := make(chan struct{})
	go func() {
		f.l.waitSessionTurns()
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(10 * time.Second):
		// Let the fake finish so the test can end, then say what went wrong.
		_ = os.WriteFile(filepath.Join(f.out, "release"), nil, 0o644)
		_ = syscall.Kill(child, syscall.SIGKILL)
		<-drained
		t.Fatal("Stop did not end the running resume within 10 seconds")
	}
	if !processGone(child) {
		_ = syscall.Kill(child, syscall.SIGKILL)
		t.Fatal("Stop left the resume's child process running")
	}
	if runs := f.started(); len(runs) != 1 {
		t.Fatalf("after Stop the waiting message still ran: %q", runs)
	}
	var got []string
	for _, note := range f.systemNotes("error") {
		got = append(got, note.Content)
	}
	want := []string{
		"This session could not answer your message: it was stopped before it took this message.",
		"This session could not answer your message: it was stopped.",
	}
	if len(got) != 2 || !containsString(got, want[0]) || !containsString(got, want[1]) {
		t.Fatalf("notes after Stop = %q, want %q", got, want)
	}
}

// A background resume is the session's own activity. While it runs the
// member is not shown as closed, and the log it writes to is not taken for
// a new session.
func TestBackgroundResumeIsNotASecondMemberAndNotClosed(t *testing.T) {
	f := newSessionMsgFixture(t, sessionToolClaude)
	f.closeSession()
	if wire := f.sessionWire(); wire["live"] != false {
		t.Fatalf("a closed session reads live=%v before the resume; the checks below would prove nothing", wire["live"])
	}
	f.fakeTools(f.holdingTool(claudeFinalLine), fakeTool{})
	if !f.l.deliverOwnerMessageToSession(f.slug, f.ownerPost("Can you also bump the version?")) {
		t.Fatal("not delivered")
	}
	// This resume ends on its own, so nothing kills what the fake started.
	child := f.heldChild()
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })

	check := func(when string) {
		t.Helper()
		entry, wire := sessionEntry(t, f.b, f.slug)
		if wire["live"] != true || wire["state"] != agentdetect.SessionWorking {
			t.Errorf("%s: live=%v state=%v, want a running, working session", when, wire["live"], wire["state"])
		}
		if entry["status"] != "active" {
			t.Errorf("%s: status = %v, want active", when, entry["status"])
		}
		if got := sessionMemberSlugs(f.b); len(got) != 1 {
			t.Errorf("%s: session members = %v, want the one", when, got)
		}
	}
	check("as the resume starts")
	// The registry looks while the resume writes to the log: same session
	// id, newer write, and its tool still lists it as not open.
	writing := f.sess
	writing.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	for i := 0; i < 3; i++ {
		f.look(openness(), writing)
		check(fmt.Sprintf("registry look %d during the resume", i+1))
	}
	// And when it has dropped out of the scanner's list altogether.
	f.b.reconcileSessionMembersWith(t.Context(), []agentdetect.Session{}, openness(), f.now.Add(time.Second))
	check("unlisted during the resume")

	if err := os.WriteFile(filepath.Join(f.out, "release"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	f.l.waitSessionTurns()
	f.look(openness(), writing)
	if wire := f.sessionWire(); wire["live"] != false {
		t.Errorf("after the resume ended the closed session still reads live=%v", wire["live"])
	}
	if got := sessionMemberSlugs(f.b); len(got) != 1 {
		t.Errorf("session members after the resume = %v, want the one", got)
	}
	if f.saidByMember(sessionAnswer) != 1 {
		t.Errorf("the answer was not posted: %+v", f.b.ChannelMessages(f.dm))
	}
}

// ── R6: can_message on the wire ─────────────────────────────────────────

func TestCanMessageIsOnBothRoutesForTheOwnerOnly(t *testing.T) {
	notchRow := func(t *testing.T, f *sessionMsgFixture, token string) (row map[string]any, body string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/notch/state", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		f.b.handleNotchState(rec, req)
		var raw struct {
			Agents []map[string]any `json:"agents"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("notch state: %v: %s", err, rec.Body.String())
		}
		if len(raw.Agents) == 0 {
			t.Fatal("the notch lists no agents; the assertions below would pass on nothing")
		}
		for _, a := range raw.Agents {
			if a["slug"] == f.slug {
				row = a
			}
		}
		return row, rec.Body.String()
	}
	cases := []struct {
		name      string
		tool      string
		state     func(f *sessionMsgFixture)
		wantCan   bool
		wantBlock any
	}{
		{"claude, closed", sessionToolClaude, func(f *sessionMsgFixture) { f.closeSession() }, true, nil},
		{"claude, open", sessionToolClaude, func(f *sessionMsgFixture) { f.look(f.openNow(true)) }, false, sessionBlockOpen},
		{"claude, openness unknown", sessionToolClaude, func(f *sessionMsgFixture) { f.look(sessionOpenness{}) }, false, sessionBlockUnknown},
		{"claude, closed, folder gone", sessionToolClaude, func(f *sessionMsgFixture) {
			if err := os.RemoveAll(f.cwd); err != nil {
				f.t.Fatal(err)
			}
			f.closeSession()
		}, false, sessionBlockFolderGone},
		{"codex", sessionToolCodex, func(f *sessionMsgFixture) { f.look(sessionOpenness{}) }, true, nil},
		{"codex, folder gone", sessionToolCodex, func(f *sessionMsgFixture) {
			if err := os.RemoveAll(f.cwd); err != nil {
				f.t.Fatal(err)
			}
			f.look(sessionOpenness{})
		}, false, sessionBlockFolderGone},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSessionMsgFixture(t, tc.tool)
			tc.state(f)
			wire := f.sessionWire()
			if wire["can_message"] != tc.wantCan || wire["message_block"] != tc.wantBlock {
				t.Errorf("/office-members: can_message=%v message_block=%v, want %v / %v", wire["can_message"], wire["message_block"], tc.wantCan, tc.wantBlock)
			}
			row, _ := notchRow(t, f, f.b.token)
			if row == nil {
				t.Fatalf("the owner's notch has no row for @%s", f.slug)
			}
			// On the notch the field is present only when true.
			wantNotch := any(nil)
			if tc.wantCan {
				wantNotch = true
			}
			if row["can_message"] != wantNotch {
				t.Errorf("/notch/state: can_message=%v, want %v", row["can_message"], wantNotch)
			}

			// Without the owner's token: no session row, and the field nowhere.
			row, body := notchRow(t, f, "")
			if row != nil || strings.Contains(body, "can_message") {
				t.Errorf("a caller without the owner's token saw the session or can_message: %s", body)
			}
			for _, m := range fetchOfficeMembers(t, f.b, "") {
				if m["slug"] == f.slug {
					t.Errorf("a caller without the owner's token was served the session member: %v", m)
				}
				if raw, _ := json.Marshal(m); strings.Contains(string(raw), "can_message") {
					t.Errorf("can_message served without the owner's token: %s", raw)
				}
			}
		})
	}
}
