package team

// broker_notch_ideas_accept.go: "Yes, make it and go". Accepting an idea
// creates the bot (a real office member, on the office's default runtime),
// writes its OPERATIONS file with the promise and what it saw, registers
// its routine when the idea has a cadence, and sends it off on its first
// task now, through the same automation post a due routine makes. Only a
// click does this; the scan never creates anything. Owner only.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/calendar"
	"github.com/nex-crm/wuphf/internal/channel"
)

// notchIdeaSlug is the bot's slug for an idea's name, free of collisions.
func (b *Broker) notchIdeaSlugLocked(name string) string {
	base := deriveSchedulerSlugFromLabel(name)
	if base == "" {
		base = "bot"
	}
	slug := base
	for n := 2; b.findMemberLocked(slug) != nil; n++ {
		slug = fmt.Sprintf("%s-%d", base, n)
	}
	return slug
}

// renderIdeaOperations is the new bot's OPERATIONS file: the office's
// standing rules, then the idea it was made for and what the scan saw.
func renderIdeaOperations(member officeMember, idea notchIdea) string {
	var sb strings.Builder
	sb.WriteString(renderBotOperations(member, false))
	sb.WriteString("\n## Why you exist\n")
	fmt.Fprintf(&sb, "- Proposed by the office's daily look across %s on %s.\n", idea.IntegrationName, strings.Split(idea.CreatedAt, "T")[0])
	fmt.Fprintf(&sb, "- Your promise: %s\n", idea.Promise)
	if idea.Rationale != "" {
		fmt.Fprintf(&sb, "- Why now: %s\n", idea.Rationale)
	}
	if idea.CadenceLabel != "" {
		fmt.Fprintf(&sb, "- Cadence: %s (`%s`).\n", idea.CadenceLabel, idea.Cadence)
	}
	fmt.Fprintf(&sb, "- Works through the %s integration, read first; anything that changes it goes through the person.\n", idea.IntegrationName)
	if len(idea.Evidence) > 0 {
		sb.WriteString("\n## Source details\n")
		for _, e := range idea.Evidence {
			fmt.Fprintf(&sb, "- [%s] %s\n", e.ID, e.Text)
		}
	}
	return sb.String()
}

// acceptNotchIdea makes the bot. Returns its slug.
func (b *Broker) acceptNotchIdea(ctx context.Context, id string) (string, error) {
	s := &b.notchIdeas
	s.mu.Lock()
	s.loadLocked(b.notchIdeasPath())
	i, ok := s.findLocked(id)
	if !ok {
		s.mu.Unlock()
		return "", fmt.Errorf("no such idea")
	}
	idea := s.saved.Items[i]
	if _, done := s.saved.Accepted[idea.Fingerprint]; done {
		s.mu.Unlock()
		return "", fmt.Errorf("already made")
	}
	s.mu.Unlock()

	b.officeMemberMutationMu.Lock()
	defer b.officeMemberMutationMu.Unlock()
	b.mu.Lock()
	slug := b.notchIdeaSlugLocked(idea.Name)
	b.mu.Unlock()
	role := idea.Role
	if role == "" {
		role = "Works " + idea.IntegrationName + " for you"
	}
	body := officeMemberMutationBody{
		Action:      "create",
		Slug:        slug,
		Name:        idea.Name,
		Role:        role,
		Personality: "Made from one of the office's daily ideas. Says what it saw, does the smallest real thing, and asks before anything that changes " + idea.IntegrationName + ".",
		CreatedBy:   createdByHumanValue,
		// The face the card showed is the face the bot keeps.
		Avatar: idea.Avatar,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "/office-members", nil)
	if err != nil {
		return "", err
	}
	result, mErr := b.createOfficeMember(req, slug, body)
	if mErr != nil {
		return "", fmt.Errorf("%s", mErr.message)
	}
	if err := b.writeBrokerState(result.write); err != nil {
		return "", fmt.Errorf("persist: %w", err)
	}
	b.publishOfficeChanges(result.events)
	if _, err := b.EnsureDirectChannel(slug); err != nil {
		return "", fmt.Errorf("open DM: %w", err)
	}
	// The OPERATIONS file first, so the roster seed leaves it alone.
	if worker := b.WikiWorker(); worker != nil {
		member := officeMember{Slug: slug, Name: idea.Name, Role: role}
		wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if _, _, err := worker.BotFileWrite(wctx, slug, botFileRel(slug, "OPERATIONS"), renderIdeaOperations(member, idea), "create", "bot: made from a daily idea"); err != nil {
			log.Printf("notch ideas: operations file for %s: %v", slug, err)
		}
		cancel()
	}
	b.backfillBotFilesForRoster()
	dm := channel.DirectSlug("human", slug)
	if idea.Cadence != "" {
		b.addIdeaRoutine(idea, slug, dm)
	}
	// Off it goes, the same way a due routine sends it.
	if _, _, err := b.PostAutomationMessage("routine", dm, idea.Name, idea.FirstTask, "idea:"+idea.Fingerprint, "notch-ideas", "Daily ideas", []string{slug}, ""); err != nil {
		log.Printf("notch ideas: first task for %s: %v", slug, err)
	}
	s.mu.Lock()
	s.saved.Accepted[idea.Fingerprint] = time.Now().UTC().Format(time.RFC3339)
	err = s.saveLocked(b.notchIdeasPath())
	s.mu.Unlock()
	return slug, err
}

// addIdeaRoutine registers the idea's cadence as the bot's routine.
func (b *Broker) addIdeaRoutine(idea notchIdea, slug, dm string) {
	sched, err := calendar.ParseCron(idea.Cadence)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	nextRun := sched.Next(now).Format(time.RFC3339)
	label := idea.Name + " run"
	base := deriveSchedulerSlugFromLabel(label)
	if base == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	taken := func(s string) bool {
		if s == "routines" || s == "system-specs" {
			return true
		}
		for i := range b.scheduler {
			if b.scheduler[i].Slug == s {
				return true
			}
		}
		return false
	}
	unique := base
	for n := 2; taken(unique); n++ {
		unique = fmt.Sprintf("%s-%d", base, n)
	}
	job := schedulerJob{
		Slug:         unique,
		Kind:         "agent_routine",
		Label:        label,
		TargetType:   "agent",
		TargetID:     slug,
		Channel:      dm,
		ScheduleExpr: idea.Cadence,
		Payload:      idea.Promise,
		NextRun:      nextRun,
		DueAt:        nextRun,
		Status:       "scheduled",
		Enabled:      true,
	}
	b.scheduler = append(b.scheduler, job)
	rev := snapshotSchedulerRevision(job)
	rev.ChangeNote = "Made with the bot, from a daily idea"
	rev.Author = createdByHumanValue
	saved := b.recordSchedulerRevisionLocked(unique, rev)
	b.recordSchedulerActivityLocked(unique, schedulerActivity{
		Kind:    "created",
		Actor:   createdByHumanValue,
		Summary: "Routine created with the new bot",
		Detail:  fmt.Sprintf("Initial revision v%d", saved.Version),
	})
	if err := b.saveLocked(); err != nil {
		log.Printf("notch ideas: routine for %s: %v", slug, err)
	}
}

// handleNotchIdeaAccept is POST /notch/ideas/accept {id}. Owner only.
func (b *Broker) handleNotchIdeaAccept(w http.ResponseWriter, r *http.Request) {
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
	slug, err := b.acceptNotchIdea(r.Context(), strings.TrimSpace(req.ID))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "persist") || strings.Contains(err.Error(), "DM") {
			status = http.StatusInternalServerError
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "slug": slug})
}
