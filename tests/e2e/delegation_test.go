package e2e

import (
	"testing"

	"github.com/nex-crm/wuphf/internal/bot"
	"github.com/nex-crm/wuphf/internal/orchestration"
)

// fakeResolver returns a StreamFnResolver that maps bot slugs to canned responses.
func fakeResolver(responses map[string]string) bot.StreamFnResolver {
	return func(slug string) bot.StreamFn {
		return func(msgs []bot.Message, tools []bot.BotTool) <-chan bot.StreamChunk {
			ch := make(chan bot.StreamChunk, 2)
			go func() {
				defer close(ch)
				resp := responses[slug]
				if resp == "" {
					resp = "done"
				}
				ch <- bot.StreamChunk{Type: "text", Content: resp}
			}()
			return ch
		}
	}
}

// fakeErrorResolver returns a StreamFnResolver where every bot gets an error chunk.
func fakeErrorResolver(errMsg string) bot.StreamFnResolver {
	return func(slug string) bot.StreamFn {
		return func(msgs []bot.Message, tools []bot.BotTool) <-chan bot.StreamChunk {
			ch := make(chan bot.StreamChunk, 1)
			go func() {
				defer close(ch)
				ch <- bot.StreamChunk{Type: "error", Content: errMsg}
			}()
			return ch
		}
	}
}

// newTestBotService creates a BotService with fake resolver and temp session store,
// bootstraps bots from the founding-team pack, and returns the service + pack.
func newTestBotService(t *testing.T, resolver bot.StreamFnResolver) (*bot.BotService, *bot.PackDefinition) {
	return newTestBotServiceWithStart(t, resolver, true)
}

func newTestBotServiceWithStart(t *testing.T, resolver bot.StreamFnResolver, start bool) (*bot.BotService, *bot.PackDefinition) {
	t.Helper()
	dir := t.TempDir()
	sessions := bot.NewSessionStoreAt(dir)

	svc := bot.NewBotService(
		bot.WithStreamFnResolver(resolver),
		bot.WithSessionStore(sessions),
	)

	pack := bot.GetPack("founding-team")
	if pack == nil {
		t.Fatal("founding-team pack not found")
		return nil, nil
	}

	for _, cfg := range pack.Bots {
		if _, err := svc.Create(cfg); err != nil {
			t.Fatalf("create bot %s: %v", cfg.Slug, err)
		}
		if start {
			if err := svc.Start(cfg.Slug); err != nil {
				t.Fatalf("start bot %s: %v", cfg.Slug, err)
			}
		}
	}

	return svc, pack
}

// --- Runtime-flow tests ---

func TestFullDelegationFlow(t *testing.T) {
	teamLeadResponse := "I'll have @fe build the UI and @be build the API."
	responses := map[string]string{
		"ceo": teamLeadResponse,
		"fe":  "UI built successfully.",
		"be":  "API endpoints created.",
	}

	svc, pack := newTestBotService(t, fakeResolver(responses))
	delegator := orchestration.NewDelegator(3)

	// Steer team-lead (ceo) with a directive.
	if err := svc.Steer("ceo", "Build a landing page with API"); err != nil {
		t.Fatalf("steer ceo: %v", err)
	}

	// Tick the CEO bot through its full cycle: idle → build_context → stream_llm → done.
	ceoBot, ok := svc.Get("ceo")
	if !ok {
		t.Fatal("ceo bot not found")
	}

	// We also need a follow-up so the loop has user content to process.
	if err := svc.FollowUp("ceo", "Build a landing page with API"); err != nil {
		t.Fatalf("follow-up ceo: %v", err)
	}

	// Tick until done or error (max 10 ticks to avoid infinite loop).
	for i := 0; i < 10; i++ {
		if err := ceoBot.Loop.Tick(); err != nil {
			t.Fatalf("ceo tick %d: %v", i, err)
		}
		state := ceoBot.Loop.GetState()
		if state.Phase == bot.PhaseDone || state.Phase == bot.PhaseError {
			break
		}
	}

	ceoState := ceoBot.Loop.GetState()
	if ceoState.Phase != bot.PhaseDone {
		t.Fatalf("expected ceo phase done, got %s (error: %s)", ceoState.Phase, ceoState.Error)
	}

	// Extract delegations from the team-lead response.
	knownSlugs := make([]string, 0, len(pack.Bots))
	for _, cfg := range pack.Bots {
		if cfg.Slug != pack.LeadSlug {
			knownSlugs = append(knownSlugs, cfg.Slug)
		}
	}

	delegations := delegator.ExtractDelegations(teamLeadResponse, knownSlugs)
	if len(delegations) != 2 {
		t.Fatalf("expected 2 delegations, got %d: %+v", len(delegations), delegations)
	}

	// Verify the correct bots were mentioned.
	slugs := map[string]bool{}
	for _, d := range delegations {
		slugs[d.BotSlug] = true
	}
	if !slugs["fe"] {
		t.Error("expected delegation to @fe")
	}
	if !slugs["be"] {
		t.Error("expected delegation to @be")
	}

	// Steer specialists with delegation messages and tick them to completion.
	for _, d := range delegations {
		msg := orchestration.FormatSteerMessage(d)
		if err := svc.Steer(d.BotSlug, msg); err != nil {
			t.Errorf("steer %s: %v", d.BotSlug, err)
		}
		if err := svc.FollowUp(d.BotSlug, d.Task); err != nil {
			t.Errorf("follow-up %s: %v", d.BotSlug, err)
		}

		ma, ok := svc.Get(d.BotSlug)
		if !ok {
			t.Errorf("bot %s not found", d.BotSlug)
			continue
		}

		for i := 0; i < 10; i++ {
			if err := ma.Loop.Tick(); err != nil {
				t.Fatalf("%s tick %d: %v", d.BotSlug, i, err)
			}
			state := ma.Loop.GetState()
			if state.Phase == bot.PhaseDone || state.Phase == bot.PhaseError {
				break
			}
		}

		state := ma.Loop.GetState()
		if state.Phase != bot.PhaseDone {
			t.Errorf("expected %s phase done, got %s (error: %s)", d.BotSlug, state.Phase, state.Error)
		}
	}
}

func TestProviderErrorSurfaces(t *testing.T) {
	svc, _ := newTestBotServiceWithStart(t, fakeErrorResolver("provider failed"), false)

	// Give the bot something to process.
	if err := svc.FollowUp("ceo", "do something"); err != nil {
		t.Fatalf("follow-up: %v", err)
	}

	ma, ok := svc.Get("ceo")
	if !ok {
		t.Fatal("ceo bot not found")
	}
	ma.Loop.Start()

	var tickErr error
	for i := 0; i < 10; i++ {
		tickErr = ma.Loop.Tick()
		if tickErr != nil {
			break
		}
		if state := ma.Loop.GetState(); state.Phase == bot.PhaseError {
			break
		}
	}
	if tickErr == nil {
		t.Fatal("expected Tick() to surface provider failure")
	}

	state := ma.Loop.GetState()
	if state.Phase != bot.PhaseError {
		t.Fatalf("expected phase error, got %s", state.Phase)
	}
	if state.Error != "provider failed" {
		t.Fatalf("expected error 'provider failed', got %q", state.Error)
	}
}

func TestTeamLeadFirstRouting(t *testing.T) {
	router := orchestration.NewMessageRouter()

	bots := []orchestration.BotInfo{
		{Slug: "ceo", Expertise: []string{"strategy", "delegation"}},
		{Slug: "fe", Expertise: []string{"frontend", "React", "CSS"}},
		{Slug: "be", Expertise: []string{"backend", "APIs", "databases"}},
	}
	for _, a := range bots {
		router.RegisterBot(a.Slug, a.Expertise)
	}
	router.SetTeamLeadSlug("ceo")

	// A generic directive should route to team-lead first.
	result := router.Route("Build a new dashboard for analytics", bots)
	if result.Primary != "ceo" {
		t.Fatalf("expected primary=ceo, got %s", result.Primary)
	}
	if !result.TeamLeadAware {
		t.Error("expected TeamLeadAware=true for team-lead routing")
	}

	// An explicit @fe mention should route directly to fe.
	result = router.Route("@fe fix the button styles", bots)
	if result.Primary != "fe" {
		t.Fatalf("expected primary=fe for @mention, got %s", result.Primary)
	}
}

func TestConcurrencyEnforced(t *testing.T) {
	delegator := orchestration.NewDelegator(1)

	response := "I need @fe to build the UI, @be to create the API, and @pm to write specs."
	knownSlugs := []string{"fe", "be", "pm"}

	delegations := delegator.ExtractDelegations(response, knownSlugs)
	if len(delegations) != 3 {
		t.Fatalf("expected 3 delegations, got %d", len(delegations))
	}

	immediate, queued := delegator.ApplyLimit(delegations)
	if len(immediate) != 1 {
		t.Fatalf("expected 1 immediate delegation, got %d", len(immediate))
	}
	if len(queued) != 2 {
		t.Fatalf("expected 2 queued delegations, got %d", len(queued))
	}

	// Verify the first delegation is the immediate one.
	if immediate[0].BotSlug != delegations[0].BotSlug {
		t.Errorf("expected immediate[0] to be %s, got %s", delegations[0].BotSlug, immediate[0].BotSlug)
	}
}

// --- Parser-level tests (preserved from original) ---

func TestDelegationParsing(t *testing.T) {
	svc := bot.NewBotService()
	pack := bot.GetPack("founding-team")
	if pack == nil {
		t.Fatal("founding-team pack not found")
		return
	}

	for _, cfg := range pack.Bots {
		_, err := svc.Create(cfg)
		if err != nil {
			t.Fatalf("failed to create bot %s: %v", cfg.Slug, err)
		}
	}

	d := orchestration.NewDelegator(3)

	response := "I'll have @fe build the landing page while @be sets up the API endpoints."
	knownSlugs := []string{"pm", "fe", "be", "designer", "cmo", "cro"}

	delegations := d.ExtractDelegations(response, knownSlugs)
	if len(delegations) != 2 {
		t.Fatalf("expected 2 delegations, got %d", len(delegations))
	}

	for _, del := range delegations {
		msg := orchestration.FormatSteerMessage(del)
		err := svc.Steer(del.BotSlug, msg)
		if err != nil {
			t.Errorf("failed to steer %s: %v", del.BotSlug, err)
		}
	}
}

func TestDelegationFlowNoDelegation(t *testing.T) {
	d := orchestration.NewDelegator(3)

	response := "I'll think about this and get back to you with a plan."
	knownSlugs := []string{"pm", "fe", "be", "designer", "cmo", "cro"}

	delegations := d.ExtractDelegations(response, knownSlugs)
	if len(delegations) != 0 {
		t.Errorf("expected 0 delegations, got %d", len(delegations))
	}
}

func TestPackBootstrap(t *testing.T) {
	pack := bot.GetPack("founding-team")
	if pack == nil {
		t.Fatal("founding-team pack not found")
		return
	}

	svc := bot.NewBotService()
	for _, cfg := range pack.Bots {
		_, err := svc.Create(cfg)
		if err != nil {
			t.Fatalf("failed to create bot %s: %v", cfg.Slug, err)
		}
	}

	for _, cfg := range pack.Bots {
		ma, ok := svc.Get(cfg.Slug)
		if !ok {
			t.Errorf("bot %s not found in service", cfg.Slug)
			continue
		}
		if ma.Config.Slug != cfg.Slug {
			t.Errorf("expected slug %s, got %s", cfg.Slug, ma.Config.Slug)
		}
	}

	list := svc.List()
	if len(list) != 8 {
		t.Errorf("expected 8 bots from List(), got %d", len(list))
	}
}
