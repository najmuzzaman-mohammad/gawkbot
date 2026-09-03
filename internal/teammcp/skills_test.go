package teammcp

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
)

// TestBotSkillCreationToolsNotRegistered pins core-loop R5: bots have
// no tool to create or propose skills (team_skill_create) and no tool to
// request enablement (request_skill_enable). Skills come only from playbook
// compilation; team_skill_run remains for invoking compiled skills.
func TestBotSkillCreationToolsNotRegistered(t *testing.T) {
	for _, tc := range []struct {
		name     string
		channel  string
		oneOnOne bool
		wantRun  bool
	}{
		{name: "office", channel: "general", wantRun: true},
		{name: "dm", channel: "dm-workflow-architect", wantRun: true},
		// One-on-one sessions have no office mechanics; team_skill_run is
		// deliberately not registered there.
		{name: "one-on-one", channel: "dm-workflow-architect", oneOnOne: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			names := listRegisteredTools(t, tc.channel, tc.oneOnOne)
			if slices.Contains(names, "team_skill_create") {
				t.Fatalf("team_skill_create must NOT be registered in %s mode (skills come only from playbook compilation); tools=%v", tc.name, names)
			}
			if slices.Contains(names, "request_skill_enable") {
				t.Fatalf("request_skill_enable must NOT be registered in %s mode; tools=%v", tc.name, names)
			}
			if tc.wantRun && !slices.Contains(names, "team_skill_run") {
				t.Fatalf("expected team_skill_run in %s mode; tools=%v", tc.name, names)
			}
		})
	}
}

// TestHandleTeamSkillRunBumpsUsageAndLogsInvocation verifies that when an
// bot calls team_skill_run through the MCP, the broker bumps the skill's
// UsageCount and a skill_invocation message lands in the channel attributed
// to the calling bot (not "you").
func TestHandleTeamSkillRunBumpsUsageAndLogsInvocation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()

	t.Setenv("WUPHF_TEAM_BROKER_URL", "http://"+b.Addr())
	t.Setenv("WUPHF_BROKER_TOKEN", b.Token())

	// Seed a skill the bot can invoke.
	b.SeedDefaultSkills([]bot.PackSkillSpec{{
		Name:        "investigate",
		Title:       "Investigate a Bug",
		Description: "Systematic debugging with root cause analysis.",
		Trigger:     "When a bug or error is reported",
		Tags:        []string{"engineering", "debugging"},
		Content:     "Step 1: Reproduce. Step 2: Isolate. Step 3: Root cause. Step 4: Fix.",
	}})

	// Bot calls team_skill_run.
	res, _, err := handleTeamSkillRun(context.Background(), nil, TeamSkillRunArgs{
		SkillName: "investigate",
		MySlug:    "eng",
		Channel:   "general",
	})
	if err != nil {
		t.Fatalf("skill run: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("expected successful tool result, got %+v", res)
	}

	// Fetch skills via broker HTTP and confirm UsageCount bumped to 1.
	req, _ := http.NewRequest(http.MethodGet, "http://"+b.Addr()+"/skills?channel=general", nil)
	req.Header.Set("Authorization", "Bearer "+b.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get skills: %v", err)
	}
	defer resp.Body.Close()
	var result struct {
		Skills []struct {
			Name       string `json:"name"`
			UsageCount int    `json:"usage_count"`
		} `json:"skills"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode skills: %v", err)
	}
	// The two ever-present system skills ride along; find the invoked one.
	invokedIdx := -1
	for i, sk := range result.Skills {
		if sk.Name == "investigate" {
			invokedIdx = i
			break
		}
	}
	if invokedIdx == -1 {
		t.Fatalf("expected the invoked skill in the listing, got %+v", result.Skills)
	}
	if got := result.Skills[invokedIdx].UsageCount; got != 1 {
		t.Fatalf("expected usage_count=1 after one invocation, got %d", got)
	}

	// Confirm a skill_invocation message was appended, attributed to the
	// calling bot slug (not "you"), in the requested channel.
	var sawInvocation bool
	for _, msg := range b.Messages() {
		if msg.Kind != "skill_invocation" {
			continue
		}
		if msg.From != "eng" {
			t.Fatalf("expected invocation attributed to eng, got From=%q", msg.From)
		}
		if msg.Channel != "general" {
			t.Fatalf("expected invocation in channel=general, got %q", msg.Channel)
		}
		sawInvocation = true
	}
	if !sawInvocation {
		t.Fatalf("expected a skill_invocation message in broker; messages=%+v", b.Messages())
	}

	// Second invocation should bump UsageCount to 2, proving the tool is
	// re-entrant and not a no-op on repeat calls.
	if _, _, err := handleTeamSkillRun(context.Background(), nil, TeamSkillRunArgs{
		SkillName: "investigate",
		MySlug:    "eng",
		Channel:   "general",
	}); err != nil {
		t.Fatalf("second skill run: %v", err)
	}

	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get skills (2nd): %v", err)
	}
	defer resp2.Body.Close()
	var result2 struct {
		Skills []struct {
			Name       string `json:"name"`
			UsageCount int    `json:"usage_count"`
		} `json:"skills"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&result2); err != nil {
		t.Fatalf("decode skills (2nd): %v", err)
	}
	invoked2 := -1
	for i, sk := range result2.Skills {
		if sk.Name == "investigate" {
			invoked2 = i
			break
		}
	}
	if invoked2 == -1 {
		t.Fatalf("invoked skill missing from second listing: %+v", result2.Skills)
	}
	if got := result2.Skills[invoked2].UsageCount; got != 2 {
		t.Fatalf("expected usage_count=2 after two invocations, got %d", got)
	}
}

// TestHandleTeamSkillRunMissingSkillReturnsToolError verifies that calling
// team_skill_run with a skill that doesn't exist returns a tool-level error
// (so the bot sees the failure) rather than panicking.
func TestHandleTeamSkillRunMissingSkillReturnsToolError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	b := newTestBroker(t)
	if err := b.StartOnPort(0); err != nil {
		t.Fatalf("start broker: %v", err)
	}
	defer b.Stop()

	t.Setenv("WUPHF_TEAM_BROKER_URL", "http://"+b.Addr())
	t.Setenv("WUPHF_BROKER_TOKEN", b.Token())

	res, _, err := handleTeamSkillRun(context.Background(), nil, TeamSkillRunArgs{
		SkillName: "nonexistent-skill",
		MySlug:    "eng",
		Channel:   "general",
	})
	if err != nil {
		t.Fatalf("unexpected go error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("expected IsError=true for missing skill, got %+v", res)
	}
}
