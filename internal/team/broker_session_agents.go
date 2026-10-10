package team

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/provider"
)

// Session members: every agent session the person opened in a terminal on
// this machine (a Claude Code or Codex window) is a member of the office,
// so it shows in the full app and on the phone and not only in the notch.
//
// A session member is a record, not a worker. The office never starts a
// process for it (provider.KindLocalSession has no runner): it reads the
// session's log through internal/agentdetect and keeps the member's name,
// model, and status in step with it.
//
//   - Identity: the slug is minted once from the session's own id and never
//     changes, so the slug-derived avatar is stable. The name is the
//     session's title and follows it.
//   - Lifecycle: a session becomes a member once it has a title and has been
//     seen for sessionMemberMinAge. When its window closes the member stays
//     and goes idle. Removing the member is remembered, so a still-open
//     window does not bring it back.
//   - Privacy: sessions describe the host machine and what its owner is
//     working on. Session members are served to the owner's surfaces only
//     (broker token), the same rule the notch applies to its session rows.

const (
	// A window opened by mistake and closed again should not become a bot.
	sessionMemberMinAge = 20 * time.Second
	// At most this many session members exist at once. Past it no new one is
	// made until the person removes some.
	sessionMemberCap = 24
	// How often the registry looks. The scan itself is cached for
	// localSessionsTTL, so this bounds how stale a status can be.
	sessionReconcileEvery = 5 * time.Second
	// How many sessions removed by a person are remembered, newest last.
	// When a 65th is removed the oldest entry falls off: if that session is
	// still running, or its log is written to again while the scanner still
	// lists it, it becomes a member once more. Evictions at the cap do not
	// use this list, so only a person's own removals count toward it.
	dismissedSessionsMax = 64

	// sessionMembersDisabledEnv turns the registry off. Test, demo, and eval
	// stacks set it so a broker started on a developer's machine does not
	// take that person's real terminal sessions as its own members.
	sessionMembersDisabledEnv = "WUPHF_SESSION_MEMBERS_DISABLED"

	sessionSlugShortHex = 8
	sessionSlugLongHex  = 12

	errSessionRuntimeNotSelectable = "a terminal session's runtime is read from its own log and cannot be chosen"

	// sessionNotMessageableReply is what a session member answers when it is
	// sent a message: nothing can reach the terminal from here yet.
	sessionNotMessageableReply = "This session cannot be messaged from here yet. Talk to it in its own terminal window."
)

// sessionSlugPrefixes maps the tool that runs a session to its slug prefix.
// A tool that is not here does not become a member.
var sessionSlugPrefixes = map[string]string{
	"claude-code": "cc-",
	"codex":       "cx-",
}

var sessionUUIDRe = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// sessionAgentState is the registry's memory. Guarded by Broker.mu. Only
// dismissed is persisted; the rest is rebuilt from the next scan.
type sessionAgentState struct {
	// firstSeen is when each listed session id was first seen by this broker.
	firstSeen map[string]time.Time
	// sightings is the last thing seen of each session member, by slug.
	sightings map[string]sessionSighting
	// dismissed are session ids whose member the human removed.
	dismissed []string
	// open is, for each session member whose tool could be asked, whether its
	// session is open as of the last look. A member not in the map: unknown.
	open map[string]bool
	// evicted are sessions whose member was removed to make room at the cap,
	// with the log's last-write time as of then. Such a session may be a
	// member again only once it writes after that, which shows it is alive;
	// until then it is left alone, so an ended session cannot be made a
	// member again on the next look and push out another. In memory only.
	evicted map[string]string
	// evicting is the slug being evicted right now, so the removal path can
	// tell an eviction from a person's removal; evictingAt is that moment.
	evicting   string
	evictingAt string
	// logged keeps "said once" log lines from repeating every tick.
	logged map[string]bool
	// messaging is what messaging a session needs remembered
	// (broker_session_messaging.go). In memory only.
	messaging sessionMessagingState
}

// sessionOpenness is what the tools themselves say about which sessions are
// open right now. Only Claude Code keeps such a list. When known is false
// (no list could be read), and for Codex always, a session counts as running
// while the scanner lists it, as before.
type sessionOpenness struct {
	known bool
	open  map[string]agentdetect.OpenSession
}

// decides reports whether openness, and not the scanner's window, says if
// this member's session is running.
func (o sessionOpenness) decides(m officeMember) bool {
	return o.known && m.Provider.Session != nil && m.Provider.Session.Tool == "claude-code"
}

// knowsClosed reports whether the tool was asked and says this scanned
// session is not open.
func (o sessionOpenness) knowsClosed(sess agentdetect.Session) bool {
	if !o.known || sess.Tool != "claude-code" {
		return false
	}
	_, isOpen := o.open[sess.ID]
	return !isOpen
}

func (o sessionOpenness) isOpen(m officeMember) bool {
	if m.Provider.Session == nil {
		return false
	}
	if _, ok := o.open[m.Provider.Session.SessionID]; ok {
		return true
	}
	for _, id := range m.Provider.Session.PriorSessionIDs {
		if _, ok := o.open[id]; ok {
			return true
		}
	}
	return false
}

// sessionSighting is what the registry last saw of one session member. Live
// is false once the session is no longer listed; the rest is then what it
// looked like when it was last seen.
type sessionSighting struct {
	Session agentdetect.Session
	Live    bool
}

// memberSessionInfo is the wire shape under "session" on an office-member
// list entry. WIRE CONTRACT: web/src/api/memberTypes.ts MemberSession.
type memberSessionInfo struct {
	// Tool is the catalog id of what runs the session ("claude-code").
	Tool string `json:"tool"`
	// Project is the folder it works in; Cwd its full path.
	Project string `json:"project,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	// State is agentdetect's working / your_turn / quiet; empty when the
	// session is not running.
	State     string `json:"state,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
	// LastSaid is the end of its latest reply.
	LastSaid string `json:"last_said,omitempty"`
	// Live is true while the session's window is open. No omitempty: an
	// ended session must say live:false, not leave the field out.
	Live bool `json:"live"`
	// CanMessage is true only when a message from the owner would be
	// delivered to the session right now. No omitempty: false is an answer.
	CanMessage bool `json:"can_message"`
	// MessageBlock says why not, when CanMessage is false: "open" (open in a
	// terminal, and its tool cannot take a message there), "folder_gone", or
	// "unknown".
	MessageBlock string `json:"message_block,omitempty"`
}

func isSessionMember(m officeMember) bool {
	return m.Provider.Kind == provider.KindLocalSession
}

// sessionMemberOwns reports whether m is the member for session id, now or
// under an earlier id of the same conversation.
func sessionMemberOwns(m officeMember, id string) bool {
	if !isSessionMember(m) || m.Provider.Session == nil || id == "" {
		return false
	}
	if m.Provider.Session.SessionID == id {
		return true
	}
	return containsString(m.Provider.Session.PriorSessionIDs, id)
}

// sessionSlugCandidates are the slugs a session may be given, in order of
// preference: the tool prefix plus 8 hex digits of the session's uuid, then
// 12. The uuid is the last one in the id (a Codex id carries a timestamp
// before it). Nil when the tool has no prefix or the id carries no uuid;
// such a session stays a notch row and is never a member.
//
// Which end of the uuid the digits come from differs by tool. Claude Code
// ids are random (v4) uuids, so the first digits are as good as any and are
// what the person sees in the log's file name. Codex ids are time-ordered
// (v7) uuids: their first digits are a timestamp, shared by every session
// started in the same minute, so Codex slugs take the random tail instead.
func sessionSlugCandidates(sess agentdetect.Session) []string {
	prefix := sessionSlugPrefixes[sess.Tool]
	native := sessionNativeID(sess.ID)
	if prefix == "" || native == "" {
		return nil
	}
	hex := strings.ReplaceAll(native, "-", "")
	if sess.Tool == "codex" {
		return []string{prefix + hex[len(hex)-sessionSlugShortHex:], prefix + hex[len(hex)-sessionSlugLongHex:]}
	}
	return []string{prefix + hex[:sessionSlugShortHex], prefix + hex[:sessionSlugLongHex]}
}

// sessionNativeID is the bare uuid inside a scanner session id, the id the
// tool itself takes to resume or address the session: the last uuid in the
// string, lower-case. "" when there is none.
func sessionNativeID(id string) string {
	found := sessionUUIDRe.FindAllString(strings.ToLower(id), -1)
	if len(found) == 0 {
		return ""
	}
	return found[len(found)-1]
}

// sessionHasTitle reports whether the session says what it is about. The
// scanner names an untitled session after its folder, so a title equal to
// the folder name is that fallback, not a title.
func sessionHasTitle(sess agentdetect.Session) bool {
	title := strings.TrimSpace(sess.Title)
	return title != "" && title != strings.TrimSpace(sess.Project)
}

func sessionMemberRole(sess agentdetect.Session) string {
	tool := firstNonEmpty(strings.TrimSpace(sess.ToolName), sess.Tool)
	if project := strings.TrimSpace(sess.Project); project != "" {
		return fmt.Sprintf("%s session in %s", tool, project)
	}
	return tool + " session"
}

type sessionMemberCreate struct {
	Slug    string
	Session agentdetect.Session
}

// sessionMemberUpdate is what a member should now say. Every field is the
// full desired value, not a delta.
type sessionMemberUpdate struct {
	Slug, Name, Role, Model, Cwd, Title string
}

// sessionPlan is what one look at the machine asks of the roster.
type sessionPlan struct {
	Creates []sessionMemberCreate
	Updates []sessionMemberUpdate
	// Live is each existing session member whose session is running now and
	// in the scanner's list, with what the scanner read of it.
	Live map[string]agentdetect.Session
	// StillOpen are members whose session the tool says is open although the
	// scanner's list (the newest few logs) no longer includes it. They are
	// running, with nothing new known about them.
	StillOpen map[string]bool
	// Evict are ended session members to remove, oldest first, so that the
	// cap does not stop a new session from joining.
	Evict []string
	// OverCap are sessions that would be members but for sessionMemberCap,
	// with nothing left that may be evicted; NoSlug are sessions with no
	// free slug to give them.
	OverCap []string
	NoSlug  []string
}

// planSessionMembers decides, without touching anything, what the roster
// needs for the sessions running now. firstSeen says when each session id
// was first seen; dismissed are sessions whose member the human removed;
// engaged are the session members the human has written to or given a task,
// which are never evicted; evicted are sessions put out at the cap, with the
// last-write time they had then.
//
// At the cap, a new session takes the place of the oldest ended session
// member the human never engaged with. A running session's member and an
// engaged one are never removed; with none to evict the new session waits.
func planSessionMembers(members []officeMember, sessions []agentdetect.Session, firstSeen map[string]time.Time, dismissed []string, engaged map[string]bool, evicted map[string]string, open sessionOpenness, now time.Time) sessionPlan {
	plan := sessionPlan{Live: map[string]agentdetect.Session{}, StillOpen: map[string]bool{}}
	taken := make(map[string]bool, len(members))
	count := 0
	for _, m := range members {
		taken[m.Slug] = true
		if isSessionMember(m) {
			count++
		}
	}
	// Every running session's member first: who is live decides who may go.
	var fresh []agentdetect.Session
	for _, sess := range sessions {
		owner := sessionOwner(members, sess.ID)
		if owner == nil {
			fresh = append(fresh, sess)
			continue
		}
		// Listed, but the tool says it is not open: its log is recent and
		// its window is gone. Its title and model are still read; it is not live.
		if !open.decides(*owner) || open.isOpen(*owner) {
			plan.Live[owner.Slug] = sess
		}
		if update, changed := sessionMemberDiff(*owner, sess); changed {
			plan.Updates = append(plan.Updates, update)
		}
	}
	// Open according to the tool, though not in the scanner's list: running.
	for _, m := range members {
		if _, listed := plan.Live[m.Slug]; !listed && isSessionMember(m) && open.decides(m) && open.isOpen(m) {
			plan.StillOpen[m.Slug] = true
		}
	}
	evictable := evictableSessionMembers(members, plan.Live, plan.StillOpen, engaged)
	for _, sess := range fresh {
		if containsString(dismissed, sess.ID) || !sessionHasTitle(sess) {
			continue
		}
		// A session the tool says is closed never becomes a member: every
		// Claude Code session closed today would otherwise turn up as a
		// "Closed" bot the person never saw running. Open, or not known
		// (and Codex always), it may; a member stays after its session closes.
		if open.knowsClosed(sess) {
			continue
		}
		// Put out at the cap, and silent since: not alive, so not brought back.
		// RFC 3339 times in UTC order as strings.
		if at, wasEvicted := evicted[sess.ID]; wasEvicted && sess.UpdatedAt <= at {
			continue
		}
		first, seen := firstSeen[sess.ID]
		if !seen || now.Sub(first) < sessionMemberMinAge {
			continue
		}
		slug := ""
		for _, candidate := range sessionSlugCandidates(sess) {
			if !taken[candidate] {
				slug = candidate
				break
			}
		}
		if slug == "" {
			plan.NoSlug = append(plan.NoSlug, sess.ID)
			continue
		}
		if count >= sessionMemberCap {
			if len(evictable) == 0 {
				plan.OverCap = append(plan.OverCap, sess.ID)
				continue
			}
			plan.Evict = append(plan.Evict, evictable[0])
			evictable = evictable[1:]
			count--
		}
		taken[slug] = true
		count++
		plan.Creates = append(plan.Creates, sessionMemberCreate{Slug: slug, Session: sess})
	}
	return plan
}

// evictableSessionMembers are the session members that may make room for a
// new session, oldest first: ended (not running now) and never engaged with.
func evictableSessionMembers(members []officeMember, live map[string]agentdetect.Session, stillOpen, engaged map[string]bool) []string {
	var ended []officeMember
	for _, m := range members {
		if !isSessionMember(m) || engaged[m.Slug] || stillOpen[m.Slug] {
			continue
		}
		if _, isLive := live[m.Slug]; isLive {
			continue
		}
		ended = append(ended, m)
	}
	sort.SliceStable(ended, func(i, j int) bool { return ended[i].CreatedAt < ended[j].CreatedAt })
	out := make([]string, 0, len(ended))
	for _, m := range ended {
		out = append(out, m.Slug)
	}
	return out
}

func sessionOwner(members []officeMember, id string) *officeMember {
	for i := range members {
		if sessionMemberOwns(members[i], id) {
			return &members[i]
		}
	}
	return nil
}

// sessionMemberDiff is what m should say given its session now, and whether
// that differs from what it says. An empty value in the log (no model yet,
// no folder) never blanks what the member already has.
func sessionMemberDiff(m officeMember, sess agentdetect.Session) (sessionMemberUpdate, bool) {
	want := sessionMemberUpdate{Slug: m.Slug, Name: m.Name, Role: m.Role, Model: m.Provider.Model}
	if m.Provider.Session != nil {
		want.Cwd = m.Provider.Session.Cwd
		want.Title = m.Provider.Session.Title
	}
	have := want
	if sessionHasTitle(sess) {
		// The title is always tracked. The name follows it only while the
		// name is still the title the registry last set: once a person has
		// renamed the member, their name stays.
		want.Title = strings.TrimSpace(sess.Title)
		if m.Name == have.Title {
			want.Name = want.Title
		}
	}
	if model := strings.TrimSpace(sess.Model); model != "" {
		want.Model = model
	}
	// The folder, and the role that names it, are NOT followed. They are
	// fixed when the member is made: a message to this member runs a tool in
	// that folder, and any log that later carries the same session id (a
	// second file, a forged one) must not be able to move it.
	return want, want != have
}

// sessionActivity maps a running session onto the activity snapshot every
// surface already reads a bot's status from.
func sessionActivity(sess agentdetect.Session) (status, activity, detail string) {
	switch sess.State {
	case agentdetect.SessionWorking:
		// The folder is on the roster entry already (session.project).
		return "active", "working", "Working"
	case agentdetect.SessionYourTurn:
		return "idle", "idle", "Your turn"
	default:
		return "idle", "idle", ""
	}
}

// startSessionMemberLoop keeps the roster in step with the sessions running
// on this machine until ctx is done.
//
// It reports whether the loop was started: sessionMembersDisabledEnv turns
// it off, for stacks that must not pick up the real machine's sessions.
func (b *Broker) startSessionMemberLoop(ctx context.Context) bool {
	if envTruthy(os.Getenv(sessionMembersDisabledEnv)) {
		log.Printf("session members: off (%s is set); terminal sessions on this machine will not become members", sessionMembersDisabledEnv)
		return false
	}
	go b.runSessionMembers(ctx, sessionReconcileEvery)
	return true
}

func (b *Broker) runSessionMembers(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// The scan lists processes and reads log tails: off the lock.
			sessions := cachedLocalSessions(ctx)
			if ctx.Err() != nil {
				return
			}
			b.reconcileSessionMembersWith(ctx, sessions, cachedLocalOpenSessions(), time.Now())
		}
	}
}

// reconcileSessionMembers brings the roster in step with sessions, the
// machine's running sessions as of now: it makes a member for each session
// that has earned one, renames and re-models the ones that changed, and
// records which members are live so their status follows their session.
//
// It judges what is running by the scanner's list alone;
// reconcileSessionMembersWith also takes what the tools say is open.
func (b *Broker) reconcileSessionMembers(ctx context.Context, sessions []agentdetect.Session, now time.Time) {
	b.reconcileSessionMembersWith(ctx, sessions, sessionOpenness{}, now)
}

func (b *Broker) reconcileSessionMembersWith(ctx context.Context, sessions []agentdetect.Session, open sessionOpenness, now time.Time) {
	b.officeMemberMutationMu.Lock()
	defer b.officeMemberMutationMu.Unlock()

	b.mu.Lock()
	b.noteSessionsSeenLocked(sessions, now)
	members := make([]officeMember, len(b.members))
	for i, m := range b.members {
		members[i] = cloneOfficeMemberForRead(m)
	}
	plan := planSessionMembers(members, sessions, b.sessionAgents.firstSeen, b.sessionAgents.dismissed, b.engagedSessionMembersLocked(), b.sessionAgents.evicted, open, now)
	b.logSessionPlanLocked(plan)
	b.mu.Unlock()

	for _, slug := range plan.Evict {
		if err := b.evictSessionMember(ctx, slug, now); err != nil {
			log.Printf("session members: could not make room by removing @%s: %v", slug, err)
		}
	}
	created := false
	for _, c := range plan.Creates {
		if err := b.createSessionMember(ctx, c); err != nil {
			log.Printf("session members: could not add @%s for %s: %v", c.Slug, c.Session.ID, err)
			continue
		}
		plan.Live[c.Slug] = c.Session
		created = true
		// A member again: it is no longer an evicted session.
		b.mu.Lock()
		delete(b.sessionAgents.evicted, c.Session.ID)
		b.mu.Unlock()
	}
	if created {
		b.backfillBotFilesForRoster()
	}
	if len(plan.Updates) > 0 {
		if err := b.applySessionMemberUpdates(plan.Updates); err != nil {
			log.Printf("session members: could not save updates: %v", err)
		}
	}

	// Whether each member's folder is still there: read off the lock.
	folders := b.lookAtSessionFolders()

	b.mu.Lock()
	b.sessionAgents.messaging.folders = folders
	b.applySessionActivityLocked(plan.Live, plan.StillOpen, open, now)
	b.mu.Unlock()
}

// engagedSessionMembersLocked are the session members the human has written
// to (a human-authored message in the member's DM) or given a task. Only
// worked out at the cap, the one time the answer is needed.
func (b *Broker) engagedSessionMembersLocked() map[string]bool {
	dms := map[string]string{}
	for _, m := range b.members {
		if isSessionMember(m) {
			dms[DMSlugFor(m.Slug)] = m.Slug
		}
	}
	if len(dms) < sessionMemberCap {
		return nil
	}
	engaged := map[string]bool{}
	for _, msg := range b.messages {
		if slug, ok := dms[msg.Channel]; ok && isHumanMessageSender(msg.From) {
			engaged[slug] = true
		}
	}
	for i := range b.tasks {
		if owner := strings.TrimSpace(b.tasks[i].Owner); owner != "" {
			engaged[owner] = true
		}
	}
	return engaged
}

// evictSessionMember removes an ended, never-engaged session member through
// the same path a person's removal takes. Unlike a person's removal it is
// not final: the session is remembered in memory with when it last wrote,
// and may be a member again once it writes after that. The caller holds
// officeMemberMutationMu, which is what makes the evicting marker safe.
func (b *Broker) evictSessionMember(ctx context.Context, slug string, now time.Time) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "/office-members", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	b.mu.Lock()
	b.sessionAgents.evicting = slug
	b.sessionAgents.evictingAt = now.UTC().Format(time.RFC3339)
	b.mu.Unlock()
	result, mErr := b.removeOfficeMember(req, slug)
	b.mu.Lock()
	b.sessionAgents.evicting = ""
	b.mu.Unlock()
	if mErr != nil {
		return fmt.Errorf("%s", mErr.message)
	}
	if err := b.writeBrokerState(result.write); err != nil {
		return fmt.Errorf("persist broker state: %w", err)
	}
	b.publishOfficeChanges(result.events)
	log.Printf("session members: removed @%s (its session ended and it was never written to) to make room for a new session; it returns if that session writes again", slug)
	return nil
}

// noteSessionsSeenLocked stamps sessions seen for the first time and forgets
// the ones no longer listed, so the map cannot grow without bound.
func (b *Broker) noteSessionsSeenLocked(sessions []agentdetect.Session, now time.Time) {
	next := make(map[string]time.Time, len(sessions))
	for _, sess := range sessions {
		if first, ok := b.sessionAgents.firstSeen[sess.ID]; ok {
			next[sess.ID] = first
		} else {
			next[sess.ID] = now
		}
	}
	b.sessionAgents.firstSeen = next
}

// logSessionPlanLocked says, once per cause, why a session did not become a
// member. A session dropped without a line would look like a scanner bug.
func (b *Broker) logSessionPlanLocked(plan sessionPlan) {
	once := func(key, format string, args ...any) {
		if b.sessionAgents.logged == nil {
			b.sessionAgents.logged = map[string]bool{}
		}
		if b.sessionAgents.logged[key] {
			return
		}
		b.sessionAgents.logged[key] = true
		log.Printf(format, args...)
	}
	if len(plan.OverCap) > 0 {
		once("cap", "session members: %d session members already exist (the limit); %d more running session(s) were not added, for example %s. Remove a session member to make room.",
			sessionMemberCap, len(plan.OverCap), plan.OverCap[0])
	} else {
		// Under the limit again: the next time it is hit is news.
		delete(b.sessionAgents.logged, "cap")
	}
	for _, id := range plan.NoSlug {
		once("noslug:"+id, "session members: no free slug for session %s; it stays out of the roster", id)
	}
}

// createSessionMember adds the member for one session through the same path
// the bot wizard uses, minus the shared channels, then opens its DM. The
// caller holds officeMemberMutationMu.
func (b *Broker) createSessionMember(ctx context.Context, c sessionMemberCreate) error {
	sess := c.Session
	binding := provider.ProviderBinding{
		Kind:  provider.KindLocalSession,
		Model: strings.TrimSpace(sess.Model),
		Session: &provider.LocalSessionBinding{
			Tool:      sess.Tool,
			SessionID: sess.ID,
			NativeID:  sessionNativeID(sess.ID),
			Cwd:       strings.TrimSpace(sess.Cwd),
			Title:     strings.TrimSpace(sess.Title),
		},
	}
	tool := firstNonEmpty(strings.TrimSpace(sess.ToolName), sess.Tool)
	body := officeMemberMutationBody{
		Action:          "create",
		Slug:            c.Slug,
		Name:            strings.TrimSpace(sess.Title),
		Role:            sessionMemberRole(sess),
		Personality:     fmt.Sprintf("A %s session the person opened in a terminal on this machine. It works for them directly, in its own window.", tool),
		CreatedBy:       createdByHumanValue,
		Provider:        &binding,
		origin:          OriginSession,
		skipChannelSeed: true,
	}
	// createOfficeMember reads the request only for its context.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "/office-members", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	result, mErr := b.createOfficeMember(req, c.Slug, body)
	if mErr != nil {
		return fmt.Errorf("%s", mErr.message)
	}
	if err := b.writeBrokerState(result.write); err != nil {
		return fmt.Errorf("persist broker state: %w", err)
	}
	b.publishOfficeChanges(result.events)
	if _, err := b.EnsureDirectChannel(c.Slug); err != nil {
		return fmt.Errorf("open DM: %w", err)
	}
	return nil
}

// applySessionMemberUpdates renames and re-models members in place. The
// caller holds officeMemberMutationMu.
func (b *Broker) applySessionMemberUpdates(updates []sessionMemberUpdate) error {
	b.mu.Lock()
	events := make([]officeChangeEvent, 0, len(updates))
	for _, u := range updates {
		m := b.findMemberLocked(u.Slug)
		if m == nil || !isSessionMember(*m) {
			continue
		}
		m.Name, m.Role, m.Provider.Model = u.Name, u.Role, u.Model
		if m.Provider.Session != nil {
			// A fresh binding, never an edit through the shared pointer: read
			// clones of this member hold the old one.
			session := *m.Provider.Session
			session.Cwd, session.Title = u.Cwd, u.Title
			m.Provider.Session = &session
		}
		events = append(events, officeChangeEvent{Kind: "member_updated", Slug: u.Slug})
	}
	if len(events) == 0 {
		b.mu.Unlock()
		return nil
	}
	write, err := b.prepareBrokerStateWriteLocked()
	b.mu.Unlock()
	if err != nil {
		return fmt.Errorf("prepare broker state: %w", err)
	}
	if err := b.writeBrokerState(write); err != nil {
		return fmt.Errorf("persist broker state: %w", err)
	}
	b.publishOfficeChanges(events)
	return nil
}

// applySessionActivityLocked makes each session member's status follow its
// session: working while the session writes, idle once it stops or its
// window closes. It writes the same activity snapshot the headless runners
// write, so the roster, the sidebar, and the notch need no second source.
//
// The stuck-activity reaper (broker_streams.go) ages a snapshot by its
// LastTime. A working session is confirmed here every few seconds, so its
// LastTime is refreshed on each look, without publishing: the reaper then
// only ever acts on a session member if this loop itself has stopped, which
// is exactly the crash it exists to catch.
//
// stillOpen members are running with nothing new known: each keeps what was
// last seen of it, except that "working" cannot be confirmed without a
// fresh read of its log and so rests as quiet.
func (b *Broker) applySessionActivityLocked(live map[string]agentdetect.Session, stillOpen map[string]bool, open sessionOpenness, now time.Time) {
	if b.sessionAgents.sightings == nil {
		b.sessionAgents.sightings = map[string]sessionSighting{}
	}
	stamp := now.UTC().Format(time.RFC3339)
	b.sessionAgents.open = map[string]bool{}
	for _, m := range b.members {
		if !isSessionMember(m) {
			continue
		}
		if open.decides(m) {
			b.sessionAgents.open[m.Slug] = open.isOpen(m)
		}
		sess, isLive := live[m.Slug]
		prev, known := b.sessionAgents.sightings[m.Slug]
		var want botActivitySnapshot
		switch {
		case b.sessionResumingLocked(m.Slug):
			// A background resume is the session's own activity: it is
			// running and working, though its window is closed and its tool
			// lists it as not open.
			last := prev.Session
			if isLive {
				last = sess
			} else if !known {
				last.Tool, last.ToolName, last.Project, last.Cwd = sessionBindingFields(m)
			}
			last.State = agentdetect.SessionWorking
			b.sessionAgents.sightings[m.Slug] = sessionSighting{Session: last, Live: true}
			want.Status, want.Activity, want.Detail = sessionActivity(last)
		case isLive:
			b.sessionAgents.sightings[m.Slug] = sessionSighting{Session: sess, Live: true}
			want.Status, want.Activity, want.Detail = sessionActivity(sess)
		case stillOpen[m.Slug]:
			last := prev.Session
			if !known {
				// Never read since this broker started: all that is known is
				// what its binding says, and that it is open.
				last.Tool, last.ToolName, last.Project, last.Cwd = sessionBindingFields(m)
			}
			if last.State == "" || last.State == agentdetect.SessionWorking {
				last.State = agentdetect.SessionQuiet
			}
			b.sessionAgents.sightings[m.Slug] = sessionSighting{Session: last, Live: true}
			want.Status, want.Activity, want.Detail = sessionActivity(last)
		case known && prev.Live:
			// Its window just closed: the member stays, and rests.
			b.sessionAgents.sightings[m.Slug] = sessionSighting{Session: prev.Session}
			want.Status, want.Activity = "idle", "idle"
		default:
			continue
		}
		want.Slug, want.LastTime, want.Kind = m.Slug, stamp, "routine"
		have := b.activity[m.Slug]
		changed := have.Status != want.Status || have.Activity != want.Activity || have.Detail != want.Detail || have.Kind != want.Kind
		if !changed && want.Status != "active" {
			continue
		}
		b.activity[m.Slug] = want
		if changed {
			b.publishActivityLocked(want)
		}
	}
}

// memberSessionInfoLocked is the "session" object for a member list entry;
// nil for a member that is not a terminal session.
func (b *Broker) memberSessionInfoLocked(m officeMember) *memberSessionInfo {
	if !isSessionMember(m) || m.Provider.Session == nil {
		return nil
	}
	info := memberSessionInfo{Tool: m.Provider.Session.Tool, Cwd: m.Provider.Session.Cwd}
	if sighting, ok := b.sessionAgents.sightings[m.Slug]; ok {
		info.Live = sighting.Live
		info.UpdatedAt = sighting.Session.UpdatedAt
		info.LastSaid = sighting.Session.LastSaid
		if sighting.Live {
			info.State = sighting.Session.State
		}
	}
	if info.Cwd != "" {
		info.Project = filepath.Base(info.Cwd)
	}
	info.CanMessage, info.MessageBlock = b.sessionMessageabilityLocked(m)
	return &info
}

// sessionOpenFlag is a scanned session's openness as the notch sends it:
// true or false when the tool could be asked, nil when it could not.
func sessionOpenFlag(sess agentdetect.Session) *bool {
	if !sess.OpenKnown {
		return nil
	}
	open := sess.Open
	return &open
}

// sessionMemberOpenLocked is the same for a session member, as of the
// registry's last look; nil when unknown.
func (b *Broker) sessionMemberOpenLocked(slug string) *bool {
	open, known := b.sessionAgents.open[slug]
	if !known {
		return nil
	}
	return &open
}

// sessionBindingFields are the session fields a member's own binding can
// supply, running or not: the tool, its name, and the folder.
func sessionBindingFields(m officeMember) (tool, toolName, project, cwd string) {
	s := m.Provider.Session
	if s == nil {
		return "", "", "", ""
	}
	if s.Cwd != "" {
		project = filepath.Base(s.Cwd)
	}
	return s.Tool, sessionToolName(s), project, s.Cwd
}

// memberRuntimeText is how a member's runtime is written in prose (its
// IDENTITY file, a fact about it): the provider kind, except for a terminal
// session, whose kind is the office's own bookkeeping and which is named by
// the tool the person opened.
func memberRuntimeText(m officeMember) string {
	if isSessionMember(m) {
		return sessionToolName(m.Provider.Session)
	}
	return strings.TrimSpace(m.Provider.Kind)
}

// dismissSessionMemberLocked runs when a session's member is removed, and
// forgets what the registry had seen of it. Removed by a person, its session
// is dismissed for good, so the registry does not make the member again
// while the window is open. Removed by an eviction at the cap, it is only
// noted in memory with its last-write time (see sessionAgentState.evicted).
func (b *Broker) dismissSessionMemberLocked(m officeMember) {
	if !isSessionMember(m) {
		return
	}
	// Whatever is running for it stops with it, and nothing waits behind.
	b.dropSessionTurnsLocked(m.Slug)
	delete(b.sessionAgents.messaging.running, m.Slug)
	sighting, seen := b.sessionAgents.sightings[m.Slug]
	delete(b.sessionAgents.sightings, m.Slug)
	delete(b.activity, m.Slug)
	if m.Provider.Session == nil {
		return
	}
	if b.sessionAgents.evicting == m.Slug {
		// The last write the registry saw; never having seen one (a restart
		// since), the eviction itself is the mark it must write after.
		at := b.sessionAgents.evictingAt
		if seen && sighting.Session.UpdatedAt != "" {
			at = sighting.Session.UpdatedAt
		}
		if b.sessionAgents.evicted == nil {
			b.sessionAgents.evicted = map[string]string{}
		}
		for _, id := range append([]string{m.Provider.Session.SessionID}, m.Provider.Session.PriorSessionIDs...) {
			if id != "" {
				b.sessionAgents.evicted[id] = at
			}
		}
		return
	}
	next := make([]string, 0, len(b.sessionAgents.dismissed)+1+len(m.Provider.Session.PriorSessionIDs))
	next = append(next, b.sessionAgents.dismissed...)
	for _, id := range append([]string{m.Provider.Session.SessionID}, m.Provider.Session.PriorSessionIDs...) {
		if id != "" && !containsString(next, id) {
			next = append(next, id)
		}
	}
	if len(next) > dismissedSessionsMax {
		next = next[len(next)-dismissedSessionsMax:]
	}
	b.sessionAgents.dismissed = next
}

// isSessionMemberSlug reports whether slug is a session member. Takes b.mu.
func (b *Broker) isSessionMemberSlug(slug string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	m := b.findMemberLocked(slug)
	return m != nil && isSessionMember(*m)
}

// claimNotchSessionRows gives each running session that has a member the
// member's own row: the row keeps the member's slug and gains the session's
// kind and fields. It returns the sessions that have no member yet, which
// the notch still lists as plain session rows, so no session is listed
// twice.
func (b *Broker) claimNotchSessionRows(state notchState, sessions []agentdetect.Session, now time.Time) (notchState, []agentdetect.Session) {
	if len(sessions) == 0 {
		return state, sessions
	}
	b.mu.Lock()
	owners := make(map[string]string, len(sessions))
	for _, sess := range sessions {
		if owner := sessionOwner(b.members, sess.ID); owner != nil {
			owners[sess.ID] = owner.Slug
		}
	}
	b.mu.Unlock()
	if len(owners) == 0 {
		return state, sessions
	}
	rows := make(map[string]int, len(state.Agents))
	agents := make([]notchAgent, len(state.Agents))
	for i, a := range state.Agents {
		agents[i] = a
		rows[a.Slug] = i
	}
	var unclaimed []agentdetect.Session
	for _, sess := range sessions {
		i, ok := rows[owners[sess.ID]]
		if !ok {
			unclaimed = append(unclaimed, sess)
			continue
		}
		if sess.OpenKnown && !sess.Open {
			// Its log is recent but the tool says its window is gone. It has
			// a member, whose row already shows it as ended; no live fields.
			agents[i].Open = sessionOpenFlag(sess)
			continue
		}
		row := agents[i]
		row.Kind = notchAgentSession
		// The folder stays the member's own, fixed when it was made.
		row.Tool, row.ToolName = sess.Tool, sess.ToolName
		row.State, row.UpdatedAt, row.LastSaid = sess.State, sess.UpdatedAt, sess.LastSaid
		row.Runtime = sessionRuntime(sess)
		// This scan is at least as fresh as the registry's last look.
		if flag := sessionOpenFlag(sess); flag != nil {
			row.Open = flag
			if *flag && sess.Tool == sessionToolClaude {
				// Open by the newer look: a Claude Code session takes no
				// message while it is open, whatever the registry last saw.
				row.CanMessage = false
			}
		}
		row.Mood, row.Detail = notchSessionMood(sess, now)
		agents[i] = row
	}
	// The roster was ordered by moods taken from the activity snapshots,
	// which can trail the scan by a few seconds. With the live moods stamped,
	// put it back in the notch's own order: the lead, then by how much each
	// row needs looking at. Stable, so rows that tie keep their places.
	sort.SliceStable(agents, func(i, j int) bool {
		if agents[i].IsLead != agents[j].IsLead {
			return agents[i].IsLead
		}
		return notchMoodRank[agents[i].Mood] < notchMoodRank[agents[j].Mood]
	})
	state.Agents = agents
	return state, unclaimed
}

// notchMoodRank mirrors the rank notchStateLocked sorts its rows by. Keep
// the two equal.
var notchMoodRank = map[string]int{MoodNeedsYou: 0, MoodError: 1, MoodWorking: 2, MoodDone: 3, MoodIdle: 4}

// replyLocalSessionNotMessageable is the whole "turn" of a session member:
// it starts nothing, and says in the conversation it was addressed in why
// nothing will happen. One reply per conversation until the human writes
// again, so a burst of messages does not get a burst of the same answer.
func (l *Launcher) replyLocalSessionNotMessageable(slug, notification string, channel ...string) error {
	if l == nil || l.broker == nil {
		return nil
	}
	// Its DM with the human. It belongs to no shared channel, so it cannot
	// answer there. Addressed in a bot-to-bot DM it is half of, it says
	// nothing at all: a reply there would wake the bot across from it, and a
	// bot is owed no explanation.
	target := DMSlugFor(slug)
	if len(channel) > 0 {
		if asked := normalizeChannelSlug(channel[0]); strings.TrimSpace(channel[0]) != "" && IsDMSlug(asked) && DMTargetBot(asked) == "" {
			return nil
		}
	}
	if l.broker.lastMessageInChannelIs(target, slug, sessionNotMessageableReply) {
		return nil
	}
	if _, err := l.broker.PostMessage(slug, target, sessionNotMessageableReply, nil, headlessReplyToID(notification)); err != nil {
		return fmt.Errorf("session member reply: %w", err)
	}
	return nil
}

// answerSessionMemberWithoutATurn is every way a turn could be started for a
// member: when slug is a terminal session it posts the fixed reply (once
// per conversation until someone writes again) and reports true, and the
// caller starts nothing. It never touches the office's turn queue, so
// nothing finishes, and nothing wakes the lead or any other bot.
func (l *Launcher) answerSessionMemberWithoutATurn(slug, notification, channel string) bool {
	if l == nil || l.broker == nil || !l.broker.isSessionMemberSlug(slug) {
		return false
	}
	if err := l.replyLocalSessionNotMessageable(slug, notification, channel); err != nil {
		appendHeadlessCodexLog(slug, "session-reply-error: "+err.Error())
	}
	return true
}

// lastMessageInChannelIs reports whether the newest message in channel is
// content from sender.
func (b *Broker) lastMessageInChannelIs(channel, sender, content string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := len(b.messages) - 1; i >= 0; i-- {
		if b.messages[i].Channel != channel {
			continue
		}
		return b.messages[i].From == sender && b.messages[i].Content == content
	}
	return false
}
