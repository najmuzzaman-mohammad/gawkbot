package orchestration

import (
	"testing"
	"time"
)

func TestMessageRouter_ExtractSkills(t *testing.T) {
	mr := NewMessageRouter()

	tests := []struct {
		msg     string
		wantAny []string
	}{
		{"Build a workflow automation blueprint for customer onboarding", []string{"workflow automation", "customer onboarding"}},
		{"Create a go-to-market handoff for the new offer", []string{"go market", "market handoff"}},
		{"Draft an account reconciliation and billing operations plan", []string{"account reconciliation", "billing operations"}},
		{"Hello", nil},
	}

	for _, tt := range tests {
		skills := mr.ExtractSkills(tt.msg)
		if len(tt.wantAny) == 0 {
			if len(skills) != 0 {
				t.Errorf("msg %q: expected no skills, got %v", tt.msg, skills)
			}
			continue
		}
		found := false
		for _, want := range tt.wantAny {
			for _, got := range skills {
				if got == want {
					found = true
				}
			}
		}
		if !found {
			t.Errorf("msg %q: expected one of %v in skills %v", tt.msg, tt.wantAny, skills)
		}
	}
}

func TestRoutingTermsAndScoreMessageAgainstTermsMatchBotScoring(t *testing.T) {
	message := "Need a go to market customer handoff and billing operations plan."
	expertise := []string{"customer success", "invoicing"}
	roleTerms := []string{"customer handoff", "billing operations"}

	got := ScoreMessageAgainstTerms(message, RoutingTerms("ops-planner", expertise, roleTerms, nil))
	want := ScoreMessageAgainstBot(message, "ops-planner", expertise, roleTerms)
	if got != want {
		t.Fatalf("expected shared term scoring %v to equal bot scoring %v", got, want)
	}
}

func TestRoutingTermsNormalizeExtraTerms(t *testing.T) {
	terms := RoutingTerms("bookkeeper", nil, nil, []string{"Billing Operations", "Accounts Receivable"})
	want := map[string]bool{
		"bookkeeper":          false,
		"billing operations":  false,
		"accounts receivable": false,
	}
	for _, term := range terms {
		if _, ok := want[term]; ok {
			want[term] = true
		}
	}
	for term, seen := range want {
		if !seen {
			t.Fatalf("expected term %q in %v", term, terms)
		}
	}
}

func TestNewDirectiveGoesToTeamLead(t *testing.T) {
	mr := NewMessageRouter()
	mr.SetTeamLeadSlug("ceo")
	bots := []BotInfo{
		{Slug: "ceo", Expertise: []string{"strategy"}},
		{Slug: "researcher", Expertise: []string{"market-research", "competitive-analysis"}},
		{Slug: "coder", Expertise: []string{"general", "planning"}},
	}

	// Even when a specialist matches, new directives should go to team-lead.
	result := mr.Route("Can you research our market?", bots)
	if result.Primary != "ceo" {
		t.Errorf("expected primary='ceo' (team-lead), got '%s'", result.Primary)
	}
	if result.IsFollowUp {
		t.Error("should not be a follow-up")
	}
	if !result.TeamLeadAware {
		t.Error("team-lead should be aware")
	}
}

func TestRouteSuggestsCollaboratorsForProductLaunchWork(t *testing.T) {
	mr := NewMessageRouter()
	mr.SetTeamLeadSlug("ceo")
	bots := []BotInfo{
		{Slug: "ceo", Expertise: []string{"strategy", "delegation"}},
		{Slug: "growth-ops", Expertise: []string{"pipeline optimization", "customer onboarding"}, RoleTerms: []string{"go-to-market", "growth operations"}},
		{Slug: "automation-builder", Expertise: []string{"workflow automation", "integrations"}, RoleTerms: []string{"automation", "workflow orchestration"}},
		{Slug: "bookkeeper", Expertise: []string{"invoicing", "billing"}, RoleTerms: []string{"accounts receivable", "reconciliation"}},
	}

	result := mr.Route("Set up a go to market workflow that automates customer onboarding and workflow orchestration.", bots)
	if result.Primary != "ceo" {
		t.Fatalf("expected primary='ceo', got %q", result.Primary)
	}
	want := map[string]bool{"growth-ops": false, "automation-builder": false}
	for _, slug := range result.Collaborators {
		if _, ok := want[slug]; ok {
			want[slug] = true
		}
	}
	for slug, found := range want {
		if !found {
			t.Fatalf("expected collaborator %q in %v", slug, result.Collaborators)
		}
	}
}

func TestRouteUsesRoleTermsAndExpertiseMetadata(t *testing.T) {
	mr := NewMessageRouter()
	mr.SetTeamLeadSlug("ceo")
	bots := []BotInfo{
		{Slug: "ceo", Expertise: []string{"strategy", "delegation"}},
		{Slug: "ops-planner", Expertise: []string{"customer success", "invoicing"}, RoleTerms: []string{"customer handoff", "billing operations"}},
		{Slug: "rev-ops", Expertise: []string{"pipeline management"}, RoleTerms: []string{"go-to-market", "lead routing"}},
		{Slug: "support", Expertise: []string{"ticket triage"}, RoleTerms: []string{"customer support"}},
	}

	result := mr.Route("Need a go to market customer handoff and billing operations plan.", bots)
	if result.Primary != "ceo" {
		t.Fatalf("expected primary='ceo', got %q", result.Primary)
	}
	if len(result.Collaborators) == 0 {
		t.Fatal("expected collaborators from role/expertise metadata")
	}
	want := map[string]bool{"ops-planner": false, "rev-ops": false}
	for _, slug := range result.Collaborators {
		if _, ok := want[slug]; ok {
			want[slug] = true
		}
	}
	for slug, found := range want {
		if !found {
			t.Fatalf("expected collaborator %q in %v", slug, result.Collaborators)
		}
	}
}

func TestFollowUpGoesToLastActive(t *testing.T) {
	mr := NewMessageRouter()
	mr.SetTeamLeadSlug("ceo")
	mr.mu.Lock()
	mr.recentThreads["fe"] = &threadContext{
		botSlug:      "fe",
		lastActivity: time.Now(),
	}
	mr.mu.Unlock()

	bots := []BotInfo{
		{Slug: "ceo", Expertise: []string{"strategy"}},
		{Slug: "fe", Expertise: []string{"frontend"}},
	}
	result := mr.Route("Also add a dark mode toggle", bots)
	if !result.IsFollowUp {
		t.Error("should be detected as follow-up")
	}
	if result.Primary != "fe" {
		t.Errorf("expected primary='fe' (last active), got '%s'", result.Primary)
	}
}

func TestExplicitMentionRoutes(t *testing.T) {
	mr := NewMessageRouter()
	mr.SetTeamLeadSlug("ceo")
	bots := []BotInfo{
		{Slug: "ceo", Expertise: []string{"strategy"}},
		{Slug: "fe", Expertise: []string{"frontend"}},
		{Slug: "be", Expertise: []string{"backend"}},
	}

	result := mr.Route("@fe build the login page", bots)
	if result.Primary != "fe" {
		t.Errorf("expected primary='fe' (explicit @mention), got '%s'", result.Primary)
	}
	if result.IsFollowUp {
		t.Error("should not be a follow-up")
	}
}

func TestMessageRouter_RoutesToTeamLeadWhenNoSkills(t *testing.T) {
	mr := NewMessageRouter()
	result := mr.Route("Hello there", []BotInfo{
		{Slug: "researcher", Expertise: []string{"market-research"}},
	})
	if result.Primary != "team-lead" {
		t.Errorf("expected team-lead, got %s", result.Primary)
	}
}

func TestMessageRouter_DetectsFollowUp(t *testing.T) {
	mr := NewMessageRouter()
	mr.mu.Lock()
	mr.recentThreads["researcher"] = &threadContext{
		botSlug:      "researcher",
		lastActivity: time.Now(),
	}
	mr.mu.Unlock()

	bots := []BotInfo{
		{Slug: "researcher", Expertise: []string{"market-research"}},
	}
	result := mr.Route("Also what about their pricing?", bots)
	if !result.IsFollowUp {
		t.Error("should be detected as follow-up")
	}
	if result.Primary != "researcher" {
		t.Errorf("expected researcher, got %s", result.Primary)
	}
}

func TestMessageRouter_FollowUpExpires(t *testing.T) {
	mr := NewMessageRouter()
	mr.followUpWindow = 10 * time.Millisecond
	mr.mu.Lock()
	mr.recentThreads["researcher"] = &threadContext{
		botSlug:      "researcher",
		lastActivity: time.Now().Add(-100 * time.Millisecond),
	}
	mr.mu.Unlock()

	result := mr.Route("Also what about their pricing?", []BotInfo{
		{Slug: "team-lead", Expertise: []string{}},
	})
	if result.IsFollowUp {
		t.Error("follow-up window should have expired")
	}
}

func TestRouteUsesConfiguredTeamLead(t *testing.T) {
	router := NewMessageRouter()
	router.SetTeamLeadSlug("ceo")
	router.RegisterBot("ceo", []string{"strategy", "delegation"})
	router.RegisterBot("pm", []string{"roadmap", "requirements"})

	bots := []BotInfo{
		{Slug: "ceo", Expertise: []string{"strategy"}},
		{Slug: "pm", Expertise: []string{"roadmap"}},
	}

	result := router.Route("do something random", bots)
	if result.Primary != "ceo" {
		t.Errorf("expected primary='ceo', got '%s'", result.Primary)
	}
}

func TestMessageRouter_RecordActivity(t *testing.T) {
	mr := NewMessageRouter()
	mr.RecordBotActivity("agent-x")
	mr.mu.Lock()
	tc, ok := mr.recentThreads["agent-x"]
	mr.mu.Unlock()
	if !ok {
		t.Fatal("activity should be recorded")
	}
	if time.Since(tc.lastActivity) > time.Second {
		t.Error("last activity should be recent")
	}
}
