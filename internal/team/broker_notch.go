package team

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
)

// GET /notch/state — everything the Mac notch needs in one poll: every
// agent's mood (which picks its animation), what needs the human, and a
// one-line headline in the Chief of Staff's voice. The notch answers
// requests through the existing /requests/answer and messages the Chief of
// Staff through the existing /messages, in the LeadDM channel named here.
//
// Owner-only, like the rest of the desktop surface: it is not on the
// joined-human allowlist.

// Moods drive the notch animations. WIRE CONTRACT: web/src/notch/types.ts.
const (
	MoodWorking  = "working"
	MoodIdle     = "idle"
	MoodNeedsYou = "needs_you"
	MoodError    = "error"
	MoodDone     = "done"
)

// notchDoneWindow is how long a finished turn keeps its bot celebrating
// before it settles back to idle.
const notchDoneWindow = 45 * time.Second

type notchAgent struct {
	Slug         string `json:"slug"`
	Name         string `json:"name"`
	Mood         string `json:"mood"`
	Detail       string `json:"detail,omitempty"`
	Origin       string `json:"origin,omitempty"`
	RunsOn       string `json:"runs_on,omitempty"`
	RunsOnDetail string `json:"runs_on_detail,omitempty"`
	IsLead       bool   `json:"is_lead,omitempty"`
	// Avatar is the bot's chosen look, when it has one.
	Avatar *MemberAvatar `json:"avatar,omitempty"`
}

type notchOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Description says what choosing this would mean, in the asker's words.
	Description string `json:"description,omitempty"`
	// RequiresText options need a typed answer; the notch sends the human
	// to the full app for those rather than answering blind.
	RequiresText bool `json:"requires_text,omitempty"`
}

// How much of a decision brief the notch card shows before it is opened.
const notchContextMax = 320

// What the opened card holds: the asker's brief in full, and a few lines
// of the conversation around it.
const (
	notchBriefContextMax = 4000
	notchBriefDetailsMax = 600
	notchBriefLineMax    = 280
	notchBriefRecentMax  = 4
)

// notchBrief is everything the human needs to answer without leaving the
// notch: which project this is, what the asker was doing there, what was
// said just before, and the asker's own account of the decision. The card
// shows it when the question is hovered or selected.
type notchBrief struct {
	// Context is the asker's decision brief, in full.
	Context string `json:"context,omitempty"`
	// Project is the room the work lives in (never a DM), with what the
	// room is for.
	Project      string `json:"project,omitempty"`
	ProjectAbout string `json:"project_about,omitempty"`
	// Task is the piece of work the question came out of.
	Task *notchBriefTask `json:"task,omitempty"`
	// AskerRole is what the asking bot does in the office.
	AskerRole string `json:"asker_role,omitempty"`
	// Recent is the last few lines of that room, oldest first.
	Recent []notchBriefLine `json:"recent,omitempty"`
}

type notchBriefTask struct {
	Title   string `json:"title"`
	Details string `json:"details,omitempty"`
	Status  string `json:"status,omitempty"`
}

type notchBriefLine struct {
	From string `json:"from"`
	Name string `json:"name,omitempty"`
	Text string `json:"text"`
	At   string `json:"at,omitempty"`
}

type notchAttention struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	From     string `json:"from"`
	FromName string `json:"from_name,omitempty"`
	Channel  string `json:"channel,omitempty"`
	Title    string `json:"title,omitempty"`
	Question string `json:"question"`
	// The decision brief the asker gave: what it was doing, what it found,
	// why it cannot decide alone. Trimmed to what a card can show.
	Context string `json:"context,omitempty"`
	// Brief is the full background, shown when the card is opened. Never
	// set for a secret prompt.
	Brief         *notchBrief   `json:"brief,omitempty"`
	Options       []notchOption `json:"options,omitempty"`
	RecommendedID string        `json:"recommended_id,omitempty"`
	Blocking      bool          `json:"blocking,omitempty"`
	CreatedAt     string        `json:"created_at,omitempty"`
}

type notchState struct {
	Lead      string           `json:"lead,omitempty"`
	LeadName  string           `json:"lead_name,omitempty"`
	LeadDM    string           `json:"lead_dm,omitempty"`
	Mood      string           `json:"mood"`
	Headline  string           `json:"headline"`
	Agents    []notchAgent     `json:"agents"`
	Attention []notchAttention `json:"attention"`
}

func (b *Broker) handleNotchState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	b.mu.Lock()
	state := b.notchStateLocked(time.Now())
	b.mu.Unlock()
	writeJSON(w, http.StatusOK, state)
}

func (b *Broker) notchStateLocked(now time.Time) notchState {
	lead := officeLeadSlugFrom(b.members)
	names := make(map[string]string, len(b.members))
	for _, m := range b.members {
		names[m.Slug] = firstNonEmpty(strings.TrimSpace(m.Name), m.Slug)
	}

	state := notchState{
		Lead:      lead,
		LeadName:  names[lead],
		Agents:    []notchAgent{},
		Attention: []notchAttention{},
	}
	if lead != "" {
		state.LeadDM = channel.DirectSlug("human", lead)
	}

	needsYou := map[string]bool{}
	for _, req := range b.requests {
		if !requestIsActive(req) {
			continue
		}
		from := strings.TrimSpace(req.From)
		needsYou[from] = true
		item := notchAttention{
			ID:            req.ID,
			Kind:          firstNonEmpty(normalizeRequestKind(req.Kind), "question"),
			From:          from,
			FromName:      names[from],
			Channel:       req.Channel,
			Title:         notchTitle(req.Title),
			Question:      req.Question,
			Context:       truncate(strings.TrimSpace(req.Context), notchContextMax),
			RecommendedID: req.RecommendedID,
			Blocking:      req.Blocking,
			CreatedAt:     req.CreatedAt,
		}
		if req.Secret {
			// Never surface a secret prompt's options for a one-tap answer;
			// the full app handles masked input.
			item.Question = firstNonEmpty(req.Title, "A teammate needs a private answer")
			item.Context = ""
		} else {
			for _, o := range req.Options {
				item.Options = append(item.Options, notchOption{ID: o.ID, Label: firstNonEmpty(o.Label, o.ID), Description: strings.TrimSpace(o.Description), RequiresText: o.RequiresText})
			}
			item.Brief = b.notchBriefLocked(req, names)
		}
		state.Attention = append(state.Attention, item)
	}
	// Blocking first, then oldest first: the thing holding work up leads.
	sort.SliceStable(state.Attention, func(i, j int) bool {
		a, c := state.Attention[i], state.Attention[j]
		if a.Blocking != c.Blocking {
			return a.Blocking
		}
		return a.CreatedAt < c.CreatedAt
	})

	counts := map[string]int{}
	for _, m := range b.members {
		agent := notchAgent{
			Slug:   m.Slug,
			Name:   names[m.Slug],
			Origin: memberOrigin(m, lead),
			IsLead: m.Slug == lead,
		}
		if m.Avatar != nil {
			avatar := *m.Avatar
			agent.Avatar = &avatar
		}
		agent.RunsOn, agent.RunsOnDetail = memberRunsOn(m)
		snap := b.activity[m.Slug]
		agent.Mood, agent.Detail = notchMood(snap, needsYou[m.Slug], now)
		counts[agent.Mood]++
		state.Agents = append(state.Agents, agent)
	}
	// The lead first, then the agents that most need looking at.
	rank := map[string]int{MoodNeedsYou: 0, MoodError: 1, MoodWorking: 2, MoodDone: 3, MoodIdle: 4}
	sort.SliceStable(state.Agents, func(i, j int) bool {
		a, c := state.Agents[i], state.Agents[j]
		if a.IsLead != c.IsLead {
			return a.IsLead
		}
		return rank[a.Mood] < rank[c.Mood]
	})

	state.Mood, state.Headline = notchHeadline(len(state.Attention), counts, state.Attention, names)
	return state
}

// notchMood maps a bot's activity snapshot (written by the headless runners'
// updateHeadlessProgress) plus its open requests onto one animation.
func notchMood(snap botActivitySnapshot, hasOpenRequest bool, now time.Time) (mood, detail string) {
	detail = strings.TrimSpace(snap.Detail)
	if hasOpenRequest {
		return MoodNeedsYou, firstNonEmpty(detail, "waiting on you")
	}
	status := strings.ToLower(strings.TrimSpace(snap.Status))
	switch status {
	case "error":
		return MoodError, detail
	case "active":
		return MoodWorking, detail
	}
	if strings.HasPrefix(detail, "reply ready") {
		if at, err := time.Parse(time.RFC3339, snap.LastTime); err == nil && now.Sub(at) < notchDoneWindow {
			return MoodDone, "just finished"
		}
	}
	if snap.Kind == "stuck" {
		return MoodError, firstNonEmpty(detail, "looks stuck")
	}
	return MoodIdle, ""
}

// notchHeadline is the collapsed notch's one line, in the Chief of Staff's
// voice, plus the overall mood the notch ears animate with.
func notchHeadline(attention int, counts map[string]int, items []notchAttention, names map[string]string) (string, string) {
	switch {
	case attention == 1:
		who := firstNonEmpty(items[0].FromName, items[0].From, "Someone")
		return MoodNeedsYou, fmt.Sprintf("%s needs you: %s", who, truncate(firstNonEmpty(items[0].Title, items[0].Question), 80))
	case attention > 1:
		return MoodNeedsYou, fmt.Sprintf("%d things need you", attention)
	case counts[MoodError] > 0:
		return MoodError, notchCount(counts[MoodError], "bot hit a snag", "bots hit a snag")
	case counts[MoodWorking] > 0:
		return MoodWorking, notchCount(counts[MoodWorking], "bot working", "bots working")
	case counts[MoodDone] > 0:
		return MoodDone, "Done. Nothing needs you."
	default:
		return MoodIdle, "All quiet. Nothing needs you."
	}
}

func notchCount(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// notchBriefLocked gathers the background for one open request. Caller
// holds b.mu. Returns nil when there is nothing to add to the question.
func (b *Broker) notchBriefLocked(req humanInterview, names map[string]string) *notchBrief {
	from := strings.TrimSpace(req.From)
	brief := notchBrief{Context: truncate(strings.TrimSpace(req.Context), notchBriefContextMax)}
	if m := b.findMemberLocked(from); m != nil {
		brief.AskerRole = strings.TrimSpace(m.Role)
	}

	ch := b.findChannelLocked(req.Channel)
	if ch != nil && ch.Type != "dm" {
		brief.Project = firstNonEmpty(strings.TrimSpace(ch.Name), ch.Slug)
		brief.ProjectAbout = truncate(strings.TrimSpace(ch.Description), notchBriefDetailsMax)
	}

	if task := b.notchBriefTaskLocked(req, ch); task != nil {
		brief.Task = &notchBriefTask{
			Title:   strings.TrimSpace(task.Title),
			Details: truncate(strings.TrimSpace(task.Details), notchBriefDetailsMax),
			Status:  task.Status(),
		}
	}

	// The last few lines of the room the question was asked in, so the
	// human can see what led up to it.
	if req.Channel != "" {
		for i := len(b.messages) - 1; i >= 0 && len(brief.Recent) < notchBriefRecentMax; i-- {
			msg := b.messages[i]
			text := strings.TrimSpace(msg.Content)
			// The system's own announcement of the request says nothing the
			// card does not already say.
			if msg.Channel != req.Channel || text == "" || msg.From == "system" {
				continue
			}
			brief.Recent = append(brief.Recent, notchBriefLine{
				From: msg.From,
				Name: names[msg.From],
				Text: truncate(text, notchBriefLineMax),
				At:   msg.Timestamp,
			})
		}
		// Collected newest first; the card reads oldest first.
		for i, j := 0, len(brief.Recent)-1; i < j; i, j = i+1, j-1 {
			brief.Recent[i], brief.Recent[j] = brief.Recent[j], brief.Recent[i]
		}
	}

	if brief.Context == "" && brief.Project == "" && brief.Task == nil && brief.AskerRole == "" && len(brief.Recent) == 0 {
		return nil
	}
	return &brief
}

// notchBriefTaskLocked finds the work a request came out of: the task it
// names, else the task its room belongs to, else what the asker has open
// right now (the most recently created one).
func (b *Broker) notchBriefTaskLocked(req humanInterview, ch *teamChannel) *teamTask {
	if id := strings.TrimSpace(req.IssueID); id != "" {
		if t := b.findTaskByIDLocked(id); t != nil {
			return t
		}
	}
	if ch != nil && strings.TrimSpace(ch.TaskID) != "" {
		if t := b.findTaskByIDLocked(ch.TaskID); t != nil {
			return t
		}
	}
	from := strings.TrimSpace(req.From)
	for i := len(b.tasks) - 1; i >= 0; i-- {
		t := &b.tasks[i]
		if t.Owner != from {
			continue
		}
		switch strings.ToLower(t.Status()) {
		case "done", "completed", "canceled", "cancelled", "archived":
			continue
		}
		return t
	}
	return nil
}

// notchTitle drops the broker's placeholder title: "Request" in front of a
// question tells the human nothing.
func notchTitle(title string) string {
	t := strings.TrimSpace(title)
	if strings.EqualFold(t, "Request") {
		return ""
	}
	return t
}
