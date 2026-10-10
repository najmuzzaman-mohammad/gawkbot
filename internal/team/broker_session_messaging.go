package team

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
)

// Messaging a session member: who may, when, and who may read it.
//
// WHO (the security boundary). A session runs in the person's real
// repository under their own tool permissions. An office bot that has read
// something hostile must not be able to steer it, so exactly one kind of
// message is ever handed to a session: one the owner posted, through this
// process's own web UI, into that session member's own DM. The whole of
// that decision is one function, claimOwnerSessionMessage, and what it does
// and does not stop is written on it.
//
// WHEN. sessionMessageabilityLocked: a Claude Code session only when its
// tool says it is closed (a resume into an open one forks the conversation
// in silence); a Codex session whenever its folder is there (it refuses a
// second writer itself, and then takes the message through its queue).
//
// WHO MAY READ. A session's DM is the owner's: a joined human is refused it
// on every read path (sessionConversationHiddenFromRequest). An office bot
// is not, and cannot be: see the residuals on the gate.

// sessionMessagingEnabledEnv turns messaging a session on. It is OFF unless
// this is set to a true value: no message is delivered, can_message is false
// everywhere, and every message gets the fixed reply, exactly as before.
const sessionMessagingEnabledEnv = "WUPHF_SESSION_MESSAGING"

func sessionMessagingEnabled() bool {
	return envTruthy(os.Getenv(sessionMessagingEnabledEnv))
}

const (
	// Why a session member cannot be messaged right now. WIRE CONTRACT:
	// MemberSession.message_block in web/src/api/memberTypes.ts.
	sessionBlockOpen       = "open"
	sessionBlockFolderGone = "folder_gone"
	sessionBlockUnknown    = "unknown"

	// sessionMessageMaxRunes is the longest message handed to a session. A
	// person types far less; anything longer is a paste the session should
	// be given as a file in its own terminal.
	sessionMessageMaxRunes = 8000

	// ownerSessionPostsMax bounds the notes of owner posts not yet asked
	// about. The oldest fall off, which only ever loses a delivery.
	ownerSessionPostsMax = 256

	// The notes the broker leaves in a session's DM: that the session was
	// resumed in the background, and that a message was handed to its open
	// window. Only the broker writes them; a message posted over HTTP with
	// either kind is refused (isBrokerOnlyMessageKind), because the first
	// carries a command the person is told to run. WIRE CONTRACT:
	// web/src/components/messages/MessageBubble.tsx.
	sessionResumedNoteKind   = "session_resumed"
	sessionDeliveredNoteKind = "session_delivered"

	sessionDeliveredNote = "Delivered to this session's window. Its answer will appear there."
)

// isBrokerOnlyMessageKind reports whether kind is one only the broker may
// write.
func isBrokerOnlyMessageKind(kind string) bool {
	switch strings.TrimSpace(kind) {
	case sessionResumedNoteKind, sessionDeliveredNoteKind:
		return true
	}
	return false
}

// sessionMessagingState is what messaging needs remembered. Guarded by
// Broker.mu; nothing here is persisted or sent to any client.
type sessionMessagingState struct {
	// ownerPosts are ids of messages the owner posted through the web UI
	// into a session member's DM, not yet asked about; ownerPostOrder is the
	// same ids oldest first, for the bound.
	ownerPosts     map[string]bool
	ownerPostOrder []string
	// folders is, for each session member, whether its folder was there at
	// the registry's last look. A member not in the map: unknown.
	folders map[string]bool
	// ownTurnEnded is when gawkbot's own last background turn in a member's
	// session finished, so that turn's writes to the log are not taken for
	// someone working in the session.
	ownTurnEnded map[string]time.Time
	// quiet is, for each Claude Code session member, whether its log had
	// been still for sessionQuietMargin at the registry's last look. A
	// member not in the map: unknown, which is not quiet.
	quiet map[string]bool
	// running are the members with a background resume in flight, each with
	// what it showed before the resume began.
	running map[string]sessionResumeMark
}

// sessionResumeMark is what a member showed before a background resume, so
// the end of the resume puts back exactly that and nothing it made up.
type sessionResumeMark struct {
	sighting    sessionSighting
	hadSighting bool
	activity    botActivitySnapshot
	hadActivity bool
}

// sessionTurnRequest is one message cleared for delivery to a session.
type sessionTurnRequest struct {
	Slug      string
	Tool      string
	NativeID  string
	SessionID string
	PriorIDs  []string
	Cwd       string
	// Prompt is the person's own words and nothing else: never the office's
	// work packet, which carries what other bots said.
	Prompt    string
	MessageID string
	Channel   string
}

// requestIsOwnerPost reports whether r is the owner posting through this
// process's own web UI: the operator key (requestIsOperator, broker_data.go:
// minted per process, held in memory only, stamped by webUIProxyHandler
// alone), on a request that is not a joined human's session.
func (b *Broker) requestIsOwnerPost(r *http.Request) bool {
	if !b.requestIsOperator(r) {
		return false
	}
	if actor, ok := requestActorFromContext(r.Context()); ok && actor.Kind != requestActorKindBroker {
		return false
	}
	return true
}

// isOwnerSender reports whether from names the person at this machine. A
// joined human ("human:<slug>"), a bot, "system", and an empty sender do not.
func isOwnerSender(from string) bool {
	sender := normalizeActorSlug(from)
	return sender == "you" || sender == "human"
}

// noteOwnerSessionPostLocked remembers that msg was posted by the owner
// through the web UI, when it went into a session member's own DM. Called
// only from the HTTP post handler, with what the request itself proved.
func (b *Broker) noteOwnerSessionPostLocked(msg channelMessage) {
	if !isOwnerSender(msg.From) || strings.TrimSpace(msg.ID) == "" {
		return
	}
	if b.sessionMemberForDMLocked(msg.Channel) == nil {
		return
	}
	state := &b.sessionAgents.messaging
	if state.ownerPosts == nil {
		state.ownerPosts = map[string]bool{}
	}
	state.ownerPosts[msg.ID] = true
	state.ownerPostOrder = append(state.ownerPostOrder, msg.ID)
	for len(state.ownerPostOrder) > ownerSessionPostsMax {
		delete(state.ownerPosts, state.ownerPostOrder[0])
		state.ownerPostOrder = state.ownerPostOrder[1:]
	}
}

// sessionMemberForDMLocked is the session member whose own DM with the
// person channel is; nil for any other channel.
func (b *Broker) sessionMemberForDMLocked(channel string) *officeMember {
	if strings.TrimSpace(channel) == "" {
		return nil
	}
	ch := normalizeChannelSlug(channel)
	if !IsDMSlug(ch) {
		return nil
	}
	m := b.findMemberLocked(DMTargetBot(ch))
	if m == nil || !isSessionMember(*m) || DMSlugFor(m.Slug) != ch {
		return nil
	}
	return m
}

// claimOwnerSessionMessage is THE gate: the one function a message passes on
// its way to a terminal session. It refuses by default, and it judges the
// one message it is handed, by that message's own id. Nothing else in a
// conversation (an earlier message, a later one, a reply, a reaction) can
// stand in for it.
//
// ok is true only when ALL of these hold:
//
//  1. Provenance. The request that posted this exact message carried the
//     operator key, noted here at post time, in memory, by message id. It is
//     never read from the message or its body, never written to disk, and
//     never sent to any client. A message with no note (posted before a
//     restart, replayed, imported, or made by any internal path) is refused.
//  2. Channel. The message is in exactly this member's own DM, and slug is
//     that member. Once that holds the note is spent, so one post is at
//     most one turn.
//  3. Author. The sender is the owner: not "human:<slug>", not a bot, not
//     the system, not nobody.
//  4. Shape. Plain text only: no card kind, no title, no payload, not empty.
//  5. The session can take a message right now (sessionMessageabilityLocked).
//
// refusal is set, with ok false, when 1 to 5 hold but the text is too long:
// the owner is told why in a sentence. Otherwise a refused message is left
// to the ordinary path, which starts nothing and posts the fixed reply.
//
// THE RESIDUALS, in plain words. This stops every path an office bot
// reaches with its own tools and its own broker token: posting as "you",
// posting under its own name, bot-to-bot DMs, system and automation posts,
// mentions, and replays. Three things it does not stop:
//
//   - A process on this machine that posts through the web UI port and so
//     gets the operator key stamped for it (issue #1168). Accepted because
//     such a process already runs as the person and can run
//     `claude --resume` or `codex queue` itself: this gate gives it nothing
//     it lacks. Closing it needs an owner credential a local process cannot
//     use.
//   - A process that can WRITE under ~/.claude or ~/.codex. It can forge
//     session logs and Claude Code's list of open sessions, including
//     deleting a real entry so an open session reads as closed and a resume
//     forks it. Accepted because the same write access already lets it add
//     a hook to the person's settings.json and run code at the next launch.
//     Nothing more than that is claimed.
//   - An office bot READING a session's DM, including what a resumed
//     session answered. Bots hold the same broker token as the phone and the
//     notch and cannot be told apart from them (issue #1168).
func (b *Broker) claimOwnerSessionMessage(msg channelMessage, slug string) (req sessionTurnRequest, ok bool, refusal string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	state := &b.sessionAgents.messaging
	if !state.ownerPosts[msg.ID] {
		return sessionTurnRequest{}, false, ""
	}
	m := b.sessionMemberForDMLocked(msg.Channel)
	if m == nil || m.Slug != normalizeActorSlug(slug) {
		// Asked on behalf of someone else: the note is not theirs to spend.
		return sessionTurnRequest{}, false, ""
	}
	delete(state.ownerPosts, msg.ID)
	if !isOwnerSender(msg.From) {
		return sessionTurnRequest{}, false, ""
	}
	if strings.TrimSpace(msg.Kind) != "" || strings.TrimSpace(msg.Title) != "" || len(msg.Payload) != 0 {
		return sessionTurnRequest{}, false, ""
	}
	prompt := strings.TrimSpace(msg.Content)
	if prompt == "" {
		return sessionTurnRequest{}, false, ""
	}
	if can, _ := b.sessionMessageabilityLocked(*m); !can {
		return sessionTurnRequest{}, false, ""
	}
	if n := len([]rune(prompt)); n > sessionMessageMaxRunes {
		return sessionTurnRequest{Slug: m.Slug, Channel: DMSlugFor(m.Slug), MessageID: msg.ID}, false,
			fmt.Sprintf("your message is %d characters long and the most a session is sent from here is %d", n, sessionMessageMaxRunes)
	}
	session := m.Provider.Session
	return sessionTurnRequest{
		Slug:      m.Slug,
		Tool:      session.Tool,
		NativeID:  sessionBindingNativeID(*m),
		SessionID: session.SessionID,
		PriorIDs:  append([]string(nil), session.PriorSessionIDs...),
		Cwd:       strings.TrimSpace(session.Cwd),
		Prompt:    prompt,
		MessageID: msg.ID,
		Channel:   DMSlugFor(m.Slug),
	}, true, ""
}

// sessionBindingNativeID is the id the tool itself knows the member's
// session by, or "" when the binding holds nothing that is one.
func sessionBindingNativeID(m officeMember) string {
	if m.Provider.Session == nil {
		return ""
	}
	if id := strings.TrimSpace(m.Provider.Session.NativeID); id != "" {
		if sessionNativeID(id) == id {
			return id
		}
		return ""
	}
	return sessionNativeID(m.Provider.Session.SessionID)
}

// sessionMessageabilityLocked reports whether a message to m would be
// delivered right now, and when not, why. Anything that cannot be told
// apart is "unknown", and unknown is never messageable.
func (b *Broker) sessionMessageabilityLocked(m officeMember) (can bool, block string) {
	if !sessionMessagingEnabled() {
		return false, sessionBlockUnknown
	}
	if !isSessionMember(m) || m.Provider.Session == nil || sessionBindingNativeID(m) == "" {
		return false, sessionBlockUnknown
	}
	there, looked := b.sessionAgents.messaging.folders[m.Slug]
	if !looked {
		return false, sessionBlockUnknown
	}
	if !there {
		return false, sessionBlockFolderGone
	}
	switch m.Provider.Session.Tool {
	case sessionToolClaude:
		open, known := b.sessionAgents.open[m.Slug]
		if !known {
			return false, sessionBlockUnknown
		}
		if open {
			return false, sessionBlockOpen
		}
		// Not listed as open is not enough: its log must also be still. A
		// session being written right now is live, listed or not, and is
		// reported as open because that is what it is to the person.
		if !b.sessionAgents.messaging.quiet[m.Slug] {
			return false, sessionBlockOpen
		}
		return true, ""
	case sessionToolCodex:
		// Codex guards its own session: resume refuses a second writer, and
		// the queue then reaches the open window.
		return true, ""
	}
	return false, sessionBlockUnknown
}

// sessionMemberFolders is each session member's recorded folder. Takes b.mu.
func (b *Broker) sessionMemberFolders() map[string]string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]string{}
	for _, m := range b.members {
		if isSessionMember(m) && m.Provider.Session != nil {
			out[m.Slug] = m.Provider.Session.Cwd
		}
	}
	return out
}

// lookAtSessionFolders checks, off the lock, whether each session member's
// folder is there. The registry stores the answer on its next step. With
// messaging off nothing asks, so nothing is looked at: nil.
func (b *Broker) lookAtSessionFolders() map[string]bool {
	if !sessionMessagingEnabled() {
		return nil
	}
	cwds := b.sessionMemberFolders()
	out := make(map[string]bool, len(cwds))
	for slug, cwd := range cwds {
		out[slug] = sessionFolderState(cwd)
	}
	return out
}

// sessionMemberNativeIDs is each Claude Code session member's own session
// id. Takes b.mu.
func (b *Broker) sessionMemberNativeIDs() map[string]string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]string{}
	for _, m := range b.members {
		if isSessionMember(m) && m.Provider.Session != nil && m.Provider.Session.Tool == sessionToolClaude {
			if id := sessionBindingNativeID(m); id != "" {
				out[m.Slug] = id
			}
		}
	}
	return out
}

// lookAtSessionLogs checks, off the lock, whether each Claude Code session
// member's log has been still long enough to resume. With messaging off
// nothing asks, so nothing is looked at: nil.
func (b *Broker) lookAtSessionLogs(now time.Time) map[string]bool {
	if !sessionMessagingEnabled() {
		return nil
	}
	ids := b.sessionMemberNativeIDs()
	out := make(map[string]bool, len(ids))
	for slug, id := range ids {
		out[slug] = sessionLogIsQuiet(id, b.sessionOwnTurnEnded(slug), now)
	}
	return out
}

// sessionOwnTurnEnded is when gawkbot's own last background turn in slug's
// session finished; zero if it has run none. Takes b.mu.
func (b *Broker) sessionOwnTurnEnded(slug string) time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sessionAgents.messaging.ownTurnEnded[slug]
}

// beginSessionBackgroundTurn marks slug as running a background resume, so
// the registry shows it working and never as closed while the turn runs. It
// keeps what the member showed before, for endSessionBackgroundTurn.
func (b *Broker) beginSessionBackgroundTurn(slug string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	state := &b.sessionAgents.messaging
	if state.running == nil {
		state.running = map[string]sessionResumeMark{}
	}
	var mark sessionResumeMark
	mark.sighting, mark.hadSighting = b.sessionAgents.sightings[slug]
	mark.activity, mark.hadActivity = b.activity[slug]
	state.running[slug] = mark
	b.showSessionResumingLocked(slug, time.Now())
}

// endSessionBackgroundTurn clears the mark and puts back what the member
// showed before the resume began: a closed session reads closed again, and
// a session that was working in its own window still reads working. The
// registry says anything newer on its next look.
func (b *Broker) endSessionBackgroundTurn(slug string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	mark, was := b.sessionAgents.messaging.running[slug]
	if !was {
		return
	}
	if b.sessionAgents.messaging.ownTurnEnded == nil {
		b.sessionAgents.messaging.ownTurnEnded = map[string]time.Time{}
	}
	b.sessionAgents.messaging.ownTurnEnded[slug] = time.Now()
	delete(b.sessionAgents.messaging.running, slug)
	if m := b.findMemberLocked(slug); m == nil || !isSessionMember(*m) {
		return
	}
	if mark.hadSighting {
		b.sessionAgents.sightings[slug] = mark.sighting
	} else {
		delete(b.sessionAgents.sightings, slug)
	}
	want := mark.activity
	if !mark.hadActivity {
		want = botActivitySnapshot{Slug: slug, Status: "idle", Activity: "idle", Kind: "routine"}
	}
	want.LastTime = time.Now().UTC().Format(time.RFC3339)
	have := b.activity[slug]
	b.activity[slug] = want
	if have.Status != want.Status || have.Activity != want.Activity || have.Detail != want.Detail {
		b.publishActivityLocked(want)
	}
}

// showSessionResumingLocked makes a member with a background resume in
// flight read as running and working, whatever its window is doing.
func (b *Broker) showSessionResumingLocked(slug string, now time.Time) {
	m := b.findMemberLocked(slug)
	if m == nil || !isSessionMember(*m) {
		return
	}
	if b.sessionAgents.sightings == nil {
		b.sessionAgents.sightings = map[string]sessionSighting{}
	}
	last := b.sessionAgents.sightings[slug].Session
	if last.Tool == "" {
		last.Tool, last.ToolName, last.Project, last.Cwd = sessionBindingFields(*m)
	}
	last.State = agentdetect.SessionWorking
	b.sessionAgents.sightings[slug] = sessionSighting{Session: last, Live: true}
	want := botActivitySnapshot{
		Slug: slug, Status: "active", Activity: "working", Detail: "Working",
		LastTime: now.UTC().Format(time.RFC3339), Kind: "routine",
	}
	have := b.activity[slug]
	changed := have.Status != want.Status || have.Activity != want.Activity || have.Detail != want.Detail
	b.activity[slug] = want
	if changed {
		b.publishActivityLocked(want)
	}
}

// sessionResumingLocked reports whether slug has a background resume in
// flight.
func (b *Broker) sessionResumingLocked(slug string) bool {
	_, running := b.sessionAgents.messaging.running[slug]
	return running
}

// postSessionResumedNote leaves the one note a background resume earns: that
// it happened, and the command that opens the session in the terminal again.
// It is a system note, not something the session said.
func (b *Broker) postSessionResumedNote(channel, tool, nativeID string) {
	b.PostSystemMessage(channel,
		"This session was resumed in the background to answer you. To open it in your terminal again, run: "+sessionReopenCommand(tool, nativeID),
		sessionResumedNoteKind,
	)
}

// postSessionDeliveredNote says a message was handed to the session's open
// window. Its answer is written there, and is not copied here: the next turn
// to finish in that window need not be the answer to this message.
func (b *Broker) postSessionDeliveredNote(channel string) {
	b.PostSystemMessage(channel, sessionDeliveredNote, sessionDeliveredNoteKind)
}

// sessionTurnDropper is the launcher's side of a member's removal: stop its
// background turn and forget what waits behind it, saying nothing.
type sessionTurnDropper interface {
	DropSessionTurns(slug string)
}

// dropSessionTurnsLocked stops whatever is running for a session member that
// is being removed or evicted. Safe under b.mu: the launcher's side takes
// only its own lock and posts nothing.
func (b *Broker) dropSessionTurnsLocked(slug string) {
	if b.governor == nil {
		return
	}
	if dropper, ok := b.governor.controller().(sessionTurnDropper); ok {
		dropper.DropSessionTurns(slug)
	}
}

// isSessionConversationLocked reports whether channel is a DM that a
// session member is one side of: its DM with the person, or a bot-to-bot DM
// it is half of.
func (b *Broker) isSessionConversationLocked(channel string) bool {
	if strings.TrimSpace(channel) == "" {
		return false
	}
	ch := normalizeChannelSlug(channel)
	if !IsDMSlug(ch) {
		return false
	}
	for _, side := range strings.Split(ch, "__") {
		if m := b.findMemberLocked(side); m != nil && isSessionMember(*m) {
			return true
		}
	}
	return false
}

// sessionConversationHiddenFrom reports whether actor must not be shown
// channel: a session's conversation says what the owner is working on, and
// like the session member itself it is served to the owner's surfaces only.
// A joined human is refused. Takes b.mu.
func (b *Broker) sessionConversationHiddenFrom(actor requestActor, channel string) bool {
	if actor.Kind != requestActorKindHuman {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.isSessionConversationLocked(channel)
}

// sessionActionHiddenFrom is the same for an entry of the action log, which
// carries the first words of each message.
func (b *Broker) sessionActionHiddenFrom(actor requestActor, action officeActionLog) bool {
	if actor.Kind != requestActorKindHuman {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.isSessionConversationLocked(action.Channel) {
		return true
	}
	m := b.findMemberLocked(action.Actor)
	return m != nil && isSessionMember(*m)
}
