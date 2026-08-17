package team

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeriveStarterScheduleReadsDescribedCadence(t *testing.T) {
	cases := []struct {
		text   string
		expr   string
		prefix string
	}{
		{"Chase our unpaid invoices. Every weekday morning, find invoices past due.", "0 9 * * 1-5", "Weekday"},
		{"Each morning, summarize yesterday's tickets.", "0 9 * * *", "Daily"},
		{"Post a digest every Friday.", "0 9 * * 5", "Weekly"},
		{"Check the queue hourly and page me.", "0 * * * *", "Hourly"},
		{"Screen inbound applicants and keep a shortlist.", "0 9 * * 1", "Weekly"},
	}
	for _, c := range cases {
		expr, prefix := deriveStarterSchedule(c.text)
		if expr != c.expr || prefix != c.prefix {
			t.Errorf("deriveStarterSchedule(%q) = %q/%q, want %q/%q", c.text, expr, prefix, c.expr, c.prefix)
		}
	}
}

// 2026-08-16 fresh-workspace QA regression: the starter routine used to be
// minted by the builder chat (FE) and was lost whenever that chat unmounted
// before the build landed. Registration is the durable signal — the broker
// mints it now.
func TestMintStarterRoutineForFirstBuild(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	b := newTestBroker(t)

	b.mu.Lock()
	b.tasks = append(b.tasks, teamTask{
		ID:      "VANCE-2",
		Channel: "task-VANCE-2",
		Title:   "Build app: Chase Agent",
		Details: "Build a new internal tool named \"Chase Agent\".\n\nWhat it should do:\nChase our unpaid invoices. Every weekday morning, find invoices past their due date and draft reminders.",
		Owner:   appBuilderSlug,
	})
	b.mu.Unlock()

	app := CustomApp{
		ID:          "app_1234567890abcdef",
		Name:        "Chase Agent",
		Version:     1,
		CreatedBy:   "human",
		EditChannel: "task-VANCE-2",
	}
	b.mintStarterRoutineForFirstBuild(app)

	b.mu.Lock()
	defer b.mu.Unlock()
	var minted *schedulerJob
	for i := range b.scheduler {
		if b.scheduler[i].TargetID == app.ID && b.scheduler[i].Kind == "agent_routine" {
			minted = &b.scheduler[i]
			break
		}
	}
	if minted == nil {
		t.Fatalf("expected a starter routine for %s, scheduler=%+v", app.ID, b.scheduler)
	}
	if minted.ScheduleExpr != "0 9 * * 1-5" {
		t.Errorf("expected the described weekday cadence, got %q", minted.ScheduleExpr)
	}
	if !strings.Contains(minted.Payload, "unpaid invoices") {
		t.Errorf("expected the operator's description as the prompt, got %q", minted.Payload)
	}
	if !strings.HasPrefix(minted.Label, "Weekday Chase") {
		t.Errorf("expected a cadence-labeled name, got %q", minted.Label)
	}
	if minted.NextRun == "" || minted.DueAt == "" {
		t.Errorf("expected armed next-run stamps, got %+v", minted)
	}
	if _, err := time.Parse(time.RFC3339, minted.NextRun); err != nil {
		t.Errorf("next run is not RFC3339: %v", err)
	}

	// The label strips the dedupe counter: "Chase Agent 2" -> "Weekday Chase
	// run". NOTE the lock discipline: b.mu is HELD here (taken above with a
	// deferred unlock), so the task append rides the held lock, the mint runs
	// unlocked, and the read re-takes the lock to stay balanced with the
	// idempotency section below.
	b.tasks = append(b.tasks, teamTask{
		ID:      "VANCE-9",
		Channel: "task-VANCE-9",
		Title:   "Build app: Chase Agent 2",
		Details: "What it should do:\nChase invoices. Every weekday morning, remind people.",
		Owner:   appBuilderSlug,
	})
	b.mu.Unlock()
	numbered := CustomApp{
		ID:          "app_00000000000000aa",
		Name:        "Chase Agent 2",
		Version:     1,
		CreatedBy:   "human",
		EditChannel: "task-VANCE-9",
	}
	b.mintStarterRoutineForFirstBuild(numbered)
	b.mu.Lock()
	var labeled string
	for i := range b.scheduler {
		if b.scheduler[i].TargetID == numbered.ID {
			labeled = b.scheduler[i].Label
		}
	}
	if labeled != "Weekday Chase run" {
		t.Errorf("expected the counter stripped from the label, got %q", labeled)
	}

	// Idempotent: a republish (version 2) and a re-mint both no-op.
	before := len(b.scheduler)
	b.mu.Unlock()
	b.mintStarterRoutineForFirstBuild(app)
	app2 := app
	app2.Version = 2
	b.mintStarterRoutineForFirstBuild(app2)
	agentApp := app
	agentApp.ID = "app_fedcba0987654321"
	agentApp.CreatedBy = appBuilderSlug
	b.mintStarterRoutineForFirstBuild(agentApp)
	b.mu.Lock()
	if len(b.scheduler) != before {
		t.Errorf("expected no additional routines, got %d -> %d", before, len(b.scheduler))
	}
}

// 2026-08-16 VP-RevOps QA regression: a second build whose derived name
// matches a PUBLISHED agent must get a fresh app id — the old identity
// (name, "general") briefed the new build to republish over the live agent.
func TestPrescaffoldNeverReusesAPublishedAgentsID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	b := newTestBroker(t)

	first := b.maybePrescaffoldAppForCreate("create", "general", TaskPostRequest{
		Title:     "Build app: Pipeline Agent",
		Owner:     appBuilderSlug,
		CreatedBy: "human",
		Details:   "What it should do:\nMonday brief.",
	})
	firstID, _ := parseAppBuilderTaskAppID(first.Details)
	if firstID == "" {
		t.Fatalf("expected a scaffolded app id in the first brief, got %q", first.Details)
	}

	// Publish the first app (register flips it ready).
	if _, err := b.appStore().Save(CustomAppWriteRequest{
		ID:    firstID,
		Name:  "Pipeline Agent",
		HTML:  "<html><body>brief</body></html>",
		Actor: appBuilderSlug,
	}, time.Now()); err != nil {
		t.Fatalf("publish first app: %v", err)
	}

	second := b.maybePrescaffoldAppForCreate("create", "general", TaskPostRequest{
		Title:     "Build app: Pipeline Agent",
		Owner:     appBuilderSlug,
		CreatedBy: "human",
		Details:   "What it should do:\nDiscount approvals.",
	})
	secondID, _ := parseAppBuilderTaskAppID(second.Details)
	if secondID == "" {
		t.Fatalf("expected a scaffolded app id in the second brief, got %q", second.Details)
	}
	if secondID == firstID {
		t.Fatalf("second build was handed the PUBLISHED agent's id %s — republish hijack", firstID)
	}

	// A retry of an UNPUBLISHED build keeps continuing its own scaffold.
	third := b.maybePrescaffoldAppForCreate("create", "general", TaskPostRequest{
		Title:     "Build app: Pipeline Agent",
		Owner:     appBuilderSlug,
		CreatedBy: "human",
		Details:   "What it should do:\nAnother take.",
	})
	if got, _ := parseAppBuilderTaskAppID(third.Details); got != secondID {
		t.Fatalf("expected the building leftover %s to be resumed, got %s", secondID, got)
	}
}

// 2026-08-17 quality audit: the company brain never held the operator's own
// rules — the described workflow lived only inside the built app. First
// registration now captures it verbatim as a playbook page.
func TestMintOperatorPlaybookForFirstBuild(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), "wiki")
	backup := filepath.Join(t.TempDir(), "wiki.bak")
	repo := NewRepoAt(root, backup)
	if err := repo.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	b := newTestBroker(t)
	worker := NewWikiWorker(repo, b)
	ctx, cancel := context.WithCancel(context.Background())
	worker.Start(ctx)
	// Stop (not just cancel) so the worker's async side goroutines — e.g. the
	// playbook auto-recompile — finish before TempDir cleanup, which otherwise
	// races their git writes and fails with "directory not empty".
	t.Cleanup(func() {
		worker.Stop()
		cancel()
	})
	b.mu.Lock()
	b.wikiWorker = worker
	b.mu.Unlock()

	app := CustomApp{
		ID:   "app_00000000000000bb",
		Slug: "deal-desk",
		Name: "Deal Desk",
	}
	desc := "Run our deal desk. Up to 10% any rep can give, 10-20% needs my sign-off under 50k ARR, over 20% or multi-year escalates to the CFO."
	b.mintOperatorPlaybookForFirstBuild(app, desc)

	path := filepath.Join(root, "team", "playbooks", "deal-desk.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("expected the playbook page at %s: %v", path, err)
	}
	content := string(data)
	if !strings.Contains(content, "the operator's workflow") ||
		!strings.Contains(content, "escalates to the CFO") {
		t.Fatalf("playbook page missing the verbatim rules, got:\n%s", content)
	}

	// Never overwrite an existing page the operator may have edited.
	b.mintOperatorPlaybookForFirstBuild(app, "totally different text")
	data2, _ := os.ReadFile(path)
	if !strings.Contains(string(data2), "escalates to the CFO") {
		t.Fatalf("re-mint overwrote the operator's page")
	}
}

func TestPublishOddity(t *testing.T) {
	big := strings.Repeat("<div>real interface</div>", 2000)
	if got := publishOddity(big); got != "" {
		t.Fatalf("healthy publish flagged: %q", got)
	}
	if got := publishOddity("Building your agent…" + big); !strings.Contains(got, "placeholder") {
		t.Fatalf("placeholder publish not flagged: %q", got)
	}
	if got := publishOddity("<html>tiny</html>"); !strings.Contains(got, "unusually small") {
		t.Fatalf("tiny publish not flagged: %q", got)
	}
}
