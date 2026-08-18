package team

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
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
		// The task description is the operator's words PLUS machinery appended
		// for the builder (register_app instructions, the workspace brief with
		// filesystem paths). Cut at the first machinery marker so operator-facing
		// pages (the playbook) never quote internal plumbing back at the human.
		for _, marker := range []string{
			"When the build passes, register it with register_app",
			"App workspace ready:",
		} {
			if idx := strings.Index(details, marker); idx >= 0 {
				details = details[:idx]
			}
		}
		return strings.TrimSpace(details)
	}
	return ""
}

// publishOddity translates the deterministic gap list into ONE operator-facing
// heads-up line, or "" when the publish looked healthy. It reuses
// deterministicAppGaps (broker_app_eval.go) — the richer, unit-tested check
// (ready/version grounding, content-hash-vs-bytes integrity, min-bundle, and
// the scaffold-source sentinel) — instead of the two hard-coded shapes it used
// before, so a corrupt or partial publish is caught too.
func (b *Broker) publishOddity(app CustomApp) string {
	gaps := b.deterministicAppGaps(app)
	if len(gaps) == 0 {
		return ""
	}
	// Lead with the first gap (they are ordered non-delivery → integrity →
	// scaffold); a single clear line beats a wall of them in the finish card.
	return gaps[0]
}

// advisePublishOddities is the deterministic "look at your own output once"
// check (2026-08-17 quality audit: every area's worst defect traced to the
// system never inspecting what it produced; the old LLM acceptance gate was
// removed for wedging tasks — this one is advisory, cheap, and never blocks
// or reopens anything). On a suspicious publish it (1) STAMPS the advisory on
// the manifest so the finish card can downgrade its green "ready", and (2)
// posts ONE honest line to the app's edit channel. On a healthy publish it
// clears any stale advisory from a prior build.
func (b *Broker) advisePublishOddities(app CustomApp) {
	fresh, _, err := b.appStore().Get(app.ID)
	if err != nil {
		return
	}
	app = fresh
	oddity := b.publishOddity(app)
	// Stamp (or clear) the manifest first so the finish card is honest even if
	// there is no edit channel to post into.
	if err := b.appStore().SetAdvisory(app.ID, oddity); err != nil {
		log.Printf("publish-advisory: stamp %s: %v", app.ID, err)
	}
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

// livePlaybookPrompt returns the operator's CURRENT workflow rule from
// team/playbooks/<slug>.md, or "" when there is no playbook (or it has no
// recoverable rule). The operator routine fires this instead of the frozen
// build-time snapshot so that editing the playbook — which the page explicitly
// invites ("edit it here as your process evolves; agents read this page as
// first-class context") — actually changes what the agent runs. Before this,
// the playbook was write-only against the runtime: the routine ran a copy of
// the description captured at mint, so the page's promise was a lie (2026-08-17
// wiki audit). Falls back to the frozen payload at the call site on "".
func (b *Broker) livePlaybookPrompt(appID string) string {
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return ""
	}
	worker := b.WikiWorker()
	if worker == nil || worker.Repo() == nil {
		return ""
	}
	app, _, err := b.appStore().Get(appID)
	if err != nil {
		return ""
	}
	slug := strings.TrimSpace(app.Slug)
	if slug == "" {
		slug = appID
	}
	path := filepath.Join(worker.Repo().Root(), "team", "playbooks", slug+".md")
	data, err := os.ReadFile(path) //nolint:gosec // slug is a validated app slug, path is broker-owned
	if err != nil {
		return ""
	}
	return extractPlaybookRule(string(data))
}

// recordOperatorRoutineExecution appends one run of an operator routine to its
// playbook's execution log (team/playbooks/<slug>.executions.jsonl). This closes
// the read -> execute -> record loop the compiled skill advertises: before this,
// the log was ALWAYS empty in the operator flow (ExecutionLog.Append was only
// reachable via the office-only playbook_execution_record tool), so the playbook
// never grew a run history worth reading (2026-08-17 wiki audit). Best-effort:
// a missing app, playbook, or log is a no-op, never a failed fire.
func (b *Broker) recordOperatorRoutineExecution(appID string, outcome PlaybookOutcome, summary string) {
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return
	}
	log := b.PlaybookExecutionLog()
	if log == nil {
		return
	}
	app, _, err := b.appStore().Get(appID)
	if err != nil {
		return
	}
	slug := strings.TrimSpace(app.Slug)
	if slug == "" {
		slug = appID
	}
	// Only record for an app that actually has a playbook — otherwise the log
	// would accrete for apps the operator never described a rule for.
	if b.WikiWorker() == nil || b.WikiWorker().Repo() == nil {
		return
	}
	path := filepath.Join(b.WikiWorker().Repo().Root(), "team", "playbooks", slug+".md")
	if _, statErr := os.Stat(path); statErr != nil {
		return
	}
	summary = strings.TrimSpace(summary)
	if summary == "" {
		summary = "Routine fired."
	}
	if _, err := log.Append(context.Background(), slug, outcome, summary, "", appBuilderSlug); err != nil {
		log2 := err
		_ = log2 // Append already logs; keep the fire clean.
	}
}

// extractPlaybookRule pulls the operator's rule out of a playbook page: the
// blockquote body the page is built around. Editing WITHIN that blockquote (the
// way the page invites) is picked up; a free rewrite that drops the blockquote
// returns "" so the caller keeps the frozen fallback rather than firing a
// heading or preamble as the prompt.
func extractPlaybookRule(md string) string {
	var lines []string
	for _, ln := range strings.Split(md, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, ">") {
			lines = append(lines, strings.TrimSpace(strings.TrimPrefix(t, ">")))
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
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
