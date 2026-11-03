package team

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/agentdetect"
	"github.com/nex-crm/wuphf/internal/channel"
)

// A finished turn needs the human as much as a question does: the bot or
// session has stopped and is waiting for them. The notch lists each one in
// Needs you, after the questions, until the human answers it (which starts
// a new turn) or marks it done.
//
// They travel in their own field, not in Attention: Attention items are
// open requests that /requests/answer can answer, and every client that
// reads Attention (the phone too) relies on that.

// notchRecap is enough to decide what to do with a finished turn without
// opening its window: what the work is, what was asked last, and the
// reply in full, which is usually the agent's account of what is done and
// what is left.
type notchRecap struct {
	Project   string `json:"project,omitempty"`
	Asked     string `json:"asked,omitempty"`
	LastAsked string `json:"last_asked,omitempty"`
	Reply     string `json:"reply,omitempty"`
	// Earlier is the turn before, when Reply is too short to stand alone.
	Earlier string `json:"earlier,omitempty"`
}

// sessionRecap is a session's recap, or nil when its log said nothing.
func sessionRecap(sess agentdetect.Session) *notchRecap {
	if sess.Asked == "" && sess.LastAsked == "" && sess.Reply == "" {
		return nil
	}
	r := notchRecap{Project: sess.Project, Asked: sess.Asked, Reply: sess.Reply, Earlier: sess.EarlierReply}
	if sess.LastAsked != sess.Asked {
		r.LastAsked = sess.LastAsked
	}
	return &r
}

// notchFinishedWindow is how long a finished turn stays in Needs you if
// nobody looks at it: the same span a session stays on the list at all.
const notchFinishedWindow = 8 * time.Hour

// notchSeenMax bounds the set of turns marked done.
const notchSeenMax = 512

// notchSeenStore is the turns the owner marked done, saved to
// notch-seen.json beside the broker state so a restart does not bring
// them back. It has its own lock: reading and writing the file never
// holds the broker's.
type notchSeenStore struct {
	mu     sync.Mutex
	loaded bool
	// marks maps a finished turn's id to when it was marked done.
	marks map[string]time.Time
}

func (b *Broker) notchSeenPath() string {
	return filepath.Join(filepath.Dir(b.statePath), "notch-seen.json")
}

// loadLocked reads the file once. Caller holds s.mu.
func (s *notchSeenStore) loadLocked(path string, now time.Time) {
	if s.loaded {
		return
	}
	s.loaded = true
	s.marks = map[string]time.Time{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var saved map[string]time.Time
	if json.Unmarshal(raw, &saved) != nil {
		return
	}
	for id, at := range saved {
		// A mark older than the window names a turn no longer listed.
		if strings.HasPrefix(id, "finished:") && now.Sub(at) <= notchFinishedWindow {
			s.marks[id] = at
		}
	}
}

// notchSeenIDs returns the ids marked done.
func (b *Broker) notchSeenIDs(now time.Time) map[string]bool {
	s := &b.notchSeen
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked(b.notchSeenPath(), now)
	out := make(map[string]bool, len(s.marks))
	for id := range s.marks {
		out[id] = true
	}
	return out
}

// markNotchSeen records id as done and saves the set.
func (b *Broker) markNotchSeen(id string, now time.Time) error {
	s := &b.notchSeen
	s.mu.Lock()
	defer s.mu.Unlock()
	path := b.notchSeenPath()
	s.loadLocked(path, now)
	for old, at := range s.marks {
		if now.Sub(at) > notchFinishedWindow {
			delete(s.marks, old)
		}
	}
	if len(s.marks) >= notchSeenMax {
		// Keep the newest half: old marks name turns long since replaced.
		cutoff := now.Add(-notchFinishedWindow / 2)
		for old, at := range s.marks {
			if at.Before(cutoff) {
				delete(s.marks, old)
			}
		}
	}
	s.marks[id] = now
	raw, err := json.Marshal(s.marks)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, raw)
}

// notchAnswer is a bot's latest message, when it is waiting on the human,
// and what the human had asked it.
type notchAnswer struct {
	last  channelMessage
	asked string
	found bool
}

// notchAnswersLocked finds, for each bot, whether its latest message is an
// answer waiting on the human: in their DM, a reply to the human's own
// message, or one that tags them, with nothing from the human after it in
// that conversation. A bot whose latest message went to another bot (a
// handoff, a reply in a thread between bots) has nothing waiting. One pass
// from the newest message. Caller holds b.mu.
func (b *Broker) notchAnswersLocked(slugs []string) map[string]*notchAnswer {
	isBot := make(map[string]bool, len(slugs))
	ends := make(map[string]*notchAnswer, len(slugs))
	for _, slug := range slugs {
		isBot[slug] = true
	}
	human := func(from string) bool { return isHumanMessageSender(strings.ToLower(strings.TrimSpace(from))) }
	byID := map[string]channelMessage{}
	for _, msg := range b.messages {
		if human(msg.From) {
			byID[msg.ID] = msg
		}
	}
	humanSpokeAfter := map[string]bool{}
	decided := make(map[string]bool, len(slugs))
	left := len(slugs)
	for i := len(b.messages) - 1; i >= 0 && left > 0; i-- {
		msg := b.messages[i]
		if strings.TrimSpace(msg.Content) == "" || msg.From == "system" {
			continue
		}
		if human(msg.From) {
			humanSpokeAfter[msg.Channel] = true
			continue
		}
		if !isBot[msg.From] || decided[msg.From] {
			continue
		}
		decided[msg.From] = true
		left--
		if humanSpokeAfter[msg.Channel] {
			continue // the human already answered it
		}
		asked, ok := "", false
		if parent, replied := byID[msg.ReplyTo]; replied {
			asked, ok = parent.Content, true
		}
		if msg.Channel == channel.DirectSlug("human", msg.From) || notchTagsHuman(msg.Tagged) {
			ok = true
		}
		if !ok {
			continue
		}
		if asked == "" {
			asked = b.notchLastHumanBeforeLocked(msg.Channel, i)
		}
		ends[msg.From] = &notchAnswer{last: msg, asked: strings.TrimSpace(asked), found: true}
	}
	return ends
}

func notchTagsHuman(tagged []string) bool {
	for _, t := range tagged {
		if isHumanMessageSender(strings.ToLower(strings.TrimSpace(t))) {
			return true
		}
	}
	return false
}

// notchLastHumanBeforeLocked is the human's latest message in room before
// index i. Caller holds b.mu.
func (b *Broker) notchLastHumanBeforeLocked(room string, i int) string {
	for j := i - 1; j >= 0; j-- {
		msg := b.messages[j]
		if msg.Channel == room && isHumanMessageSender(strings.ToLower(strings.TrimSpace(msg.From))) {
			return msg.Content
		}
	}
	return ""
}

// notchBotFinished reports whether a bot has answered the human and the
// answer waits on them (notchAnswersLocked), recently, and the bot is not
// working on something else or asking.
func notchBotFinished(snap botActivitySnapshot, slug string, end *notchAnswer, hasOpenRequest bool, now time.Time) bool {
	if hasOpenRequest || end == nil || !end.found || end.last.From != slug {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(snap.Status)) {
	case "active", "error":
		return false
	}
	at, err := time.Parse(time.RFC3339, end.last.Timestamp)
	return err == nil && now.Sub(at) <= notchFinishedWindow
}

// notchBotRecap is a bot's finished turn as its card tells it.
func notchBotRecap(end *notchAnswer) *notchRecap {
	return &notchRecap{Asked: firstWords(end.asked, 500), Reply: firstWords(strings.TrimSpace(end.last.Content), 1200)}
}

// notchFinishedID names one finished turn. It carries the turn's time, so
// marking it done hides that turn only and the next one shows again.
func notchFinishedID(slug, at string) string {
	return "finished:" + slug + "@" + at
}

// withNotchFinished lists every agent whose turn is over and waiting on the
// human, newest first, leaving out the lead (its own chat box shows its
// reply) and the turns the human marked done.
func (b *Broker) withNotchFinished(state notchState) notchState {
	seen := b.notchSeenIDs(time.Now())
	state.Finished = []notchAttention{}
	for _, a := range state.Agents {
		if a.IsLead || a.State != agentdetect.SessionYourTurn || a.UpdatedAt == "" {
			continue
		}
		if a.Open != nil && !*a.Open {
			// Its window is gone; there is nobody there to answer.
			continue
		}
		id := notchFinishedID(a.Slug, a.UpdatedAt)
		if seen[id] {
			continue
		}
		state.Finished = append(state.Finished, notchAttention{
			ID:        id,
			Kind:      "finished",
			From:      a.Slug,
			FromName:  a.Name,
			Title:     "Your turn",
			Question:  firstNonEmpty(a.LastSaid, "Finished. Your turn."),
			CreatedAt: a.UpdatedAt,
			Recap:     a.Recap,
		})
	}
	sort.SliceStable(state.Finished, func(i, j int) bool {
		return state.Finished[i].CreatedAt > state.Finished[j].CreatedAt
	})
	// A terminal session finishing is a dot on its row and nothing more: they
	// finish all day, so only the office's own bots move the headline.
	bots := notchFinishedByBots(state)
	switch {
	case len(bots) == 0:
	case len(state.Attention) == 0:
		state.Mood, state.Headline = notchFinishedHeadline(bots)
	default:
		state.Headline = notchCount(len(state.Attention)+len(bots), "thing needs you", "things need you")
	}
	return state
}

// notchFinishedByBots is the finished turns of office bots, leaving out the
// terminal sessions found on this Mac.
func notchFinishedByBots(state notchState) []notchAttention {
	sessions := map[string]bool{}
	for _, a := range state.Agents {
		if a.Kind == notchAgentSession {
			sessions[a.Slug] = true
		}
	}
	out := make([]notchAttention, 0, len(state.Finished))
	for _, f := range state.Finished {
		if !sessions[f.From] {
			out = append(out, f)
		}
	}
	return out
}

func notchFinishedHeadline(items []notchAttention) (string, string) {
	if len(items) == 1 {
		who := firstNonEmpty(items[0].FromName, items[0].From, "A bot")
		return MoodNeedsYou, who + " finished. Your turn."
	}
	return MoodNeedsYou, notchCount(len(items), "bot finished. Your turn.", "bots finished. Your turn.")
}

// POST /notch/finished/seen {"id": "..."} — the human marked a finished
// turn done without answering it. Owner-only, like /notch/state.
func (b *Broker) handleNotchFinishedSeen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id := strings.TrimSpace(req.ID)
	if !strings.HasPrefix(id, "finished:") || len(id) > 512 {
		http.Error(w, "unknown finished turn", http.StatusBadRequest)
		return
	}
	if err := b.markNotchSeen(id, time.Now()); err != nil {
		// Still hidden until a restart; say it was not saved.
		http.Error(w, "could not save that", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// firstWords keeps the start of text, cut on a word.
func firstWords(text string, max int) string {
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

// lastWordsOf is the end of a reply on one line, for the card's lead-in.
func lastWordsOf(text string) string {
	r := []rune(strings.Join(strings.Fields(text), " "))
	if len(r) <= notchSaidMax {
		return string(r)
	}
	return "…" + strings.TrimSpace(string(r[len(r)-notchSaidMax:]))
}

const notchSaidMax = 320
