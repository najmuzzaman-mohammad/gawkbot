package team

// broker_notch_ideas_scan.go: the daily look across connected integrations
// that feeds the notch's ideas (broker_notch_ideas.go). Every fifteen
// minutes the "notch-ideas" system cron asks whether a scan is due: once
// per local day, at the hour the person chose, caught up after sleep.
// One scan: for each connected platform, a couple of read-only actions
// (asserted read-only by name, never a write), their results cut down to
// titles and subjects with ids; then ONE bounded one-shot call on the
// lead's runtime that drafts ideas as JSON; then every draft is vetted.
// Counts are logged, contents never. A platform that fails is skipped,
// not fatal. The person can ask for a scan by hand once an hour.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/action"
	"github.com/nex-crm/wuphf/internal/config"
)

const (
	notchIdeasCronSlug  = "notch-ideas"
	notchIdeasCronLabel = "Daily ideas for new bots"
	notchIdeasTick      = 15 * time.Minute
	notchIdeasScanMax   = 90 * time.Second
	notchIdeasProbeMax  = 20 * time.Second
	notchIdeasManualGap = time.Hour
	// notchIdeasEvidenceMax bounds what the judge sees, in items and bytes.
	notchIdeasEvidenceMax   = 60
	notchIdeasEvidenceBytes = 8 << 10
	notchIdeasPerPlatform   = 12
)

// notchIdeaProbe names, per platform, the read actions worth running, by
// the words their ids carry; the first two that exist and are read-only run.
var notchIdeaProbes = map[string][]string{
	"github":         {"LIST_PULL_REQUESTS", "ISSUES_LIST_FOR_AUTHENTICATED_USER", "LIST_ISSUES"},
	"gmail":          {"FETCH_EMAILS", "LIST_THREADS"},
	"googlecalendar": {"FIND_EVENT", "LIST_EVENTS", "EVENTS_LIST"},
	"linear":         {"LIST_LINEAR_ISSUES", "LIST_ISSUES"},
	"jira":           {"SEARCH_FOR_ISSUES", "SEARCH_ISSUES"},
	"notion":         {"SEARCH_NOTION_PAGE", "SEARCH_PAGES", "QUERY_DATABASE"},
	"hubspot":        {"LIST_DEALS", "SEARCH_DEALS", "LIST_CONTACTS"},
	"salesforce":     {"QUERY", "LIST_OPPORTUNITIES"},
	"slack":          {"LIST_ALL_CHANNELS", "FETCH_CONVERSATION_HISTORY"},
	"googledrive":    {"LIST_FILES", "FIND_FILE"},
}

// notchIdeaCollector gathers evidence from the connected platforms. Swapped
// by tests; the real one talks to Composio.
var notchIdeaCollectFn = func(ctx context.Context, b *Broker) (map[string]curatedComposioToolkit, []notchIdeaEvidence) {
	return b.collectNotchIdeaEvidence(ctx)
}

// notchIdeaJudgeFn is the one-shot drafting call; swapped by tests.
var notchIdeaJudgeFn = func(ctx context.Context, kind, system, user string) (string, error) {
	return notchSuggestFn(ctx, kind, system, user)
}

// connectedToolkits are the curated platforms the office has connected,
// by the registry's last-known state.
func (b *Broker) connectedToolkits() map[string]curatedComposioToolkit {
	b.mu.Lock()
	reg := b.cloneConnectionRegistryLocked()
	b.mu.Unlock()
	out := map[string]curatedComposioToolkit{}
	for _, t := range curatedComposioToolkits {
		if e, ok := reg[connectionRegistryKey(t.platform)]; ok && e.State == string(action.StateConnected) {
			out[t.platform] = t
		}
	}
	return out
}

// collectNotchIdeaEvidence runs the read probes against every connected
// platform. It never runs an action that is not read-only by name.
func (b *Broker) collectNotchIdeaEvidence(ctx context.Context) (map[string]curatedComposioToolkit, []notchIdeaEvidence) {
	connected := b.connectedToolkits()
	composio := action.NewComposioFromEnv()
	if len(connected) == 0 || !composio.Configured() {
		return connected, nil
	}
	platforms := make([]string, 0, len(connected))
	for p := range connected {
		platforms = append(platforms, p)
	}
	sort.Strings(platforms)
	var evidence []notchIdeaEvidence
	for _, platform := range platforms {
		if ctx.Err() != nil {
			break
		}
		items := b.probeNotchIdeaPlatform(ctx, composio, platform)
		log.Printf("notch ideas: %s: %d items", platform, len(items))
		evidence = append(evidence, items...)
	}
	return connected, boundNotchIdeaEvidence(evidence)
}

func (b *Broker) probeNotchIdeaPlatform(ctx context.Context, composio *action.ComposioREST, platform string) []notchIdeaEvidence {
	pctx, cancel := context.WithTimeout(ctx, notchIdeasProbeMax)
	defer cancel()
	key, ok := b.resolveAppIntegrationConnection(pctx, composio, platform)
	if !ok {
		return nil
	}
	search, err := composio.SearchActions(pctx, platform, "", "")
	if err != nil {
		return nil
	}
	available := map[string]bool{}
	for _, a := range search.Actions {
		id := strings.ToUpper(strings.TrimSpace(a.ActionID))
		if id != "" && action.ActionIsReadOnly(id) {
			available[id] = true
		}
	}
	var out []notchIdeaEvidence
	ran := 0
	for _, want := range notchIdeaProbes[platform] {
		if ran >= 2 {
			break
		}
		actionID := ""
		for id := range available {
			if strings.HasSuffix(id, "_"+want) || id == strings.ToUpper(platform)+"_"+want {
				actionID = id
				break
			}
		}
		if actionID == "" || !action.ActionIsReadOnly(actionID) {
			continue
		}
		res, err := composio.ExecuteAction(pctx, action.ExecuteRequest{Platform: platform, ActionID: actionID, ConnectionKey: key, Data: map[string]any{}})
		if err != nil {
			continue
		}
		ran++
		out = append(out, notchIdeaEvidenceFromResponse(platform, actionID, res.Response)...)
	}
	return out
}

// notchIdeaEvidenceFromResponse cuts a platform's reply down to the lines a
// person would read in a list: titles, subjects, names, numbers. Bodies,
// addresses, and anything else stay out.
func notchIdeaEvidenceFromResponse(platform, actionID string, raw json.RawMessage) []notchIdeaEvidence {
	var parsed any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil
	}
	var lines []string
	walk(parsed, 0, &lines)
	var out []notchIdeaEvidence
	for i, line := range lines {
		if i >= notchIdeasPerPlatform {
			break
		}
		out = append(out, notchIdeaEvidence{
			ID:       fmt.Sprintf("%s-%d", strings.ToLower(platform), len(out)+1),
			Platform: platform,
			Text:     truncate(line, 160),
		})
	}
	_ = actionID
	return out
}

// evidenceKeys are the fields a list row is named by, in order of preference.
var evidenceKeys = []string{"title", "subject", "name", "summary", "snippet", "number", "state", "status", "due_date", "start", "updated_at"}

func walk(v any, depth int, lines *[]string) {
	if depth > 6 || len(*lines) >= notchIdeasPerPlatform*2 {
		return
	}
	switch t := v.(type) {
	case []any:
		for _, it := range t {
			walk(it, depth+1, lines)
		}
	case map[string]any:
		var parts []string
		for _, k := range evidenceKeys {
			if s, ok := t[k]; ok {
				switch sv := s.(type) {
				case string:
					if strings.TrimSpace(sv) != "" {
						parts = append(parts, strings.TrimSpace(sv))
					}
				case float64:
					parts = append(parts, fmt.Sprintf("#%d", int64(sv)))
				case map[string]any:
					if ds, ok := sv["dateTime"].(string); ok {
						parts = append(parts, ds)
					}
				}
			}
		}
		if len(parts) > 0 {
			*lines = append(*lines, strings.Join(parts, " · "))
			return
		}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			walk(t[k], depth+1, lines)
		}
	}
}

// boundNotchIdeaEvidence keeps the evidence under the caps and renumbers ids.
func boundNotchIdeaEvidence(in []notchIdeaEvidence) []notchIdeaEvidence {
	var out []notchIdeaEvidence
	size := 0
	for _, e := range in {
		if len(out) >= notchIdeasEvidenceMax || size+len(e.Text) > notchIdeasEvidenceBytes {
			break
		}
		size += len(e.Text)
		out = append(out, e)
	}
	return out
}

const notchIdeasJudgeSystem = `You propose bots for a small office of AI bots that works for one person. You see a short list of what their connected tools hold right now (titles, subjects, numbers; ids in brackets). Propose up to 5 bots worth having, each tied to ONE of the connected integrations and grounded in the items you were shown.
Reply with JSON only: {"ideas":[{"name":"Release Checker","role":"its job title, two or three words, like release checker","integration":"github","promise":"first person, one or two sentences, naming real items from the list","rationale":"why now, one sentence","cadence":"a 5-field cron or empty","first_task":"what it does first, concretely","evidence":["github-3","github-7"]}]}
Rules: name under 40 characters, promise under 280, no bot the office already has, evidence ids only from the list, cadence no more often than hourly, and nothing invented.`

// notchIdeasScanDue says whether the automatic scan should run now.
func notchIdeasScanDue(now time.Time, hour int, scanDay string) bool {
	if notchLocalDay(now) == scanDay {
		return false
	}
	return now.Local().Hour() >= hour
}

// runNotchIdeasScan does one scan: evidence, judge, vet, remember.
// Returns how many ideas were added and a status word for the heartbeat.
func (b *Broker) runNotchIdeasScan(ctx context.Context, manual bool) (int, string) {
	s := &b.notchIdeas
	s.mu.Lock()
	s.loadLocked(b.notchIdeasPath())
	if s.scanning {
		s.mu.Unlock()
		return 0, "busy"
	}
	s.scanning = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.scanning = false
		s.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(ctx, notchIdeasScanMax)
	defer cancel()
	now := time.Now()

	connected, evidence := notchIdeaCollectFn(ctx, b)
	drafts := []notchIdeaDraft(nil)
	if len(evidence) > 0 {
		kind := b.notchLeadKind()
		out, err := notchIdeaJudgeFn(ctx, kind, notchIdeasJudgeSystem, renderNotchIdeasPrompt(connected, evidence, b.OfficeMembers()))
		if err != nil {
			log.Printf("notch ideas: judge failed: %v", err)
		} else {
			drafts = parseNotchIdeaDrafts(out)
		}
	}
	chk := notchIdeaCheck{Connected: connected, Evidence: map[string]notchIdeaEvidence{}, Members: map[string]bool{}, Now: now}
	for _, e := range evidence {
		chk.Evidence[e.ID] = e
	}
	for _, m := range b.OfficeMembers() {
		chk.Members[strings.ToLower(strings.TrimSpace(m.Name))] = true
		chk.Members[strings.ToLower(strings.TrimSpace(m.Slug))] = true
	}
	var ideas []notchIdea
	for _, d := range drafts {
		idea, why := vetNotchIdea(d, chk)
		if why != "" {
			log.Printf("notch ideas: dropped a draft: %s", why)
			continue
		}
		idea.Avatar = proposedIdeaAvatar(idea.Fingerprint)
		ideas = append(ideas, idea)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	added := s.rememberLocked(ideas)
	s.saved.CheckedAt = now.UTC().Format(time.RFC3339)
	if manual {
		s.saved.ManualAt = s.saved.CheckedAt
	} else {
		s.saved.ScanDay = notchLocalDay(now)
	}
	if err := s.saveLocked(b.notchIdeasPath()); err != nil {
		log.Printf("notch ideas: save failed: %v", err)
	}
	log.Printf("notch ideas: scan done: %d platforms, %d items, %d drafts, %d new", len(connected), len(evidence), len(drafts), added)
	return added, fmt.Sprintf("%d new", added)
}

// notchLeadKind is the lead's runtime kind, for the judge call.
func (b *Broker) notchLeadKind() string {
	now := time.Now()
	defaults := b.cachedRuntimeDefaults(now)
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.notchLeadKindLocked(officeLeadSlugFrom(b.members), defaults)
}

// renderNotchIdeasPrompt is what the judge reads.
func renderNotchIdeasPrompt(connected map[string]curatedComposioToolkit, evidence []notchIdeaEvidence, members []officeMember) string {
	var sb strings.Builder
	sb.WriteString("Connected integrations: ")
	names := make([]string, 0, len(connected))
	for p := range connected {
		names = append(names, p)
	}
	sort.Strings(names)
	sb.WriteString(strings.Join(names, ", "))
	sb.WriteString("\nBots the office already has: ")
	have := make([]string, 0, len(members))
	for _, m := range members {
		if !isSessionMember(m) {
			have = append(have, m.Name)
		}
	}
	sb.WriteString(strings.Join(have, ", "))
	sb.WriteString("\n\nWhat the tools hold right now:\n")
	for _, e := range evidence {
		fmt.Fprintf(&sb, "[%s] %s: %s\n", e.ID, e.Platform, e.Text)
	}
	return sb.String()
}

// proposedIdeaAvatar gives every idea a face of its own, from its fingerprint.
func proposedIdeaAvatar(fingerprint string) *MemberAvatar {
	colors := []string{"#ff7a59", "#64d2ff", "#30d158", "#ffd60a", "#bf5af2", "#ff9f0a", "#5e5ce6", "#ff375f"}
	n := 0
	for _, c := range fingerprint {
		n = n*31 + int(c)
	}
	if n < 0 {
		n = -n
	}
	look := &MemberLook{
		Hair:      LookHair[1+(n/3)%(len(LookHair)-1)],
		Eyes:      LookEyes[(n/11)%len(LookEyes)],
		Accessory: LookAccessories[(n/13)%len(LookAccessories)],
	}
	if look.Eyes == "default" {
		look.Eyes = ""
	}
	if look.Accessory == "none" {
		look.Accessory = ""
	}
	return &MemberAvatar{Shape: AvatarShapes[n%len(AvatarShapes)], Color: colors[(n/7)%len(colors)], Look: look}
}

// startNotchIdeasLoop runs the scan under the system cron.
func (b *Broker) startNotchIdeasLoop(ctx context.Context) {
	go func() {
		for {
			enabled, interval := b.SchedulerJobControl(notchIdeasCronSlug, notchIdeasTick)
			now := time.Now().UTC()
			b.updateSchedulerHeartbeat(notchIdeasCronSlug, notchIdeasCronLabel, int(interval/time.Minute), now.Add(interval), disabledOrSleeping(enabled), "")
			select {
			case <-ctx.Done():
				return
			case <-time.After(interval):
			}
			cfg, _ := config.Load()
			if !enabled || !cfg.IsNotchIdeasEnabled() {
				continue
			}
			s := &b.notchIdeas
			s.mu.Lock()
			s.loadLocked(b.notchIdeasPath())
			due := notchIdeasScanDue(time.Now(), cfg.NotchIdeasHourOrDefault(), s.saved.ScanDay)
			s.mu.Unlock()
			if !due {
				continue
			}
			_, status := b.runNotchIdeasScan(ctx, false)
			b.updateSchedulerHeartbeat(notchIdeasCronSlug, notchIdeasCronLabel, int(interval/time.Minute), time.Now().UTC().Add(interval), "sleeping", status)
		}
	}()
}

// handleNotchIdeasScan is POST /notch/ideas/scan: a scan by hand, once an hour.
func (b *Broker) handleNotchIdeasScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner has ideas"})
		return
	}
	s := &b.notchIdeas
	s.mu.Lock()
	s.loadLocked(b.notchIdeasPath())
	last, _ := time.Parse(time.RFC3339, s.saved.ManualAt)
	s.mu.Unlock()
	if time.Since(last) < notchIdeasManualGap {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "already looked within the hour"})
		return
	}
	go func() {
		b.runNotchIdeasScan(context.Background(), true)
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}
