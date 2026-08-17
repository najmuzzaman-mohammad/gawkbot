package team

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/calendar"
)

// Starter routine for a first build — SERVER-side.
//
// The described workflow IS the recurring job, so a brand-new operator-built
// agent gets one standing routine minted from its build description. This
// used to live in the builder chat's completion effect (FE), which only fired
// while that chat stayed mounted: the 2026-08-16 fresh-workspace QA pass lost
// the starter routine because the operator navigated away (and the broker
// restarted) before the build landed. Registration is the durable completion
// signal, so the mint belongs here.

// starterScheduleRule maps described-cadence phrasing to a cron expr and the
// label prefix the Routines tab shows. First match wins; the FE's old
// hardcoded Monday-9:00 stays as the default.
var starterScheduleRules = []struct {
	re     *regexp.Regexp
	expr   string
	prefix string
}{
	{regexp.MustCompile(`(?i)\bevery\s+(week\s?day|business day|work\s?day)|weekday (morning|afternoon)s?\b`), "0 9 * * 1-5", "Weekday"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+(day|morning|evening|night)\b|\bdaily\b`), "0 9 * * *", "Daily"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+hour\b|\bhourly\b`), "0 * * * *", "Hourly"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+monday\b`), "0 9 * * 1", "Weekly"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+tuesday\b`), "0 9 * * 2", "Weekly"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+wednesday\b`), "0 9 * * 3", "Weekly"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+thursday\b`), "0 9 * * 4", "Weekly"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+friday\b`), "0 9 * * 5", "Weekly"},
	{regexp.MustCompile(`(?i)\b(every|each)\s+week\b|\bweekly\b`), "0 9 * * 1", "Weekly"},
}

// starterRoutineCounterRe strips a trailing dedupe counter from an app name.
var starterRoutineCounterRe = regexp.MustCompile(`\s+\d+$`)

// deriveStarterSchedule reads the operator's own cadence out of the build
// description. Returns the cron expr and a human label prefix.
func deriveStarterSchedule(description string) (expr, prefix string) {
	for _, r := range starterScheduleRules {
		if r.re.MatchString(description) {
			return r.expr, r.prefix
		}
	}
	return "0 9 * * 1", "Weekly"
}

// buildDescriptionForApp recovers the operator's original workflow text from
// the app's build task ("Build a new internal tool named …\n\nWhat it should
// do:\n<text>"). Falls back to the raw details, then the app summary.
func (b *Broker) buildDescriptionForApp(app CustomApp) string {
	taskID := strings.TrimPrefix(strings.TrimSpace(app.EditChannel), "task-")
	if taskID == "" || taskID == app.EditChannel {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.tasks {
		if !strings.EqualFold(b.tasks[i].ID, taskID) {
			continue
		}
		details := b.tasks[i].Details
		if idx := strings.Index(details, "What it should do:"); idx >= 0 {
			details = details[idx+len("What it should do:"):]
		}
		return strings.TrimSpace(details)
	}
	return ""
}

// publishOddity returns a human-readable description of what looks wrong with
// a freshly published app page, or "" when nothing stands out. Deterministic
// on purpose: no model call, no false authority — just the two failure shapes
// the quality audits actually observed (scaffold placeholder shipped as the
// final app; a bundle too small to hold the refine+Mantine stack).
func publishOddity(html string) string {
	switch {
	case strings.Contains(html, "Building your agent…"):
		return "the published page still shows the scaffold placeholder — the build may not have replaced the starter screen"
	case len(html) < 20_000:
		return "the published bundle is unusually small — the page may be missing its real interface"
	}
	return ""
}

// advisePublishOddities is the deterministic "look at your own output once"
// check (2026-08-17 quality audit: every area's worst defect traced to the
// system never inspecting what it produced; the old LLM acceptance gate was
// removed for wedging tasks — this one is advisory, cheap, and never blocks
// or reopens anything). On a suspicious publish it posts ONE honest line to
// the app's edit channel.
func (b *Broker) advisePublishOddities(app CustomApp) {
	fresh, html, err := b.appStore().Get(app.ID)
	if err != nil {
		return
	}
	app = fresh
	oddity := publishOddity(html)
	if oddity == "" || strings.TrimSpace(app.EditChannel) == "" {
		return
	}
	msg := fmt.Sprintf("Heads up on %q: %s. Open the agent to check, and tell me what to fix here if it looks wrong.", app.Name, oddity)
	if _, err := b.PostMessage(appBuilderSlug, app.EditChannel, msg, nil, ""); err != nil {
		log.Printf("publish-advisory: %s: %v", app.ID, err)
	}
}

// mintOperatorPlaybookForFirstBuild captures the operator's described
// workflow into the company brain at first registration — VERBATIM, with
// provenance. Onboarding promises "write the rules once and every agent
// reads them", but until now nothing ever wrote the operator's rules INTO
// the brain: the description (thresholds, tiers, cadences) lived only
// inside the built app (2026-08-17 quality audit — the wiki held agent
// SOULs and app self-guides, never the operator's own policy).
func (b *Broker) mintOperatorPlaybookForFirstBuild(app CustomApp, description string) {
	worker := b.WikiWorker()
	if worker == nil || strings.TrimSpace(description) == "" {
		return
	}
	slug := strings.TrimSpace(app.Slug)
	if slug == "" {
		slug = strings.TrimSpace(app.ID)
	}
	path := "team/playbooks/" + slug + ".md"
	if !wikiArticleIsNew(worker.Repo(), path) {
		return
	}
	quoted := "> " + strings.ReplaceAll(strings.TrimSpace(description), "\n", "\n> ")
	content := fmt.Sprintf(
		"# %s — the operator's workflow\n\nCaptured verbatim from the build request. This is the rule %s runs on; edit it here as your process evolves — agents read this page as first-class context.\n\n%s\n",
		app.Name, app.Name, quoted,
	)
	if _, _, err := worker.Enqueue(context.Background(), appBuilderSlug, path, content, "create", "Capture the operator's described workflow at first build"); err != nil {
		log.Printf("playbook-mint: %s: %v", app.ID, err)
	}
}

// mintStarterRoutineForFirstBuild creates the standing routine for a
// human-initiated FIRST build (version 1). No-ops for refines, agent-created
// apps, apps whose agent already has a routine, or descriptions we cannot
// recover. Runs off the registration request path; failures log and stop —
// a missing starter routine must never fail a publish.
func (b *Broker) mintStarterRoutineForFirstBuild(app CustomApp) {
	if app.Version != 1 || !strings.EqualFold(strings.TrimSpace(app.CreatedBy), "human") {
		return
	}
	description := b.buildDescriptionForApp(app)
	if description == "" {
		return
	}
	b.mintOperatorPlaybookForFirstBuild(app, description)
	expr, prefix := deriveStarterSchedule(description)
	sched, err := calendar.ParseCron(expr)
	if err != nil {
		log.Printf("starter-routine: bad derived schedule %q: %v", expr, err)
		return
	}
	now := time.Now().UTC()
	nextRun := sched.Next(now).Format(time.RFC3339)

	// "Pipeline Agent 2" -> "Pipeline": the dedupe counter and the Agent
	// suffix are roster bookkeeping, not routine vocabulary.
	base := strings.TrimSpace(app.Name)
	base = strings.TrimSpace(starterRoutineCounterRe.ReplaceAllString(base, ""))
	base = strings.TrimSpace(strings.TrimSuffix(base, "Agent"))
	if base == "" {
		base = app.Name
	}
	label := fmt.Sprintf("%s %s run", prefix, base)
	slug := deriveSchedulerSlugFromLabel(label)
	if slug == "" {
		return
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	// The agent already has a routine (a demo capture, a re-register, an
	// operator-made one): never stack a second.
	for i := range b.scheduler {
		if b.scheduler[i].Kind == "agent_routine" &&
			b.scheduler[i].TargetType == "agent" &&
			b.scheduler[i].TargetID == app.ID {
			return
		}
	}
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
	unique := slug
	for n := 2; taken(unique); n++ {
		unique = fmt.Sprintf("%s-%d", slug, n)
	}
	job := schedulerJob{
		Slug:         unique,
		Kind:         "agent_routine",
		Label:        label,
		TargetType:   "agent",
		TargetID:     app.ID,
		ScheduleExpr: expr,
		Payload:      description,
		NextRun:      nextRun,
		DueAt:        nextRun,
		Status:       "scheduled",
		Enabled:      true,
	}
	b.scheduler = append(b.scheduler, job)
	rev := snapshotSchedulerRevision(job)
	rev.ChangeNote = "Starter routine minted from the build description"
	rev.Author = appBuilderSlug
	saved := b.recordSchedulerRevisionLocked(unique, rev)
	b.recordSchedulerActivityLocked(unique, schedulerActivity{
		Kind:    "created",
		Actor:   appBuilderSlug,
		Summary: "Starter routine created with the new agent",
		Detail:  fmt.Sprintf("Initial revision v%d", saved.Version),
	})
	if err := b.saveLocked(); err != nil {
		for i := len(b.scheduler) - 1; i >= 0; i-- {
			if b.scheduler[i].Slug == unique {
				b.scheduler = append(b.scheduler[:i], b.scheduler[i+1:]...)
				break
			}
		}
		log.Printf("starter-routine: persist failed for %s: %v", app.ID, err)
	}
}
