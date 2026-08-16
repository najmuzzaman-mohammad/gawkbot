package team

import (
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
