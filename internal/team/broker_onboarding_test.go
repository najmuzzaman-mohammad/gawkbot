package team

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nex-crm/wuphf/internal/onboarding"
	"github.com/nex-crm/wuphf/internal/operations"
)

// locateRepoRoot walks up from the test's cwd looking for the
// templates/operations directory, so LoadBlueprint can find curated
// blueprint YAML on disk. Returns "" if not found — callers fall back to
// setting up an embedded FS.
func locateRepoRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for dir := cwd; dir != "/" && dir != ""; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "templates", "operations")); err == nil {
			return dir
		}
	}
	return ""
}

// ensureOperationsFallbackFS points operations at the repo's
// templates/operations tree if LoadBlueprint("", ...) would otherwise miss
// it (the wuphf root package's init() sets this, but that init does not
// run in team-package tests).
func ensureOperationsFallbackFS(t *testing.T) {
	t.Helper()
	root := locateRepoRoot(t)
	if root == "" {
		t.Skip("templates/operations not reachable from test cwd; skipping")
	}
	sub, err := fs.Sub(os.DirFS(root), ".")
	if err != nil {
		t.Fatalf("sub fs: %v", err)
	}
	operations.SetFallbackFS(sub)
}

// TestOnboardingCompleteSeedsFromPickedBlueprint verifies that when the
// wizard POSTs a curated blueprint id, the broker seeds the exact member
// list from that blueprint's starter.bots — not ceo/planner/executor/
// reviewer from DefaultManifest.
func TestOnboardingCompleteSeedsFromPickedBlueprint(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("Stand up niche CRM", false, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	want := map[string]bool{
		"ceo": true, "planner": true, "builder": true,
		"growth": true, "reviewer": true,
	}
	got := map[string]bool{}
	b.mu.Lock()
	for _, m := range b.members {
		got[m.Slug] = true
	}
	b.mu.Unlock()

	for slug := range want {
		if !got[slug] {
			t.Errorf("expected niche-crm slug %q in roster; got %v", slug, got)
		}
	}
	// DefaultManifest is ceo/planner/executor/reviewer. ceo overlaps with the
	// blueprint's legitimate lead, so executor is the distinguishing leak
	// signal.
	for slug := range got {
		if slug == "executor" {
			t.Errorf("DefaultManifest slug %q leaked into blueprint roster; got %v", slug, got)
		}
	}

	b.mu.Lock()
	var lead string
	for _, m := range b.members {
		if m.BuiltIn {
			lead = m.Slug
			break
		}
	}
	b.mu.Unlock()
	if lead != "ceo" {
		t.Errorf("expected BuiltIn lead to be ceo (blueprint's lead_slug), got %q", lead)
	}
}

func TestOnboardingDraftPhaseCreatesFirstIssueFromTaskPrompt(t *testing.T) {
	t.Setenv("WUPHF_RUNTIME_HOME", t.TempDir())

	b := newTestBroker(t)
	b.mu.Lock()
	ensureTestMemberAccess(b, "team", "ceo", "CEO")
	b.mu.Unlock()

	state := &onboarding.State{
		Version: 2,
		Phase:   onboarding.PhaseBridge,
		PendingSuggestion: &onboarding.Suggestion{
			ID:    "first-issue-prompt",
			Phase: onboarding.PhaseDraft,
			Kind:  "ceo_form_field",
		},
		FormAnswers: onboarding.FormAnswers{
			TaskPrompt: "Build a Stripe webhook handler that verifies signatures.",
		},
	}

	if err := b.advancePhase(state, onboarding.PhaseDraft); err != nil {
		t.Fatalf("advancePhase(draft): %v", err)
	}
	if state.FirstIssueID == "" {
		t.Fatal("expected first issue id to be persisted on onboarding state")
	}

	loaded, err := onboarding.Load()
	if err != nil {
		t.Fatalf("load onboarding state: %v", err)
	}
	if loaded.FirstIssueID != state.FirstIssueID {
		t.Fatalf("loaded first issue id = %q, want %q", loaded.FirstIssueID, state.FirstIssueID)
	}
	if loaded.PendingSuggestion != nil {
		t.Fatalf("expected submitted draft suggestion to be cleared, got %+v", loaded.PendingSuggestion)
	}

	tasks := b.AllTasks()
	if len(tasks) != 1 {
		t.Fatalf("expected one first issue task, got %+v", tasks)
	}
	task := tasks[0]
	// The onboarding ask IS the authorization: the first issue lands
	// running with the CEO as owner — no start-approval ceremony.
	if task.ID != state.FirstIssueID || task.LifecycleState != LifecycleStateRunning {
		t.Fatalf("unexpected first issue task: %+v", task)
	}
	if task.TaskType != "issue" || task.PipelineID != "issue" {
		t.Fatalf("expected first issue to be an issue task, got type=%q pipeline=%q", task.TaskType, task.PipelineID)
	}
	// core-loop R2: the task carries the human's prompt as its description —
	// no CEO draft-writer, no generated spec document.
	if task.Details != state.FormAnswers.TaskPrompt {
		t.Fatalf("expected first issue details to be the task prompt, got %q", task.Details)
	}
}

// TestOnboardingCompleteHonorsBotFilter verifies the wizard's per-bot
// toggle state: bots=[ceo, builder] should seed only those two,
// dropping the blueprint's other specialists.
func TestOnboardingCompleteHonorsBotFilter(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("Stand up niche CRM", false, "niche-crm", []string{"ceo", "builder"}, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	slugs := make([]string, 0, len(b.members))
	for _, m := range b.members {
		slugs = append(slugs, m.Slug)
	}
	b.mu.Unlock()

	hasCEO := false
	hasBuilder := false
	for _, s := range slugs {
		switch s {
		case "ceo":
			hasCEO = true
		case "builder":
			hasBuilder = true
		case "planner", "growth", "reviewer":
			t.Errorf("unselected slug %q leaked into roster; got %v", s, slugs)
		}
	}
	if !hasCEO {
		t.Errorf("expected ceo (selected) in roster; got %v", slugs)
	}
	if !hasBuilder {
		t.Errorf("expected builder (selected) in roster; got %v", slugs)
	}
}

// TestOnboardingCompleteBotsEmptySeedsLeadOnly verifies that an empty bots
// array (user unchecked every toggle) seeds ONLY the blueprint's lead.
//
// Two halves of this changed, in the same direction.
//
// "Lead only" used to mean "lead plus the built-in Librarian and App Builder",
// which made the name a lie: unchecking every bot still produced three. Both
// back-fills are gone with those bots' retirement as defaults, so lead-only
// now means what it says.
//
// The system message this used to require — a notice apologizing for the
// fallback — is gone too, and the assertion is INVERTED rather than dropped. A
// roster of exactly the Chief of Staff is the intended default now, not an
// anomaly: specialists are created on demand. Warning about it on every fresh
// office would tell the user their normal workspace is broken. If that notice
// comes back, this fails.
func TestOnboardingCompleteBotsEmptySeedsLeadOnly(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("Stand up niche CRM", false, "niche-crm", []string{}, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	slugs := make([]string, 0, len(b.members))
	for _, m := range b.members {
		slugs = append(slugs, m.Slug)
	}
	var apology string
	for _, msg := range b.messages {
		if msg.Kind == "system" && strings.Contains(msg.Content, "lead only") {
			apology = msg.Content
			break
		}
	}
	b.mu.Unlock()

	if len(slugs) != 1 || slugs[0] != "ceo" {
		t.Fatalf("expected the lead alone [ceo], got %v", slugs)
	}
	if apology != "" {
		t.Errorf("the lead-only office is the intended default, but onboarding apologized for it: %q", apology)
	}
}

// TestOnboardingCompleteFromScratchSynthesizes verifies that when blueprint
// id is empty, the broker synthesizes a blueprint from the user's goal and
// seeds the resulting team — NOT the DefaultManifest roster.
func TestOnboardingCompleteFromScratchSynthesizes(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("Build an automated customer-support operation", false, "", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	slugs := make([]string, 0, len(b.members))
	for _, m := range b.members {
		slugs = append(slugs, m.Slug)
	}
	b.mu.Unlock()

	// The synthesized team must not be the DefaultManifest roster exactly.
	// Sanity: DefaultManifest is ceo/planner/executor/reviewer. A synthesized
	// team should differ in composition.
	if len(slugs) == 4 && slugs[0] == "ceo" && slugs[1] == "planner" && slugs[2] == "executor" && slugs[3] == "reviewer" {
		t.Errorf("from-scratch produced DefaultManifest roster, not a synthesized team; got %v", slugs)
	}
	if len(slugs) == 0 {
		t.Fatalf("from-scratch produced empty roster")
	}
}

func TestOnboardingCompleteFromScratchHonorsSelectedFoundingBots(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("Build an automated customer-support operation", false, "", []string{"ceo", "founding-engineer"}, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	slugs := make([]string, 0, len(b.members))
	for _, m := range b.members {
		slugs = append(slugs, m.Slug)
	}
	b.mu.Unlock()

	// EXACTLY the selected founding bots. The Librarian and App Builder used
	// to be appended here as "always-present built-ins"; that back-fill is
	// deleted, so a selection is now honoured literally and this fails if
	// anything the user did not pick shows up.
	want := []string{"ceo", "founding-engineer"}
	if len(slugs) != len(want) {
		t.Fatalf("from-scratch selected roster got %v, want %v", slugs, want)
	}
	for i, slug := range want {
		if slugs[i] != slug {
			t.Fatalf("member[%d]: got %q, want %q (all: %v)", i, slugs[i], slug, slugs)
		}
	}
}

// A stale web bundle can post bot slugs from a DIFFERENT synthesized roster.
// None of them match, so the selection filter keeps only the lead — and a
// one-bot office is a worse answer than ignoring a selection the user did not
// knowingly make. blankSlateOfficeMembersFromBlueprint detects that shape and
// falls back to the full current roster.
//
// The fixture is built from a blueprint with CONNECTED INTEGRATIONS rather than
// an empty SynthesisInput. Synthesis used to mint planner/executor/reviewer on
// every blueprint, so an empty input produced a four-bot roster and the
// collapse was visible. Those three are retired, and an empty input now
// synthesizes the lead alone — which means "collapsed to lead-only" and "the
// full roster" would be the same list and this guard could not fail. The
// integration-owner bots are derived from integrations that genuinely exist,
// so they give the roster more than one member honestly.
func TestBlankSlateMembersStaleScratchSelectionDoesNotCollapseToOperator(t *testing.T) {
	blueprint := operations.SynthesizeBlueprint(operations.SynthesisInput{
		Directive: "Run the support desk",
		Integrations: []operations.RuntimeIntegration{
			{Name: "Gmail", Provider: "gmail", Connected: true},
			{Name: "Slack", Provider: "slack", Connected: true},
		},
	})

	full := blankSlateOfficeMembersFromBlueprint(blueprint, nil)
	if len(full) <= 1 {
		t.Fatalf("fixture blueprint synthesized %d bot(s); the collapse below cannot be detected", len(full))
	}

	members := blankSlateOfficeMembersFromBlueprint(blueprint, []string{
		"ceo",
		"gtm-lead",
		"founding-engineer",
		"pm",
		"designer",
	})

	slugs := make([]string, 0, len(members))
	for _, member := range members {
		slugs = append(slugs, member.Slug)
	}
	if len(slugs) <= 1 {
		t.Fatalf("stale scratch selection collapsed to lead-only roster: %v", slugs)
	}
	for _, want := range full {
		found := false
		for _, got := range slugs {
			if got == want.Slug {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected stale scratch selection to keep full synthesized roster; missing %q in %v", want.Slug, slugs)
		}
	}
}

func TestBlankSlateMembersExplicitLeadOnlySelectionStaysLeadOnly(t *testing.T) {
	blueprint := operations.SynthesizeBlueprint(operations.SynthesisInput{})

	members := blankSlateOfficeMembersFromBlueprint(blueprint, []string{"operator"})

	// Lead-only selection keeps just the lead. The Librarian and App Builder
	// used to be appended here; the app-builder append existed because
	// register_app was gated to the app-builder slug, so an office without
	// that member could not build apps at all. That gate is gone — every bot
	// carries register_app / get_app as a system skill — which removes the last
	// reason to seed a bot the user did not ask for.
	if len(members) != 1 || members[0].Slug != "operator" {
		t.Fatalf("explicit lead-only selection got %+v, want [operator]", members)
	}
}

// TestOnboardingCompleteSkipTaskSeedsNoKickoff verifies that skip_task=true
// seeds the team but does not post an onboarding_origin message.
func TestOnboardingCompleteSkipTaskSeedsNoKickoff(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("", true, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	memberCount := len(b.members)
	var kickoff bool
	for _, msg := range b.messages {
		if msg.Kind == "onboarding_origin" {
			kickoff = true
			break
		}
	}
	b.mu.Unlock()

	if memberCount == 0 {
		t.Fatalf("expected team seeded even with skip_task=true, got empty members")
	}
	if kickoff {
		t.Errorf("expected no onboarding_origin message with skip_task=true, found one")
	}
}

// REGRESSION: TestOnboardingCompleteSkipTaskPersistsTeam verifies that
// skip_task=true actually persists the seeded team to disk. The previous
// rewrite returned nil from postKickoffLocked before saveLocked(), so a
// user who clicked "skip first task" would lose their entire blueprint
// team on the next broker restart.
func TestOnboardingCompleteSkipTaskPersistsTeam(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("", true, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	// Fresh broker instance re-reads state from disk.
	reloaded := reloadedBroker(t, b)
	reloaded.mu.Lock()
	slugs := make([]string, 0, len(reloaded.members))
	for _, m := range reloaded.members {
		slugs = append(slugs, m.Slug)
	}
	reloaded.mu.Unlock()

	want := map[string]bool{"ceo": true, "planner": true, "builder": true, "growth": true, "reviewer": true}
	for slug := range want {
		found := false
		for _, got := range slugs {
			if got == slug {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected niche-crm slug %q to persist across restart; got %v", slug, slugs)
		}
	}
	// DefaultManifest is ceo/planner/executor/reviewer; executor is the
	// distinguishing leak signal now that ceo is a legitimate blueprint lead.
	for _, slug := range slugs {
		if slug == "executor" {
			t.Errorf("DefaultManifest slug %q leaked into persisted roster %v", slug, slugs)
		}
	}
}

// TestOnboardingCompleteLoadBlueprintErrorReturnsError verifies that a bad
// blueprint id produces a non-nil error (which HandleComplete surfaces as
// HTTP 500). No partial state should be seeded.
func TestOnboardingCompleteLoadBlueprintErrorReturnsError(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	err := b.onboardingCompleteFn("go", false, "definitely-not-a-real-blueprint", nil, "")
	if err == nil {
		t.Fatalf("expected error for unknown blueprint, got nil")
	}
	if !strings.Contains(err.Error(), "definitely-not-a-real-blueprint") && !strings.Contains(err.Error(), "blueprint") {
		t.Errorf("expected error to reference the blueprint id, got %v", err)
	}
}

// REGRESSION: TestOnboardingCompleteDedupesDuplicateTaskMessage verifies
// that calling onboardingCompleteFn twice with the same task only posts a
// single onboarding_origin message — existing crash-recovery behavior at
// broker_onboarding.go:49-53 (pre-rewrite) must survive the unified flow.
func TestOnboardingCompleteDedupesDuplicateTaskMessage(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("hello world", false, "niche-crm", nil, ""); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if err := b.onboardingCompleteFn("hello world", false, "niche-crm", nil, ""); err != nil {
		t.Fatalf("second call: %v", err)
	}

	b.mu.Lock()
	var count int
	for _, msg := range b.messages {
		if msg.Kind == "onboarding_origin" && msg.Content == "hello world" {
			count++
		}
	}
	b.mu.Unlock()

	if count != 1 {
		t.Errorf("expected dedupe to keep exactly one onboarding_origin message, got %d", count)
	}
}

// TestTaskIDsUseBlueprintPrefix verifies that seeded tasks use a
// blueprint-id prefix (e.g. "niche-crm-1") instead of the generic
// "blank-slate-N" prefix, so persisted rows are self-describing.
func TestTaskIDsUseBlueprintPrefix(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("Stand up niche CRM", false, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	b.mu.Lock()
	ids := make([]string, 0, len(b.tasks))
	for _, tk := range b.tasks {
		if tk.System {
			continue // skip permanent system tasks (e.g. task-general)
		}
		ids = append(ids, tk.ID)
	}
	b.mu.Unlock()

	if len(ids) == 0 {
		t.Fatalf("expected niche-crm blueprint to seed at least one task, got 0")
	}
	for _, id := range ids {
		if !strings.HasPrefix(id, "niche-crm-") {
			t.Errorf("expected task id to start with blueprint prefix; got %q (all: %v)", id, ids)
			break
		}
	}
}

// TestSeedFromBlueprintNilBotsKeepsFullRoster verifies the internal /
// synthesis-path contract: nil selectedBots means no filtering applied.
func TestSeedFromBlueprintNilBotsKeepsFullRoster(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("go", false, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	// niche-crm blueprint defines 5 starter bots. nil filter must keep all.
	b.mu.Lock()
	seen := make(map[string]bool)
	for _, m := range b.members {
		seen[m.Slug] = true
	}
	b.mu.Unlock()

	for _, slug := range []string{"ceo", "planner", "builder", "growth", "reviewer"} {
		if !seen[slug] {
			t.Errorf("nil bots filter should keep all blueprint bots; missing %q (roster: %v)", slug, seen)
		}
	}
}

var _ = fmt.Sprintf

// Named channels are retired (internal/channel/general.go), so a blueprint's
// starter channels must render to NOTHING — a workspace is bot DMs and
// hidden app threads only. This test used to pin the opposite half of that
// coin: that {{command_slug}} templates RENDERED rather than leaking as
// literals. That guard still matters if the switch ever flips back on, so the
// template-literal assertions are kept on whatever does render; the "found a
// named channel" requirement flips to its negation.
func TestBlankSlateOfficeChannelsFromBlueprint_RendersCommandSlug(t *testing.T) {
	blueprint := operations.Blueprint{
		Name: "Acme Co",
		Starter: operations.StarterPlan{
			Channels: []operations.StarterChannel{
				{
					Slug:        "{{command_slug}}",
					Name:        "{{command_slug}}",
					Description: "Control room for the {{brand_name}} operation.",
					Members:     []string{"planner"},
				},
			},
		},
	}
	members := []officeMember{{Slug: "planner", Name: "Planner"}}

	channels := blankSlateOfficeChannelsFromBlueprint(blueprint, members)

	for _, ch := range channels {
		// Template leak guard, kept from the original regression: anything
		// that renders must never carry a literal {{...}}.
		if strings.Contains(ch.Slug, "{{") || strings.Contains(ch.Slug, "}}") {
			t.Fatalf("channel slug leaked template literal: %q", ch.Slug)
		}
		if strings.Contains(ch.Name, "{{") || strings.Contains(ch.Name, "}}") {
			t.Fatalf("channel name leaked template literal: %q", ch.Name)
		}
		if strings.Contains(ch.Description, "{{") || strings.Contains(ch.Description, "}}") {
			t.Fatalf("channel description leaked template literal: %q", ch.Description)
		}
		// The new contract: no named channel may be minted from a blueprint
		// while the kill switch is off.
		if ch.Type != "dm" && !IsDMSlug(ch.Slug) {
			t.Fatalf("blueprint rendered named channel %q while named channels are retired", ch.Slug)
		}
	}
}

// TestOnboardingCompleteEmitsOfficeReseededEvent pins the contract the
// launcher relies on: after the wizard picks a blueprint and the broker
// rewrites b.members wholesale, a single "office_reseeded" event must fire so
// the launcher knows to respawn the interactive claude panes. Without this
// signal the panes are still bound to the default team (ceo/planner/
// executor/reviewer) and messages sent to the new roster never reach a live
// claude process — the symptom the user reported during the ui test.
func TestOnboardingCompleteEmitsOfficeReseededEvent(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	events, unsubscribe := b.SubscribeOfficeChanges(32)
	defer unsubscribe()

	if err := b.onboardingCompleteFn("Stand up niche CRM", false, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}

	// Drain events and look for the reseed signal. Other per-member events
	// are NOT emitted by this path (seedFromBlueprintLocked rewrites members
	// directly), so office_reseeded is the only way the launcher learns.
	sawReseed := false
	for {
		select {
		case evt, ok := <-events:
			if !ok {
				t.Fatalf("subscriber closed before office_reseeded fired")
			}
			if evt.Kind == "office_reseeded" {
				sawReseed = true
			}
		default:
			if !sawReseed {
				t.Fatalf("expected office_reseeded event after seed; none fired")
			}
			return
		}
	}
}

// TestOnboardingBlueprintSeedsLandExecutable pins the creation-is-the-
// authorization contract on blueprint seeds: owned lanes land Running,
// ownerless lanes land Ready — never Drafting (the parked state is for
// explicit parks only). A silent regression to the retired start-approval
// ceremony fails here.
func TestOnboardingBlueprintSeedsLandExecutable(t *testing.T) {
	ensureOperationsFallbackFS(t)
	b := newTestBroker(t)
	if err := b.onboardingCompleteFn("Stand up niche CRM", false, "niche-crm", nil, ""); err != nil {
		t.Fatalf("onboardingCompleteFn: %v", err)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	checked := 0
	for i := range b.tasks {
		task := &b.tasks[i]
		if strings.EqualFold(task.TaskType, "system") || task.LifecycleState == LifecycleStateArchived {
			continue
		}
		checked++
		switch {
		case strings.TrimSpace(task.Owner) != "" && !strings.EqualFold(task.Owner, "auto"):
			if task.LifecycleState != LifecycleStateRunning && task.LifecycleState != LifecycleStateQueuedBehindOwner {
				t.Errorf("owned seed %s (owner=%s) must land executable; got %s", task.ID, task.Owner, task.LifecycleState)
			}
		default:
			if task.LifecycleState != LifecycleStateReady {
				t.Errorf("ownerless seed %s must land Ready; got %s", task.ID, task.LifecycleState)
			}
		}
		if task.LifecycleState == LifecycleStateDrafting {
			t.Errorf("seed %s landed in the parked state — the start-approval ceremony is retired", task.ID)
		}
	}
	if checked == 0 {
		t.Fatal("blueprint seeded no checkable tasks")
	}
}
