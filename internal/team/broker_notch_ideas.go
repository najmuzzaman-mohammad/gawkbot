package team

// broker_notch_ideas.go: the office's daily ideas for new bots. Once a day
// the office looks across the integrations the person connected, reads a
// little (titles, subjects, numbers; never bodies), and proposes a few bots
// worth having: each tied to one connected integration, with a first-person
// promise that cites what it saw, a reason, and a cadence. The notch shows
// them as cards with No and "Yes, make it and go"; accepting creates the
// bot, writes its instructions, registers its routine, and sends it off on
// its first task. Nothing is created without a click.
//
// The scan (broker_notch_ideas_scan.go) runs under the "notch-ideas" system
// cron and never writes to a platform. The judge is one bounded one-shot
// call that only drafts JSON; everything it says is checked here before it
// becomes a card. What was proposed, seen, sent away, and accepted is saved
// to notch-ideas.json beside the broker state.

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nex-crm/wuphf/internal/action"
	"github.com/nex-crm/wuphf/internal/calendar"
	"github.com/nex-crm/wuphf/internal/config"
)

const (
	// notchIdeasVisibleMax is how many ideas a day the notch shows.
	notchIdeasVisibleMax = 5
	// notchIdeasPerScanMax is how many one scan may add.
	notchIdeasPerScanMax = 5
	// notchIdeasRestDays is how long an idea rests after it was sent away
	// twice (by fingerprint), and how long an accepted one is remembered.
	notchIdeasRestDays = 14
	// notchIdeasDismissals is how many Nos end an idea's fingerprint.
	notchIdeasDismissals = 2
	notchIdeaNameMax     = 40
	notchIdeaPromiseMax  = 280
	notchIdeaReasonMax   = 240
	notchIdeaTaskMax     = 400
	notchIdeaKeepMax     = 60
)

// notchIdeaEvidence is one thing the scan saw, by id, so a promise can cite it.
type notchIdeaEvidence struct {
	ID       string `json:"id"`
	Platform string `json:"platform"`
	Text     string `json:"text"`
}

// notchIdea is one proposed bot, as the notch shows it.
type notchIdea struct {
	ID              string              `json:"id"`
	Fingerprint     string              `json:"fingerprint"`
	Name            string              `json:"name"`
	Role            string              `json:"role"`
	Integration     string              `json:"integration"`
	IntegrationName string              `json:"integration_name"`
	LogoURL         string              `json:"logo_url,omitempty"`
	Promise         string              `json:"promise"`
	Rationale       string              `json:"rationale"`
	Cadence         string              `json:"cadence,omitempty"`
	CadenceLabel    string              `json:"cadence_label,omitempty"`
	FirstTask       string              `json:"first_task"`
	Evidence        []notchIdeaEvidence `json:"evidence,omitempty"`
	Avatar          *MemberAvatar       `json:"avatar,omitempty"`
	CreatedAt       string              `json:"created_at"`
	SeenCount       int                 `json:"seen_count,omitempty"`
}

// notchIdeas is the block on the notch state.
type notchIdeas struct {
	Enabled   bool        `json:"enabled"`
	CheckedAt string      `json:"checked_at,omitempty"`
	NextAt    string      `json:"next_at,omitempty"`
	Scanning  bool        `json:"scanning,omitempty"`
	Items     []notchIdea `json:"items"`
}

// notchIdeasSaved is the file's shape.
type notchIdeasSaved struct {
	Items     []notchIdea `json:"items"`
	CheckedAt string      `json:"checked_at,omitempty"`
	// Dismissed maps a fingerprint to how many times it was sent away and when last.
	Dismissed map[string]notchIdeaMark `json:"dismissed,omitempty"`
	// Accepted maps a fingerprint to when it became a bot.
	Accepted map[string]string `json:"accepted,omitempty"`
	// ScanDay is the local day of the last automatic scan.
	ScanDay string `json:"scan_day,omitempty"`
	// ManualAt is when the person last asked for a scan by hand.
	ManualAt string `json:"manual_at,omitempty"`
}

type notchIdeaMark struct {
	Count int    `json:"count"`
	At    string `json:"at"`
}

// notchIdeasStore holds the ideas with its own lock and file.
type notchIdeasStore struct {
	mu       sync.Mutex
	loaded   bool
	saved    notchIdeasSaved
	scanning bool
}

func (b *Broker) notchIdeasPath() string {
	return filepath.Join(filepath.Dir(b.statePath), "notch-ideas.json")
}

func (s *notchIdeasStore) loadLocked(path string) {
	if s.loaded {
		return
	}
	s.loaded = true
	s.saved = notchIdeasSaved{Dismissed: map[string]notchIdeaMark{}, Accepted: map[string]string{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var saved notchIdeasSaved
	if json.Unmarshal(raw, &saved) != nil {
		return
	}
	if saved.Dismissed == nil {
		saved.Dismissed = map[string]notchIdeaMark{}
	}
	if saved.Accepted == nil {
		saved.Accepted = map[string]string{}
	}
	s.saved = saved
}

func (s *notchIdeasStore) saveLocked(path string) error {
	raw, err := json.Marshal(s.saved)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, raw)
}

// notchIdeaFingerprint names an idea by what it is for, not how it was
// worded, so the same idea proposed twice is one idea.
func notchIdeaFingerprint(integration, name, promise string) string {
	sum := sha1.Sum([]byte(strings.ToLower(strings.TrimSpace(integration)) + "|" + normalizeRoutinePurpose(name+" "+promise)))
	return hex.EncodeToString(sum[:])[:16]
}

// notchIdeaDraft is what the judge returns, before it is checked.
type notchIdeaDraft struct {
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	Integration string   `json:"integration"`
	Promise     string   `json:"promise"`
	Rationale   string   `json:"rationale"`
	Cadence     string   `json:"cadence"`
	FirstTask   string   `json:"first_task"`
	Evidence    []string `json:"evidence"`
}

type notchIdeaJudgeOut struct {
	Ideas []notchIdeaDraft `json:"ideas"`
}

// parseNotchIdeaDrafts reads the judge's JSON. Anything that is not the
// shape asked for is no ideas, not an error that stops the scan.
func parseNotchIdeaDrafts(out string) []notchIdeaDraft {
	raw, ok := extractFirstJSON(out)
	if !ok {
		return nil
	}
	var parsed notchIdeaJudgeOut
	if json.Unmarshal(raw, &parsed) != nil {
		// A bare list is accepted too.
		var list []notchIdeaDraft
		if json.Unmarshal(raw, &list) != nil {
			return nil
		}
		return list
	}
	return parsed.Ideas
}

// notchIdeaCheck is what a draft is checked against.
type notchIdeaCheck struct {
	// Connected maps a platform to its catalog name and logo.
	Connected map[string]curatedComposioToolkit
	// Evidence maps an id to the item the scan saw.
	Evidence map[string]notchIdeaEvidence
	// Members are the office's bot names and slugs, lowercased.
	Members map[string]bool
	Now     time.Time
}

// notchCadenceLabel says a cron in words, for the card.
func notchCadenceLabel(expr string) string {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return ""
	}
	minute, hour, dom, _, dow := fields[0], fields[1], fields[2], fields[3], fields[4]
	clock := func() string {
		if strings.ContainsAny(hour, "*/,-") || strings.ContainsAny(minute, "*/,-") {
			return ""
		}
		h, m := strings.TrimLeft(hour, "0"), minute
		if h == "" {
			h = "0"
		}
		if len(m) == 1 {
			m = "0" + m
		}
		return " at " + h + ":" + m
	}
	switch {
	case dom == "*" && dow == "*":
		if c := clock(); c != "" {
			return "Every day" + c + ", while this Mac is awake"
		}
		return "Every day, while this Mac is awake"
	case dom == "*" && dow == "1-5":
		return "Every weekday" + clock() + ", while this Mac is awake"
	case dom == "*" && dow != "*":
		return "Every week" + clock() + ", while this Mac is awake"
	default:
		return "On a schedule, while this Mac is awake"
	}
}

// vetNotchIdea turns a draft into a card, or says why not. Every claim the
// judge made is checked: the integration is one the person connected, the
// evidence ids are ones the scan produced, the cadence parses, the bot's
// name is free, and nothing runs past the card's size.
func vetNotchIdea(d notchIdeaDraft, chk notchIdeaCheck) (notchIdea, string) {
	integration := connectionRegistryKey(d.Integration)
	toolkit, ok := chk.Connected[integration]
	if !ok {
		return notchIdea{}, "integration not connected"
	}
	name := strings.TrimSpace(d.Name)
	promise := strings.TrimSpace(d.Promise)
	if name == "" || promise == "" {
		return notchIdea{}, "no name or promise"
	}
	if len(name) > notchIdeaNameMax || len(promise) > notchIdeaPromiseMax {
		return notchIdea{}, "too long"
	}
	if chk.Members[strings.ToLower(name)] || chk.Members[deriveSchedulerSlugFromLabel(name)] {
		return notchIdea{}, "a bot has that name"
	}
	var evidence []notchIdeaEvidence
	for _, id := range d.Evidence {
		e, ok := chk.Evidence[strings.TrimSpace(id)]
		if !ok || e.Platform != integration {
			return notchIdea{}, "evidence not from the scan"
		}
		evidence = append(evidence, e)
	}
	if len(evidence) == 0 {
		return notchIdea{}, "no evidence cited"
	}
	cadence := strings.TrimSpace(d.Cadence)
	label := ""
	if cadence != "" {
		if _, err := calendar.ParseCron(cadence); err != nil {
			return notchIdea{}, "cadence does not parse"
		}
		if msg := validateRoutineCadence(cadence, 0); msg != "" {
			return notchIdea{}, "cadence too often"
		}
		label = notchCadenceLabel(cadence)
	}
	idea := notchIdea{
		Fingerprint:     notchIdeaFingerprint(integration, name, promise),
		Name:            name,
		Role:            truncate(strings.TrimSpace(d.Role), 80),
		Integration:     integration,
		IntegrationName: toolkit.name,
		LogoURL:         toolkit.logoURL,
		Promise:         promise,
		Rationale:       truncate(strings.TrimSpace(d.Rationale), notchIdeaReasonMax),
		Cadence:         cadence,
		CadenceLabel:    label,
		FirstTask:       truncate(strings.TrimSpace(d.FirstTask), notchIdeaTaskMax),
		Evidence:        evidence,
		CreatedAt:       chk.Now.UTC().Format(time.RFC3339),
	}
	if idea.IntegrationName == "" {
		idea.IntegrationName = action.DisplayPlatformName(integration)
	}
	if idea.FirstTask == "" {
		idea.FirstTask = promise
	}
	idea.ID = "idea:" + idea.Fingerprint
	return idea, ""
}

// notchIdeasVisible is the ideas worth showing now: not sent away for good,
// not accepted, not resting, newest first, at most the day's cap.
func (s *notchIdeasStore) visibleLocked(now time.Time) []notchIdea {
	var out []notchIdea
	rest := now.Add(-notchIdeasRestDays * 24 * time.Hour)
	for _, it := range s.saved.Items {
		if _, ok := s.saved.Accepted[it.Fingerprint]; ok {
			continue
		}
		if m, ok := s.saved.Dismissed[it.Fingerprint]; ok {
			at, _ := time.Parse(time.RFC3339, m.At)
			if m.Count >= notchIdeasDismissals || at.After(rest) {
				continue
			}
		}
		out = append(out, it)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	if len(out) > notchIdeasVisibleMax {
		out = out[:notchIdeasVisibleMax]
	}
	return out
}

// rememberLocked adds vetted ideas, dropping ones the person already dealt
// with, and keeps the list bounded. Returns how many were new.
func (s *notchIdeasStore) rememberLocked(ideas []notchIdea) int {
	have := map[string]bool{}
	for _, it := range s.saved.Items {
		have[it.Fingerprint] = true
	}
	added := 0
	for _, it := range ideas {
		if have[it.Fingerprint] {
			continue
		}
		if _, ok := s.saved.Accepted[it.Fingerprint]; ok {
			continue
		}
		if m, ok := s.saved.Dismissed[it.Fingerprint]; ok && m.Count >= notchIdeasDismissals {
			continue
		}
		s.saved.Items = append(s.saved.Items, it)
		have[it.Fingerprint] = true
		added++
		if added >= notchIdeasPerScanMax {
			break
		}
	}
	if len(s.saved.Items) > notchIdeaKeepMax {
		s.saved.Items = s.saved.Items[len(s.saved.Items)-notchIdeaKeepMax:]
	}
	return added
}

func (s *notchIdeasStore) findLocked(id string) (int, bool) {
	for i, it := range s.saved.Items {
		if it.ID == id {
			return i, true
		}
	}
	return 0, false
}

// withNotchIdeas adds the ideas block to the owner's state.
func (b *Broker) withNotchIdeas(state notchState, owner bool, now time.Time) notchState {
	if !owner {
		return state
	}
	cfg, _ := config.Load()
	s := &b.notchIdeas
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked(b.notchIdeasPath())
	block := &notchIdeas{
		Enabled:   cfg.IsNotchIdeasEnabled(),
		CheckedAt: s.saved.CheckedAt,
		Scanning:  s.scanning,
		Items:     s.visibleLocked(now),
	}
	if block.Items == nil {
		block.Items = []notchIdea{}
	}
	if block.Enabled {
		block.NextAt = notchIdeasNextAt(now, cfg.NotchIdeasHourOrDefault(), s.saved.ScanDay).UTC().Format(time.RFC3339)
	}
	state.Ideas = block
	return state
}

// notchIdeasNextAt is when the next automatic scan is due: today at the
// hour if it has not run today and the hour has not passed, else tomorrow.
func notchIdeasNextAt(now time.Time, hour int, scanDay string) time.Time {
	local := now.Local()
	today := time.Date(local.Year(), local.Month(), local.Day(), hour, 0, 0, 0, local.Location())
	if notchLocalDay(now) != scanDay && !local.After(today) {
		return today
	}
	if notchLocalDay(now) != scanDay && local.After(today) {
		// Missed today's hour (asleep): due now.
		return local
	}
	return today.Add(24 * time.Hour)
}

// markNotchIdea records seen (count) or dismissed (count and rest).
func (b *Broker) markNotchIdea(id string, dismiss bool, now time.Time) (bool, error) {
	s := &b.notchIdeas
	s.mu.Lock()
	defer s.mu.Unlock()
	path := b.notchIdeasPath()
	s.loadLocked(path)
	i, ok := s.findLocked(id)
	if !ok {
		return false, nil
	}
	if dismiss {
		m := s.saved.Dismissed[s.saved.Items[i].Fingerprint]
		m.Count++
		m.At = now.UTC().Format(time.RFC3339)
		s.saved.Dismissed[s.saved.Items[i].Fingerprint] = m
	} else {
		s.saved.Items[i].SeenCount++
	}
	return true, s.saveLocked(path)
}

// notchIdeaRequest is the body of the seen / dismiss / accept routes.
type notchIdeaRequest struct {
	ID string `json:"id"`
}

// handleNotchIdeaSeen is POST /notch/ideas/seen; handleNotchIdeaDismiss is
// POST /notch/ideas/dismiss. Owner only.
func (b *Broker) handleNotchIdeaSeen(w http.ResponseWriter, r *http.Request) {
	b.serveNotchIdeaMark(w, r, false)
}

func (b *Broker) handleNotchIdeaDismiss(w http.ResponseWriter, r *http.Request) {
	b.serveNotchIdeaMark(w, r, true)
}

func (b *Broker) serveNotchIdeaMark(w http.ResponseWriter, r *http.Request, dismiss bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner has ideas"})
		return
	}
	var req notchIdeaRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	found, err := b.markNotchIdea(strings.TrimSpace(req.ID), dismiss, time.Now())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save"})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such idea"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
