package team

// broker_notch_hint.go: the quiet one-liner for the human when the app or
// page in front of them belongs to an integration that is not connected:
// "Connect Gmail so your bots can read this inbox", with Connect and Not
// now. It is a hint, not a card: nothing waits on it, and it keeps to
// itself. It appears only after the same platform has been in front for a
// while, never for a connected platform, never beside an open Connect card
// for it, at most three platforms a day and each once a day, and it stops
// for good after two Not nows. What was shown is saved to notch-hints.json
// beside the broker state. Owner only.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/action"
)

const (
	// notchHintDwell is how long the same platform must be in front
	// before the notch says anything: a tab passed through is not a place.
	notchHintDwell = 20 * time.Second
	// notchHintPerDay is how many different platforms may be hinted a day.
	notchHintPerDay = 3
	// notchHintDismissals is how many Not nows end a platform's hints.
	notchHintDismissals = 2
	// notchHintKeepDays is how many shown days a record keeps.
	notchHintKeepDays = 14
)

// notchHint is the hint on the wire.
type notchHint struct {
	Platform string `json:"platform"`
	Name     string `json:"name"`
	LogoURL  string `json:"logo_url,omitempty"`
	Line     string `json:"line"`
	// Since is when this platform came in front, RFC 3339.
	Since string `json:"since"`
}

// notchHintRecord is one platform's history, as saved.
type notchHintRecord struct {
	// Shown lists the local days the hint was on screen, oldest first.
	Shown []string `json:"shown,omitempty"`
	// Dismissed counts Not nows; DismissedOn is the local day of the last.
	Dismissed   int    `json:"dismissed,omitempty"`
	DismissedOn string `json:"dismissed_on,omitempty"`
}

// notchHintStore is the history plus what is in front right now. Its own
// lock: reading and writing the file never holds the broker's.
type notchHintStore struct {
	mu      sync.Mutex
	loaded  bool
	records map[string]*notchHintRecord
	// candidate is the platform in front and since when.
	candidate string
	since     time.Time
}

func (b *Broker) notchHintPath() string {
	return filepath.Join(filepath.Dir(b.statePath), "notch-hints.json")
}

func notchLocalDay(now time.Time) string {
	return now.Local().Format("2006-01-02")
}

// loadLocked reads the file once. Caller holds s.mu.
func (s *notchHintStore) loadLocked(path string) {
	if s.loaded {
		return
	}
	s.loaded = true
	s.records = map[string]*notchHintRecord{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var saved map[string]*notchHintRecord
	if json.Unmarshal(raw, &saved) != nil {
		return
	}
	for platform, rec := range saved {
		if rec != nil && strings.TrimSpace(platform) != "" {
			s.records[platform] = rec
		}
	}
}

// saveLocked writes the records. Caller holds s.mu.
func (s *notchHintStore) saveLocked(path string) error {
	raw, err := json.Marshal(s.records)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, raw)
}

func (r *notchHintRecord) shownOn(day string) bool {
	for _, d := range r.Shown {
		if d == day {
			return true
		}
	}
	return false
}

func (r *notchHintRecord) markShown(day string) {
	if r.shownOn(day) {
		return
	}
	r.Shown = append(r.Shown, day)
	if len(r.Shown) > notchHintKeepDays {
		r.Shown = r.Shown[len(r.Shown)-notchHintKeepDays:]
	}
}

// allowedLocked says whether platform may be hinted on day. Caller holds s.mu.
func (s *notchHintStore) allowedLocked(platform, day string) bool {
	rec := s.records[platform]
	if rec != nil {
		if rec.Dismissed >= notchHintDismissals || rec.DismissedOn == day {
			return false
		}
		if rec.shownOn(day) {
			// Already counted today: it may stay, or come back.
			return true
		}
	}
	today := 0
	for _, r := range s.records {
		if r.shownOn(day) {
			today++
		}
	}
	return today < notchHintPerDay
}

// notchHintPlatformInFront tracks what is in front and says when it has
// been there long enough. A platform of "" clears the candidate.
func (s *notchHintStore) notchHintPlatformInFront(platform string, now time.Time) (since time.Time, settled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if platform == "" {
		s.candidate, s.since = "", time.Time{}
		return time.Time{}, false
	}
	if s.candidate != platform {
		s.candidate, s.since = platform, now
	}
	return s.since, now.Sub(s.since) >= notchHintDwell
}

// notchHintConnected says whether the office already has the platform.
func (b *Broker) notchHintConnected(platform string) bool {
	entry, ok := b.lookupConnectionRegistry(platform)
	return ok && entry.State == string(action.StateConnected)
}

// notchHintCardOpen says whether a Connect card for the platform is waiting
// on the human already: the card is the louder of the two, and enough.
func (b *Broker) notchHintCardOpen(platform string) bool {
	key := connectRequestDedupeKey(platform)
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.requests {
		if normalizeRequestKind(b.requests[i].Kind) == "connect" && strings.TrimSpace(b.requests[i].DedupeKey) == key && requestIsActive(b.requests[i]) {
			return true
		}
	}
	return false
}

// withNotchAppHint adds the hint for what is in front, when there is one
// to give. Runs after the screen is read, on the owner's polls only.
func (b *Broker) withNotchAppHint(state notchState, owner bool, now time.Time) notchState {
	if !owner {
		return state
	}
	platform := notchHintPlatformFor(state.Screen)
	since, settled := b.notchHints.notchHintPlatformInFront(platform, now)
	if !settled {
		return state
	}
	if b.notchHintConnected(platform) || b.notchHintCardOpen(platform) {
		return state
	}
	s := &b.notchHints
	s.mu.Lock()
	s.loadLocked(b.notchHintPath())
	allowed := s.allowedLocked(platform, notchLocalDay(now))
	s.mu.Unlock()
	if !allowed {
		return state
	}
	hint := &notchHint{
		Platform: platform,
		Name:     action.DisplayPlatformName(platform),
		Line:     notchHintLine(platform),
		Since:    since.UTC().Format(time.RFC3339),
	}
	if t, ok := notchHintToolkit(platform); ok {
		if strings.TrimSpace(t.name) != "" {
			hint.Name = t.name
		}
		hint.LogoURL = t.logoURL
	}
	state.Hint = hint
	return state
}

// markNotchHint records that the hint was on screen today (seen) or sent
// away (dismiss).
func (b *Broker) markNotchHint(platform string, dismiss bool, now time.Time) error {
	s := &b.notchHints
	s.mu.Lock()
	defer s.mu.Unlock()
	path := b.notchHintPath()
	s.loadLocked(path)
	rec := s.records[platform]
	if rec == nil {
		rec = &notchHintRecord{}
		s.records[platform] = rec
	}
	day := notchLocalDay(now)
	rec.markShown(day)
	if dismiss {
		rec.Dismissed++
		rec.DismissedOn = day
		if s.candidate == platform {
			s.candidate, s.since = "", time.Time{}
		}
	}
	return s.saveLocked(path)
}

type notchHintRequest struct {
	Platform string `json:"platform"`
}

// handleNotchHintSeen is POST /notch/hint/seen; handleNotchHintDismiss is
// POST /notch/hint/dismiss. Both take {platform}. Owner only.
func (b *Broker) handleNotchHintSeen(w http.ResponseWriter, r *http.Request) {
	b.serveNotchHintMark(w, r, false)
}

func (b *Broker) handleNotchHintDismiss(w http.ResponseWriter, r *http.Request) {
	b.serveNotchHintMark(w, r, true)
}

func (b *Broker) serveNotchHintMark(w http.ResponseWriter, r *http.Request, dismiss bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner has hints"})
		return
	}
	var req notchHintRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	platform := connectionRegistryKey(req.Platform)
	if platform == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "which platform?"})
		return
	}
	if err := b.markNotchHint(platform, dismiss, time.Now()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "platform": platform})
}
