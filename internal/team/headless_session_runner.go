package team

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/gitexec"
	"github.com/nex-crm/wuphf/internal/provider"
)

// Running a message to a terminal session. The commands themselves are in
// headless_session_turn.go and who may send one in
// broker_session_messaging.go; this file runs them.
//
// It deliberately does not go through the office's turn queue. That queue
// cancels a running turn when the person writes again, retries a failed turn
// with a recovery prompt, and blocks tasks: all right for the office's own
// bots and all wrong for a person's session, where a resume must run once,
// to the end, with the person's words and nothing added.
//
// One session, one turn at a time: a second message waits behind the first
// (queued, never refused), because two resumes of one session at once would
// write two conversations into one log.

// sessionOpenNowFn asks the tools, right now and not from any cache, which
// Claude Code sessions are open. Swapped by tests.
var sessionOpenNowFn = func(ctx context.Context) (map[string]agentdetect.OpenSession, bool) {
	scanner := agentdetect.NewScanner()
	scanner.Scan(ctx)
	return scanner.OpenSessions()
}

// sessionLogLastWriteFn reads, right now, when a Claude Code session's log
// was last written. Swapped by tests.
var sessionLogLastWriteFn = func(nativeID string) (time.Time, bool) {
	return agentdetect.NewScanner().ClaudeLogLastWrite(nativeID)
}

// sessionQuietMargin is how long a Claude Code session's log must have been
// still before it may be resumed in the background. Claude Code's list of
// open sessions is the first check and this is the second, and it does not
// depend on the first: a session whose log is being written is live, whatever
// the list says. In a real run a live session was missing from the list (its
// entry could not be read) and read as closed; its log had been written the
// same second. A resume then would have forked its conversation.
const sessionQuietMargin = 3 * time.Minute

// sessionOwnWriteSlack is how much later than the end of gawkbot's own
// background turn a log write may be and still count as that turn's: the
// tool flushes its last records as it exits.
const sessionOwnWriteSlack = 5 * time.Second

// sessionLogIsQuiet reports whether a Claude Code session's log has been
// still for sessionQuietMargin. A log that cannot be found is not quiet:
// nothing is known about it.
//
// ownTurnEnded is when gawkbot's own last background turn in this session
// finished (zero if none). A resume writes to the log, so without this a
// session could be answered once and then not again for the whole margin.
// A write no later than that turn's end is gawkbot's own and does not make
// the session live; any write after it is someone else's and does.
func sessionLogIsQuiet(nativeID string, ownTurnEnded, now time.Time) bool {
	last, found := sessionLogLastWriteFn(nativeID)
	if !found {
		return false
	}
	if !ownTurnEnded.IsZero() && !last.After(ownTurnEnded.Add(sessionOwnWriteSlack)) {
		return true
	}
	return now.Sub(last) >= sessionQuietMargin
}

const (
	// sessionQueueMax is how many messages may wait behind a session's
	// running turn. One more is answered at once and not kept.
	sessionQueueMax = 3
	// sessionWaitDelay is how long a finished or killed command is given to
	// let go of its output before the office stops listening. It bounds a
	// descendant that left the process group and kept the pipes open.
	sessionWaitDelay = 5 * time.Second
	// sessionShutdownWait is how long the office waits, on its way out, for
	// killed session turns to be reaped.
	sessionShutdownWait = 5 * time.Second

	sessionBusyReply = "This session is busy. Send that again when it has answered."
)

// sessionTurnPool is the launcher's session lanes. The zero value is ready.
type sessionTurnPool struct {
	mu    sync.Mutex
	lanes map[string]*sessionTurnLane
	wg    sync.WaitGroup
}

// sessionTurnLane is one session's line of messages: at most one runs.
type sessionTurnLane struct {
	queue   []sessionTurnRequest
	running bool
	// cancel stops the turn that is running. stopped says a person did;
	// silent says the member is gone, so nothing is to be posted for it.
	cancel  context.CancelFunc
	stopped bool
	silent  bool
}

// sessionTurnOutcome is what one command did.
type sessionTurnOutcome struct {
	// Final is the session's final answer; LastError the tool's own error
	// event, when it sent one; Plain the last line it printed that was not
	// an event.
	Final     string
	LastError string
	Plain     string
	Stderr    string
	Err       error
}

// said is everything the command said outside its answer, for telling a
// known refusal from any other failure.
func (o sessionTurnOutcome) said() string {
	return o.Stderr + "\n" + o.LastError + "\n" + o.Plain
}

// deliverOwnerMessagesToSessions is where the dispatcher hands a message to
// the session gate: once per message, before any cooldown, for each target
// the message would wake. A target that is a session and takes the message
// is removed from targets; everything else is returned for the ordinary
// path, where a session starts nothing and gets the fixed reply.
//
// Before the cooldown, because the cooldown drops a second message from the
// same sender in the same channel within a second, and for a session that
// would be something the person typed vanishing without a word. A session
// needs no cooldown of its own: its lane runs one turn at a time.
func (l *Launcher) deliverOwnerMessagesToSessions(targets []notificationTarget, msg channelMessage) []notificationTarget {
	if l == nil || l.broker == nil || len(targets) == 0 {
		return targets
	}
	rest := make([]notificationTarget, 0, len(targets))
	for _, target := range targets {
		if l.deliverOwnerMessageToSession(target.Slug, msg) {
			continue
		}
		rest = append(rest, target)
	}
	return rest
}

// deliverOwnerMessageToSession hands msg to the session behind slug when,
// and only when, the broker's gate clears it (claimOwnerSessionMessage). It
// reports whether it took the message; when it did not, the caller's
// ordinary path answers with the fixed "cannot be messaged" reply.
func (l *Launcher) deliverOwnerMessageToSession(slug string, msg channelMessage) bool {
	if l == nil || l.broker == nil {
		return false
	}
	req, ok, refusal := l.broker.claimOwnerSessionMessage(msg, slug)
	if refusal != "" {
		// The owner's own message, refused for a reason worth a sentence.
		l.postSessionFailure(req, refusal)
		return true
	}
	if !ok {
		return false
	}
	if !l.enqueueSessionTurn(req) {
		l.postSessionNote(req, sessionBusyReply)
	}
	return true
}

// enqueueSessionTurn puts req in its session's line and starts the line if
// it is idle. It reports false, and keeps nothing, when sessionQueueMax
// messages already wait.
func (l *Launcher) enqueueSessionTurn(req sessionTurnRequest) bool {
	pool := &l.sessionTurns
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.lanes == nil {
		pool.lanes = map[string]*sessionTurnLane{}
	}
	lane := pool.lanes[req.Slug]
	if lane == nil {
		lane = &sessionTurnLane{}
		pool.lanes[req.Slug] = lane
	}
	if lane.running && len(lane.queue) >= sessionQueueMax {
		return false
	}
	lane.queue = append(lane.queue, req)
	if lane.running {
		return true
	}
	lane.running = true
	pool.wg.Add(1)
	go l.runSessionLane(req.Slug)
	return true
}

// runSessionLane runs the lane's messages one after another until none are
// left.
func (l *Launcher) runSessionLane(slug string) {
	pool := &l.sessionTurns
	defer pool.wg.Done()
	for {
		pool.mu.Lock()
		lane := pool.lanes[slug]
		if lane == nil || len(lane.queue) == 0 {
			if lane != nil {
				lane.running = false
			}
			pool.mu.Unlock()
			return
		}
		req := lane.queue[0]
		lane.queue = lane.queue[1:]
		ctx, cancel := context.WithTimeout(l.sessionTurnBaseContext(), sessionTurnTimeout)
		lane.cancel, lane.stopped, lane.silent = cancel, false, false
		pool.mu.Unlock()

		l.runSessionTurnGuarded(ctx, req)
		cancel()

		pool.mu.Lock()
		lane.cancel, lane.stopped, lane.silent = nil, false, false
		pool.mu.Unlock()
	}
}

// runSessionTurnGuarded runs one turn and, if anything in it panics, says so
// in the conversation and lets the lane go on to the next message: a turn
// that blew up must not leave the person waiting on nothing.
func (l *Launcher) runSessionTurnGuarded(ctx context.Context, req sessionTurnRequest) {
	defer func() {
		if r := recover(); r != nil {
			appendHeadlessCodexLog(req.Slug, fmt.Sprintf("session-turn-panic: %v", r))
			l.postSessionFailure(req, "the office hit an error of its own while running it")
		}
	}()
	l.runSessionTurn(ctx, req)
}

func (l *Launcher) sessionTurnBaseContext() context.Context {
	l.headless.mu.Lock()
	defer l.headless.mu.Unlock()
	if l.headless.ctx != nil {
		return l.headless.ctx
	}
	return context.Background()
}

// takeSessionLanes empties the lines of slug (every session when slug is
// empty) and cancels what runs, marking each cancelled turn with mark. It
// returns the messages that were waiting.
func (l *Launcher) takeSessionLanes(slug string, mark func(*sessionTurnLane)) []sessionTurnRequest {
	pool := &l.sessionTurns
	pool.mu.Lock()
	defer pool.mu.Unlock()
	var waiting []sessionTurnRequest
	for laneSlug, lane := range pool.lanes {
		if slug != "" && laneSlug != slug {
			continue
		}
		waiting = append(waiting, lane.queue...)
		lane.queue = nil
		if lane.cancel != nil {
			mark(lane)
			lane.cancel()
		}
	}
	return waiting
}

// cancelSessionTurns is the Stop control for sessions: it kills the running
// background turn of slug (every session when slug is empty) and drops the
// messages waiting behind it, saying so in each one's conversation.
func (l *Launcher) cancelSessionTurns(slug string) {
	for _, req := range l.takeSessionLanes(slug, func(lane *sessionTurnLane) { lane.stopped = true }) {
		l.postSessionFailure(req, "it was stopped before it took this message")
	}
}

// DropSessionTurns is what a session member's removal does to its turns:
// the running one is killed and the waiting ones are forgotten, with nothing
// posted, because there is no member left to post about. It takes only the
// pool's own lock, so the broker may call it while holding its own.
// Implements sessionTurnDropper.
func (l *Launcher) DropSessionTurns(slug string) {
	if l == nil || strings.TrimSpace(slug) == "" {
		return
	}
	l.takeSessionLanes(slug, func(lane *sessionTurnLane) { lane.silent = true })
}

// stopSessionTurns is the office going away: running session turns are
// killed and reaped before the process exits, bounded by
// sessionShutdownWait, and each message that will now never run is answered.
// Call it after the headless context is cancelled.
func (l *Launcher) stopSessionTurns() {
	if l == nil {
		return
	}
	for _, req := range l.takeSessionLanes("", func(*sessionTurnLane) {}) {
		l.postSessionFailure(req, "the office shut down before it took this message")
	}
	drained := make(chan struct{})
	go func() {
		l.sessionTurns.wg.Wait()
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(sessionShutdownWait):
	}
}

// sessionTurnMark reports how a person or a removal ended slug's running
// turn.
func (l *Launcher) sessionTurnMark(slug string) (stopped, silent bool) {
	pool := &l.sessionTurns
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if lane := pool.lanes[slug]; lane != nil {
		return lane.stopped, lane.silent
	}
	return false, false
}

// waitSessionTurns blocks until every session lane has drained.
func (l *Launcher) waitSessionTurns() {
	l.sessionTurns.wg.Wait()
}

// runSessionTurn delivers one message. Everything the gate checked a moment
// ago is checked again here, immediately before anything is started: a
// window can reopen and a folder can go between a message and its turn.
func (l *Launcher) runSessionTurn(ctx context.Context, req sessionTurnRequest) {
	if !sessionFolderState(req.Cwd) {
		l.refuseSessionTurn(req)
		return
	}
	switch req.Tool {
	case sessionToolClaude:
		l.runClaudeSessionTurn(ctx, req)
	case sessionToolCodex:
		l.runCodexSessionTurn(ctx, req)
	default:
		l.refuseSessionTurn(req)
	}
}

func (l *Launcher) runClaudeSessionTurn(ctx context.Context, req sessionTurnRequest) {
	// The last look before the resume. Open, or not known: nothing runs.
	open, known := sessionOpenNowFn(ctx)
	if !known || sessionRequestIsOpen(req, open) {
		l.refuseSessionTurn(req)
		return
	}
	// And the log itself, read last of all: written a moment ago means
	// something is running in this session, listed or not.
	if !sessionLogIsQuiet(req.NativeID, l.broker.sessionOwnTurnEnded(req.Slug), time.Now()) {
		l.refuseSessionTurn(req)
		return
	}
	if _, err := headlessClaudeLookPath("claude"); err != nil {
		l.postSessionFailure(req, "Claude Code was not found on this Mac")
		return
	}
	cmd, err := claudeSessionResumeCommand(req.NativeID, req.Cwd, req.Prompt, gitexec.CleanEnv())
	if err != nil {
		l.postSessionFailure(req, err.Error())
		return
	}
	l.broker.beginSessionBackgroundTurn(req.Slug)
	defer l.broker.endSessionBackgroundTurn(req.Slug)
	stream, turnID := l.broker.BotStream(req.Slug), newHeadlessTurnID()
	outcome := l.execSessionCommand(ctx, cmd, func(stdout io.Reader) sessionTurnOutcome {
		result, _ := provider.ReadClaudeJSONStream(stdout, func(event provider.ClaudeStreamEvent) {
			switch event.Type {
			case "text":
				emitHeadlessText(stream, turnID, HeadlessProviderClaude, req.Slug, "", event.Text, "claude.text")
			case "tool_use":
				emitHeadlessToolUse(stream, turnID, HeadlessProviderClaude, req.Slug, "", event.ToolName, event.ToolInput, "claude.tool_use")
			case "tool_result":
				emitHeadlessToolResult(stream, turnID, HeadlessProviderClaude, req.Slug, "", event.ToolName, event.Text, "claude.tool_result")
			}
		})
		return sessionTurnOutcome{Final: result.FinalMessage, LastError: result.LastError}
	})
	l.finishSessionResume(ctx, req, outcome, stream, turnID, HeadlessProviderClaude, "Claude Code")
}

func (l *Launcher) runCodexSessionTurn(ctx context.Context, req sessionTurnRequest) {
	if _, err := headlessCodexLookPath("codex"); err != nil {
		l.postSessionFailure(req, "Codex was not found on this Mac")
		return
	}
	cmd, err := codexSessionResumeCommand(req.NativeID, req.Cwd, req.Prompt, gitexec.CleanEnv())
	if err != nil {
		l.postSessionFailure(req, err.Error())
		return
	}
	stream, turnID := l.broker.BotStream(req.Slug), newHeadlessTurnID()
	outcome := func() sessionTurnOutcome {
		// Shown as working while the resume runs, and put back exactly as it
		// was when it ends: an open window that refuses the resume was never
		// this office's to describe.
		l.broker.beginSessionBackgroundTurn(req.Slug)
		defer l.broker.endSessionBackgroundTurn(req.Slug)
		return l.execSessionCommand(ctx, cmd, func(stdout io.Reader) sessionTurnOutcome {
			result, _ := provider.ReadCodexJSONStream(stdout, func(event provider.CodexStreamEvent) {
				switch event.Type {
				case "text":
					emitHeadlessText(stream, turnID, HeadlessProviderCodex, req.Slug, "", event.Text, event.RawType)
				case "tool_use":
					emitHeadlessToolUse(stream, turnID, HeadlessProviderCodex, req.Slug, "", event.ToolName, event.ToolInput, event.RawType)
				case "tool_result":
					emitHeadlessToolResult(stream, turnID, HeadlessProviderCodex, req.Slug, "", event.ToolName, event.Text, event.RawType)
				}
			})
			return sessionTurnOutcome{Final: result.FinalMessage, LastError: result.LastError, Plain: result.LastPlainLine}
		})
	}()

	// Refused because the session is open in a terminal: Codex says so
	// itself. Only that exact refusal leads to the queue; any other failure
	// is reported as a failure.
	if ctx.Err() == nil && isCodexActiveWriterRefusal(outcome.Err, outcome.said()) {
		l.queueCodexSessionMessage(ctx, req)
		return
	}
	l.finishSessionResume(ctx, req, outcome, stream, turnID, HeadlessProviderCodex, "Codex")
}

// queueCodexSessionMessage hands the message to the session's open window
// and says so. The answer is written in the terminal and is not copied back:
// the next turn to finish there need not be the answer to this message.
func (l *Launcher) queueCodexSessionMessage(ctx context.Context, req sessionTurnRequest) {
	cmd, err := codexSessionQueueCommand(req.NativeID, req.Cwd, req.Prompt, gitexec.CleanEnv())
	if err != nil {
		l.postSessionFailure(req, err.Error())
		return
	}
	queueCtx, cancel := context.WithTimeout(ctx, sessionQueueTimeout)
	defer cancel()
	outcome := l.execSessionCommand(queueCtx, cmd, func(stdout io.Reader) sessionTurnOutcome {
		_, _ = io.Copy(io.Discard, stdout)
		return sessionTurnOutcome{}
	})
	if outcome.Err != nil {
		l.postSessionFailure(req, l.sessionFailureReason(queueCtx, req.Slug, outcome, "Codex", sessionQueueTimeout))
		return
	}
	if _, silent := l.sessionTurnMark(req.Slug); !silent {
		l.broker.postSessionDeliveredNote(req.Channel)
	}
}

// finishSessionResume posts what a background resume produced: the session's
// final answer as the member's own message and one note that it was resumed,
// or one plain sentence saying it failed and why.
func (l *Launcher) finishSessionResume(ctx context.Context, req sessionTurnRequest, outcome sessionTurnOutcome, stream *botStreamBuffer, turnID, providerName, toolName string) {
	metrics := headlessProgressMetrics{TotalMs: -1, FirstEventMs: -1, FirstTextMs: -1, FirstToolMs: -1}
	final := strings.TrimSpace(outcome.Final)
	if outcome.Err == nil && final != "" {
		emitHeadlessTerminalWithTurn(stream, turnID, providerName, req.Slug, "", "reply ready", "", metrics, nil)
		l.postSessionReply(req, final)
		if _, silent := l.sessionTurnMark(req.Slug); !silent {
			l.broker.postSessionResumedNote(req.Channel, req.Tool, req.NativeID)
		}
		return
	}
	reason := "it finished without an answer that could be read"
	if outcome.Err != nil {
		reason = l.sessionFailureReason(ctx, req.Slug, outcome, toolName, sessionTurnTimeout)
	}
	emitHeadlessTerminalWithTurn(stream, turnID, providerName, req.Slug, "", "", reason, metrics, nil)
	l.postSessionFailure(req, reason)
}

// sessionFailureReason is why a command failed, as a clause for one plain
// sentence: never the tool's raw error output, at most its own one-line
// error.
func (l *Launcher) sessionFailureReason(ctx context.Context, slug string, outcome sessionTurnOutcome, toolName string, timeout time.Duration) string {
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return fmt.Sprintf("it did not finish within %s and was stopped", timeout)
	case l.sessionTurnWasStopped(slug):
		return "it was stopped"
	case errors.Is(ctx.Err(), context.Canceled):
		return "the office was shutting down"
	}
	// The tool's own error event, or failing that the result it printed
	// before it exited with an error: a failed run's "result" is its reason
	// ("Not logged in"). One line of it, never its stderr.
	if detail := sessionErrorLine(firstNonEmpty(outcome.LastError, outcome.Final)); detail != "" {
		return fmt.Sprintf("%s reported an error: %s", toolName, detail)
	}
	return toolName + " exited with an error"
}

// sessionErrorLine is the first line of a tool's own error message, short
// enough to sit inside a sentence.
func sessionErrorLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return strings.TrimRight(truncate(line, 160), ".")
		}
	}
	return ""
}

// sessionRequestIsOpen reports whether the session behind req, under its id
// now or an earlier one, is in the tool's list of open sessions.
func sessionRequestIsOpen(req sessionTurnRequest, open map[string]agentdetect.OpenSession) bool {
	for _, id := range append([]string{req.SessionID}, req.PriorIDs...) {
		if _, ok := open[id]; ok && id != "" {
			return true
		}
	}
	return false
}

// refuseSessionTurn answers a message that turned out not to be deliverable
// with the same fixed reply every undelivered message gets.
func (l *Launcher) refuseSessionTurn(req sessionTurnRequest) {
	l.postSessionReply(req, sessionNotMessageableReply)
}

// sessionTurnWasStopped reports whether a person stopped slug's running
// turn.
func (l *Launcher) sessionTurnWasStopped(slug string) bool {
	stopped, _ := l.sessionTurnMark(slug)
	return stopped
}

// postSessionReply posts text in the session member's DM as the member.
// Nothing is posted for a member that was removed while its turn ran.
func (l *Launcher) postSessionReply(req sessionTurnRequest, text string) {
	if _, silent := l.sessionTurnMark(req.Slug); silent {
		return
	}
	if _, err := l.broker.PostMessage(req.Slug, req.Channel, text, nil, req.MessageID); err != nil {
		appendHeadlessCodexLog(req.Slug, "session-reply-error: "+err.Error())
	}
}

// postSessionFailure says, in one sentence, that the message did not get an
// answer and why. A system note: the session itself said nothing.
func (l *Launcher) postSessionFailure(req sessionTurnRequest, reason string) {
	l.postSessionNote(req, fmt.Sprintf("This session could not answer your message: %s.", strings.TrimRight(strings.TrimSpace(reason), ".")))
}

// postSessionNote posts one plain system line in the session member's DM.
func (l *Launcher) postSessionNote(req sessionTurnRequest, text string) {
	if _, silent := l.sessionTurnMark(req.Slug); silent {
		return
	}
	l.broker.PostSystemMessage(req.Channel, text, "error")
}

// sessionProcessGuard keeps the kill and the reap of one command apart: once
// Wait has returned, the process is gone and its pid is no longer this
// command's, so nothing may be signalled through it.
type sessionProcessGuard struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	reaped bool
}

// kill ends the command's whole process group, unless it was already reaped.
func (g *sessionProcessGuard) kill() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.reaped {
		return
	}
	terminateHeadlessProcess(g.cmd)
}

func (g *sessionProcessGuard) markReaped() {
	g.mu.Lock()
	g.reaped = true
	g.mu.Unlock()
}

// execSessionCommand runs cmd without a shell, in its own process group, and
// kills the whole group when ctx ends. read consumes stdout and returns what
// it found there; how the process ended is filled in here.
//
// Nothing here can wait forever: the process dies with ctx, and a descendant
// that left the group and kept a pipe open is listened to for
// sessionWaitDelay after the process is gone and no longer.
func (l *Launcher) execSessionCommand(ctx context.Context, spec sessionTurnCommand, read func(io.Reader) sessionTurnOutcome) sessionTurnOutcome {
	// The builders never produce one of these; this is the check that a
	// later edit to them cannot pass one in silence.
	if flag := sessionForbiddenArg(spec.Args); flag != "" {
		return sessionTurnOutcome{Err: fmt.Errorf("refused to run %s: %q is never passed to a person's session", spec.Name, flag)}
	}
	commandContext := headlessClaudeCommandContext
	if spec.Name == "codex" {
		commandContext = headlessCodexCommandContext
	}
	cmd := commandContext(ctx, spec.Name, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	// The prompt, or an empty reader: the child never reads the office's own
	// stdin.
	cmd.Stdin = strings.NewReader(spec.Stdin)
	configureHeadlessProcess(cmd)
	pr, pw, err := os.Pipe()
	if err != nil {
		return sessionTurnOutcome{Err: fmt.Errorf("attach stdout: %w", err)}
	}
	defer func() { _ = pr.Close() }()
	cmd.Stdout = pw
	// Bounded: a tool that floods stderr cannot grow the office's memory.
	stderr := &cappedBuffer{}
	cmd.Stderr = stderr
	// When ctx ends, the whole group goes, not the one process: exec's own
	// default would kill only the tool and leave what it started.
	guard := &sessionProcessGuard{cmd: cmd}
	cmd.Cancel = func() error {
		guard.kill()
		return nil
	}
	cmd.WaitDelay = sessionWaitDelay
	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		return sessionTurnOutcome{Err: fmt.Errorf("start %s: %w", spec.Name, err)}
	}
	_ = pw.Close()

	type readResult struct {
		outcome  sessionTurnOutcome
		panicked any
	}
	readDone := make(chan readResult, 1)
	go func() {
		var res readResult
		defer func() {
			if r := recover(); r != nil {
				// The reader is gone: nothing will drain the tool, so it is
				// ended now, not left to block on a full pipe.
				res.panicked = r
				guard.kill()
			}
			readDone <- res
		}()
		res.outcome = read(pr)
	}()

	waitErr := cmd.Wait()
	guard.markReaped()
	var res readResult
	select {
	case res = <-readDone:
	case <-time.After(sessionWaitDelay):
		// The tool is gone and something it left behind still holds its
		// output open. Stop listening.
		_ = pr.Close()
		res = <-readDone
	}
	if res.panicked != nil {
		panic(res.panicked)
	}
	outcome := res.outcome
	if errors.Is(waitErr, exec.ErrWaitDelay) && cmd.ProcessState != nil && cmd.ProcessState.Success() {
		// It finished well; only a leftover held stderr open past the delay.
		waitErr = nil
	}
	outcome.Err = waitErr
	if outcome.Err == nil && ctx.Err() != nil {
		// Stopped or out of time after its last line was read: not a result.
		outcome.Err = ctx.Err()
	}
	outcome.Stderr = stderr.buf.String()
	return outcome
}
