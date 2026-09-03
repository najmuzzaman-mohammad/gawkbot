package team

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/company"
	"github.com/nex-crm/wuphf/internal/config"
	"github.com/nex-crm/wuphf/internal/onboarding"
	"github.com/nex-crm/wuphf/internal/operations"
	"github.com/nex-crm/wuphf/internal/workspaces"
)

// onboardingCompleteFn is invoked by the onboarding package when the user
// finishes the wizard. It seeds the team from the user's picked blueprint
// (or synthesizes one if blueprintID is empty — the "from scratch" path),
// honors the wizard's per-bot checkbox filter, and posts the kickoff
// task to the lead's DM tagged to the blueprint's lead bot.
//
// Contract:
//   - blueprintID is the curated blueprint the user selected. Empty means
//     "from scratch" — the broker synthesizes a blueprint from the
//     onboarding-state goals.
//   - selectedBots mirrors the wizard's toggle state:
//     nil   → no filtering (internal / synthesis callers, legacy client);
//     []    → user unchecked every bot; seed lead only + system notice;
//     [...] → keep only those slugs (plus the lead, which is unremovable).
//
// Side effects happen BEFORE the onboarding package writes the completion
// flag to disk, so a crash between this call returning and the flag write
// re-enters the wizard. The dedupe guard below (onboarding_origin by task
// content) prevents double-posting on crash recovery.
//
// The DefaultManifest roster (the Chief of Staff alone) is NEVER reached
// via this path. It remains only as a true-recovery fallback in
// ensureDefaultOfficeMembersLocked for corrupted/zero-member state.
func (b *Broker) onboardingCompleteFn(task string, skipTask bool, blueprintID string, selectedBots []string, companyName string) error {
	task = strings.TrimSpace(task)
	if !skipTask && task == "" {
		return fmt.Errorf("onboarding: task is required when skip_task=false")
	}

	blueprintID = strings.TrimSpace(blueprintID)
	synthesized := blueprintID == ""

	// Resolve the blueprint OUTSIDE the broker lock. LoadBlueprint reads YAML
	// from disk and runs validation; holding b.mu during that blocks every
	// other goroutine that needs the broker. Synthesis for the from-scratch
	// path reads onboarding state (another file) inside
	// synthesizeBlueprintFromState — also moved out of the critical section.
	var bp operations.Blueprint
	if blueprintID != "" {
		loaded, err := operations.LoadBlueprint(onboarding.ResolveTemplatesRepoRoot(""), blueprintID)
		if err != nil {
			return fmt.Errorf("onboarding: load blueprint %q: %w", blueprintID, err)
		}
		bp = loaded
	} else {
		bp = synthesizeBlueprintFromState(task)
	}

	seedErr := func() error {
		b.mu.Lock()
		defer b.mu.Unlock()

		// Dedupe after we're inside the lock so the messages slice is stable.
		// If a prior call already posted this exact task as an onboarding_origin
		// message (crash-recovery scenario), skip re-seeding and preserve the
		// earlier team.
		//
		// Matched on kind + content only. It also required
		// Channel == "general", which was the room the kickoff used to be
		// posted to — now that the kickoff lands in the lead's DM that clause
		// could never match again, the dedupe would silently stop firing, and
		// a crash-recovered onboarding would re-seed the entire team on top of
		// the existing one. The kind is already unique to this message and the
		// content is the task itself, so the channel added nothing but the
		// coupling.
		if !skipTask && task != "" {
			for _, existing := range b.messages {
				if existing.Kind == "onboarding_origin" && existing.Content == task {
					return b.saveLocked()
				}
			}
		}

		return b.seedFromBlueprintLocked(bp, selectedBots, task, skipTask, synthesized)
	}()
	if seedErr != nil {
		return seedErr
	}
	b.backfillBotFilesForRoster()

	// Materialize the blueprint's LLM wiki outside the broker lock. Lane A
	// owns the git repo at ~/.wuphf/wiki; we write the skeleton files, commit
	// them under the reserved `wuphf-bootstrap` author, then regenerate the
	// index. Wiki materialization is best-effort: a failure here should NOT
	// fail onboarding (the user should land on an empty-but-functional wiki
	// rather than a broken onboarding flow). Log and move on.
	b.materializeBlueprintWiki(bp)

	// Seed the team/getting-started/ pages here too. The wizard onboarding
	// completes through THIS path (onboardingCompleteFn), not the chat-phase
	// runSeedPhase where materializeGettingStarted is also wired, so without
	// this call a wizard-onboarded office lands on a wiki with no Getting
	// Started section (and on the scratch path, no wiki content at all, since
	// materializeBlueprintWiki no-ops without a WikiSchema). Mirrors the
	// runSeedPhase seed; best-effort and idempotent (skip-if-exists). The
	// trailing index regen mirrors runSeedPhase so index/all.md reflects the
	// pages that land via atomicWrite outside the WikiWorker commit path.
	b.materializeGettingStarted()
	regenCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	b.regenWikiIndexAfterSeed(regenCtx, "wizard complete")
	cancel()

	// Sync the company name captured during onboarding to the workspace
	// registry so the rail can display it without a separate API call.
	companyName = strings.TrimSpace(companyName)
	if companyName != "" {
		if runtimeHome := config.RuntimeHomeDir(); runtimeHome != "" {
			// Ad-hoc runtime homes (a --runtime-home never added to the
			// registry) are legitimately absent — the config fallback below
			// carries the name for them, so not-found is not an error.
			if err := workspaces.UpdateCompanyNameByRuntimeHome(runtimeHome, companyName); err != nil && !errors.Is(err, workspaces.ErrWorkspaceNotFound) {
				log.Printf("onboarding: sync company name to registry: %v", err)
			}
		}
		// Persist into config too: cfg.CompanyName is what GET /config and
		// the office-channel payloads read, and until now onboarding never
		// wrote it — every surface reading config saw an empty company name
		// (the registry sync above also misses ad-hoc runtime homes that
		// were never registered). Load-then-save so a transient read failure
		// never clobbers the rest of the file.
		if cfg, err := config.Load(); err != nil {
			log.Printf("onboarding: load config for company name: %v", err)
		} else if strings.TrimSpace(cfg.CompanyName) == "" {
			cfg.CompanyName = companyName
			if err := config.Save(cfg); err != nil {
				log.Printf("onboarding: save company name to config: %v", err)
			}
		}
		// Re-derive the Linear-style Issue ID prefix now that the workspace
		// has a real company name (e.g. "Nex" → NEX-1). Any Issues minted
		// before onboarding completed keep their OFFICE-N IDs; new ones
		// pick up the company-derived prefix.
		b.mu.Lock()
		b.refreshIDPrefixFromWorkspaceLocked()
		b.mu.Unlock()
	}

	return nil
}

// materializeBlueprintWiki resolves ~/.wuphf/wiki, runs the skeleton
// materializer, commits any newly-written skeletons as `wuphf-bootstrap`,
// then regenerates the index so a fresh install has both the files AND the
// audit trail from day 1.
//
// Errors are logged, never returned — onboarding succeeds regardless. A
// blueprint without a WikiSchema (e.g. a synthesized from-scratch
// blueprint) is silently skipped.
//
// Important: this runs OUTSIDE the broker lock (see caller), and initializes
// the wiki worker before writing when the markdown backend is active. That
// keeps skeleton files and git history coupled from the first render. If the
// worker is not live (memory backend != markdown), we still materialize files
// best-effort for read-only fallback, but no git commit is possible.
func (b *Broker) materializeBlueprintWiki(bp operations.Blueprint) {
	if bp.WikiSchema == nil {
		return
	}
	b.ensureWikiWorker()
	worker := b.WikiWorker()

	wikiRoot := ""
	if worker != nil && worker.Repo() != nil {
		wikiRoot = worker.Repo().Root()
	} else {
		wikiRoot = WikiRootDir()
	}
	result, err := operations.MaterializeWiki(context.Background(), wikiRoot, bp.WikiSchema)
	if err != nil {
		log.Printf("onboarding: wiki materialize failed (wiki left empty): %v", err)
		return
	}
	if len(result.ArticlesCreated) > 0 || len(result.DirsCreated) > 0 {
		log.Printf("onboarding: wiki materialized blueprint=%s dirs=%d articles_created=%d articles_skipped=%d",
			bp.ID, len(result.DirsCreated), len(result.ArticlesCreated), len(result.ArticlesSkipped))
	}
	// Nothing to commit if only existing articles were observed.
	if len(result.ArticlesCreated) == 0 && len(result.DirsCreated) == 0 {
		return
	}
	if worker == nil || worker.Repo() == nil {
		// Non-markdown backend — skeletons stay on disk as read-only files.
		return
	}
	repo := worker.Repo()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Regenerate the index FIRST so CommitBootstrap picks up index/all.md in
	// the same commit as the skeletons. Leaving it untracked would cause
	// RecoverDirtyTree on the next launch to fold it into a `wuphf-recovery`
	// commit, which misattributes a derived artefact.
	if err := repo.IndexRegen(ctx); err != nil {
		log.Printf("onboarding: wiki index regen failed (continuing): %v", err)
	}
	bootstrapMsg := fmt.Sprintf("wuphf: materialize %s blueprint skeletons", bp.ID)
	sha, err := repo.CommitBootstrap(ctx, bootstrapMsg)
	if err != nil {
		log.Printf("onboarding: wiki commit-bootstrap failed: %v", err)
		return
	}
	if sha != "" {
		log.Printf("onboarding: wiki bootstrap committed %s (blueprint=%s)", sha, bp.ID)
	}
}

// synthesizeBlueprintFromState builds a blueprint for the "From scratch"
// wizard path. Reads onboarding state from disk, so it must be called
// OUTSIDE the broker mutex. Unlike the old seedBlankSlateOperationLocked
// it does not mutate broker state — the caller feeds the returned
// Blueprint to seedFromBlueprintLocked.
//
// The starter roster is a fixed 5-bot founding team (CEO lead plus GTM
// Lead, Founding Engineer, Product Manager, Designer) rather than the
// generic operator/planner/executor/reviewer shape. This is the product
// default for a brand-new WUPHF office: it covers the four functions a
// real early-stage team needs (strategy, revenue, build, design) with a
// named CEO as the human-facing lead. Users can still uncheck bots in
// the wizard's Team step; unchecked ones are dropped via the filter.
func synthesizeBlueprintFromState(task string) operations.Blueprint {
	state, err := onboarding.Load()
	if err != nil {
		// Best-effort: fall through with empty profile. A Load failure is
		// logged by the onboarding package; we still produce a blueprint
		// so the wizard can complete.
		log.Printf("onboarding: load state for synthesis: %v", err)
		state = &onboarding.State{}
	}
	name := strings.TrimSpace(state.CompanyName)
	desc := onboardingPartialString(state.Partial, "welcome", "desc")
	return scratchFoundingTeamBlueprint(name, desc, strings.TrimSpace(task))
}

// scratchFoundingTeamBlueprint returns the fixed "From scratch" starter
// roster: CEO (lead), GTM Lead, Founding Engineer, Product Manager,
// Designer. Extracted so tests can assert the shape without rebuilding
// onboarding state.
func scratchFoundingTeamBlueprint(companyName, description, directive string) operations.Blueprint {
	displayName := companyName
	if displayName == "" {
		displayName = "Your company"
	}
	bots := []operations.StarterBot{
		{Slug: "ceo", Name: "Chief of Staff", Role: "lead", Checked: true, Type: "assistant", BuiltIn: true, Expertise: []string{"strategy", "prioritization", "delegation"}, Personality: "Sets direction, breaks directives into specialist assignments, and owns the outcome."},
		{Slug: "gtm-lead", Name: "GTM Lead", Role: "go-to-market", Checked: true, Type: "assistant", Expertise: []string{"positioning", "sales", "marketing", "growth"}, Personality: "Turns the product into pipeline — messaging, outbound, launches, and early revenue."},
		{Slug: "founding-engineer", Name: "Founding Engineer", Role: "engineering", Checked: true, Type: "assistant", Expertise: []string{"full-stack", "architecture", "infrastructure", "shipping"}, Personality: "Full-stack engineer who ships end-to-end and makes pragmatic architectural calls."},
		{Slug: "pm", Name: "Product Manager", Role: "product", Checked: true, Type: "assistant", Expertise: []string{"roadmap", "user-stories", "requirements", "specs"}, Personality: "Translates business goals into specs the engineering and design functions can execute against."},
		{Slug: "designer", Name: "Designer", Role: "design", Checked: true, Type: "assistant", Expertise: []string{"UI-UX-design", "branding", "prototyping"}, Personality: "Owns the look, feel, and flow — from first sketch to shipped interface."},
	}
	channels := []operations.StarterChannel{
		{Slug: "general", Name: "general", Description: "Primary coordination channel.", Members: []string{"ceo", "gtm-lead", "founding-engineer", "pm", "designer"}},
		{Slug: "product", Name: "product", Description: "Roadmap, specs, and design reviews.", Members: []string{"ceo", "pm", "designer", "founding-engineer"}},
		{Slug: "gtm", Name: "gtm", Description: "Positioning, pipeline, and launches.", Members: []string{"ceo", "gtm-lead", "pm"}},
	}
	var tasks []operations.StarterTask
	if directive != "" {
		tasks = []operations.StarterTask{{
			Channel: "general",
			Owner:   "ceo",
			Title:   "Kick off the directive",
			Details: directive,
		}}
	}
	return operations.Blueprint{
		ID:          "from-scratch",
		Name:        displayName,
		Kind:        "general",
		Description: description,
		Objective:   directive,
		Starter: operations.StarterPlan{
			LeadSlug:                  "ceo",
			GeneralChannelDescription: "Primary coordination channel.",
			KickoffPrompt:             directive,
			Bots:                      bots,
			Channels:                  channels,
			Tasks:                     tasks,
		},
	}
}

// seedFromBlueprintLocked is the single seed path used by both picked-
// blueprint and from-scratch flows. It replaces the prior dual-path code
// (seedBlankSlateOperationLocked + ensureDefaultOfficeMembersLocked+manual
// kickoff). selectedBots filters the blueprint's starter roster; see the
// onboardingCompleteFn doc comment for the three-mode contract.
func (b *Broker) seedFromBlueprintLocked(bp operations.Blueprint, selectedBots []string, task string, skipTask bool, synthesized bool) error {
	b.members = blankSlateOfficeMembersFromBlueprint(bp, selectedBots)
	if len(b.members) == 0 {
		// Defensive: blueprint had no parseable bots AND no lead fallback
		// kicked in. Seed the DefaultManifest so the user has SOMETHING.
		b.members = defaultOfficeMembers()
	}
	b.channels = blankSlateOfficeChannelsFromBlueprint(bp, b.members)
	b.tasks = blankSlateOfficeTasksFromBlueprint(bp)
	// #general kill switch, gate 5 of 7: the zero-channel fallback. With the
	// switch off, gate 4 legitimately returns an empty channel list, so this
	// must not fabricate general to "rescue" it — an office with no shared
	// room is the intended end state, and conversation lives in DMs.
	if len(b.channels) == 0 && generalChannelEnabled() {
		b.channels = []teamChannel{{
			Slug:        GeneralChannelSlug,
			Name:        GeneralChannelSlug,
			Description: "Primary coordination channel.",
			Members:     memberSlugsFromMembers(b.members),
		}}
	}
	b.messages = nil
	b.counter = 0
	b.lastTaggedAt = make(map[string]time.Time)
	// Seed the "Backup & Migration" system task that owns #general so the
	// ~141 fallback call sites that post to "general" keep working.
	b.ensureBackupMigrationTaskLocked()
	// Every bot gets a DM, HERE and not only on the next Load.
	//
	// Onboarding replaces the roster wholesale, so the DMs seeded at boot are
	// for members that no longer exist. Without this the human finishes
	// onboarding and has the blueprint's working channels but no 1:1 with
	// anyone -- and with #general retired, no way to talk to the lead at all
	// until the process is restarted.
	b.ensureBotDMsLocked()
	if err := b.postKickoffLocked(bp, selectedBots, task, skipTask, synthesized); err != nil {
		return err
	}
	// Pack/blueprint seeds follow the same contract as every other create
	// path: the human choosing the pack IS the authorization, so seeded
	// starter lanes land as Issues that are immediately executable — owner
	// set → Running with the owner dispatched through the task_created
	// action, ownerless → Ready until staffed. Dispatch is gated only by
	// ownership; there is no start-approval ceremony. The Backup &
	// Migration system task is exempt.
	for i := range b.tasks {
		if b.tasks[i].System || b.tasks[i].LifecycleState != "" {
			continue
		}
		b.tasks[i].TaskType = "issue"
		target := LifecycleStateReady
		if owner := strings.TrimSpace(b.tasks[i].Owner); owner != "" && !isAutoOwner(owner) {
			target = LifecycleStateRunning
		}
		if err := b.applyLifecycleStateLocked(&b.tasks[i], target); err != nil {
			log.Printf("onboarding: land seeded task %s in %s: %v", b.tasks[i].ID, target, err)
			continue
		}
		// Wake the owner through the same notify path a composer create
		// uses (task_created → notifyTaskActionsLoop → sendTaskUpdate).
		b.appendActionLocked("task_created", "office", normalizeChannelSlug(b.tasks[i].Channel),
			b.tasks[i].CreatedBy, truncateSummary(b.tasks[i].Title, 140), b.tasks[i].ID)
	}
	// Signal subscribers (the launcher) that the office roster was replaced
	// wholesale. Individual member_created events aren't emitted by this path
	// — seedFromBlueprintLocked rewrites b.members directly — so without this
	// the launcher never learns the interactive tmux panes are out of sync
	// with the new team. Subscribers should treat this as "respawn panes".
	b.publishOfficeChangeLocked(officeChangeEvent{Kind: "office_reseeded"})
	return nil
}

func (b *Broker) postKickoffLocked(bp operations.Blueprint, selectedBots []string, task string, skipTask bool, synthesized bool) error {
	now := time.Now().UTC().Format(time.RFC3339)

	// Every message below goes to the LEAD's DM.
	//
	// All five were addressed to "general". With the shared room retired that
	// is a channel with no readers, so a freshly onboarded workspace wrote its
	// origin task, its welcome, and its blueprint markers into nothing and
	// opened completely silent — the worst possible first paint, and invisible
	// because appendMessageLocked does not check that the channel exists.
	//
	// homeChannelForLocked both resolves the DM and creates it if missing, and
	// ensureBotDMsLocked has just run one call up, so the lead's
	// conversation is there. Failing loudly is right if it somehow is not:
	// this is the first thing the human ever sees, and an office seeded with
	// an unreachable kickoff is worse than one that refuses to seed.
	lead := officeLeadSlugFromMembers(b.members)
	if lead == "" {
		// Every shipped blueprint declares ceo as lead (guarded by
		// TestAllOperationBlueprintsUseCEOLead). The fallback here only fires
		// for malformed/synthesized blueprints with no identifiable lead.
		lead = "ceo"
	}
	leadHome, err := b.homeChannelForLocked(lead)
	if err != nil {
		return fmt.Errorf("onboarding: no conversation to post the kickoff into: %w", err)
	}

	// No lead-only warning any more. A roster of exactly the Chief of Staff
	// is the intended default, not an anomaly to apologize for: specialists
	// are created on demand. (The old warning also counted "specialists" by
	// excluding the Librarian and App Builder, two bots that no longer
	// seed.)

	if skipTask {
		// No task was kicked off, so the Chief of Staff opens the DM itself.
		// Founder: "the Chief of Staff should have a first prompt to introduce
		// itself and the features and ask for the person's goal to plan the
		// first thing to do." It speaks as the bot (From: lead), not as
		// "system": the point of landing in a DM is that somebody is there.
		// No staged bot presence lines and no invented team: the roster is
		// one bot and the message says only what the product actually does
		// (core-loop R6 removed the demo_seed machinery; the honesty doctrine
		// keeps it out).
		b.counter++
		b.appendMessageLocked(channelMessage{
			ID:        fmt.Sprintf("msg-%d", b.counter),
			From:      lead,
			Channel:   leadHome,
			Content:   chiefOfStaffIntroMessage(b.members),
			Timestamp: now,
		})
		// seedFromBlueprintLocked mutated b.members/channels/tasks above; we
		// must persist that even when the user skipped the kickoff task.
		// Returning early without saveLocked() silently loses the seeded team
		// on the next broker Load.
		return b.saveLocked()
	}

	task = strings.TrimSpace(task)
	if task == "" {
		return fmt.Errorf("onboarding: task is required when skip_task=false")
	}

	b.counter++
	b.appendMessageLocked(channelMessage{
		ID:        fmt.Sprintf("msg-%d", b.counter),
		From:      "human",
		Channel:   leadHome,
		Kind:      "onboarding_origin",
		Content:   task,
		Tagged:    []string{lead},
		Timestamp: now,
	})
	if b.lastTaggedAt == nil {
		b.lastTaggedAt = make(map[string]time.Time)
	}
	b.lastTaggedAt[lead] = time.Now()

	// Synthesized blueprints (from-scratch path) post two extra markers so
	// the downstream bots know they are running against a just-invented
	// operation rather than a curated one.
	if synthesized {
		if strings.TrimSpace(bp.Name) != "" {
			b.counter++
			b.appendMessageLocked(channelMessage{
				ID:        fmt.Sprintf("msg-%d", b.counter),
				From:      "system",
				Channel:   leadHome,
				Kind:      "synthesized_blueprint",
				Content:   fmt.Sprintf("Synthesized operation: %s (%s)", bp.Name, bp.Kind),
				Timestamp: now,
			})
		}
		b.counter++
		b.appendMessageLocked(channelMessage{
			ID:        fmt.Sprintf("msg-%d", b.counter),
			From:      "system",
			Channel:   leadHome,
			Kind:      "from_scratch_contract",
			Content:   "Run this as a real business workflow. If a needed specialist, channel, skill, or tooling path is missing, create it and keep going. Local proof packets, review bundles, and other internal substitute artifacts do not count when a live business step is possible.",
			Timestamp: now,
		})
	}

	return b.saveLocked()
}

// welcomeMessageForMembers builds the system welcome posted to #general when
// the user finishes onboarding without seeding a task. Names the lead so the
// office feels staffed (not abstract) and points the user at the composer.
// chiefOfStaffIntroMessage is the Chief of Staff's opening line in a fresh
// office where no task was kicked off. It replaces welcomeMessageForMembers,
// whose copy ("the team are online and ready ... they'll claim work, argue,
// and ship") described a six-bot default office that no longer exists and
// spoke as "system" about bots instead of letting the one bot present
// speak.
//
// The copy promises only what the product does today: absorbing menial work,
// microapps to manage outcomes, teach-by-screenshare, and the approval gate.
// It closes by asking for the goal, which is the founder's spec: introduce
// itself, cover the features, ask what the person wants so it can plan the
// first thing.
func chiefOfStaffIntroMessage(members []officeMember) string {
	_, leadName := leadSlugAndName(members)
	if leadName == "" {
		leadName = "your Chief of Staff"
	}
	return fmt.Sprintf(
		"I am %s. Hand me the boring part: I read the threads, chase the follow ups, and do the menial work, and when you want a screen to manage the outcome I build you a microapp for it. You can also show me a workflow once on a screenshare and I will handle it from then on. Anything that leaves this office waits for your approval first.\n\nSo, what are you trying to get done? Give me the goal and I will plan the first thing. If the work needs more bots, I will propose them as we go.",
		leadName,
	)
}

// leadSlugAndName returns the slug+display-name of the office lead. Empty
// strings are returned when the roster has no identifiable lead — callers
// should treat that as "skip lead-specific messaging" rather than crash.
func leadSlugAndName(members []officeMember) (string, string) {
	slug := officeLeadSlugFromMembers(members)
	if slug == "" {
		return "", ""
	}
	for _, m := range members {
		if strings.TrimSpace(m.Slug) == slug {
			return slug, strings.TrimSpace(m.Name)
		}
	}
	return slug, ""
}

func onboardingPartialString(partial *onboarding.PartialProgress, step, key string) string {
	if partial == nil {
		return ""
	}
	answers := partial.Answers[strings.TrimSpace(step)]
	if len(answers) == 0 {
		return ""
	}
	if value, ok := answers[strings.TrimSpace(key)]; ok {
		if s, ok := value.(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// blankSlateOfficeMembersFromBlueprint projects a blueprint's starter
// bot list into broker officeMembers, applying the wizard's
// selectedBots filter. See onboardingCompleteFn doc for the nil / empty
// / populated contract.
//
// The lead bot (from blueprint.Starter.LeadSlug) is always kept,
// regardless of the filter — removing the lead leaves downstream code with
// no one to tag for kickoff and no BuiltIn member for channel ownership.
func blankSlateOfficeMembersFromBlueprint(blueprint operations.Blueprint, selectedBots []string) []officeMember {
	bots := blueprint.Starter.Bots
	leadSlug := normalizeChannelSlug(blueprint.Starter.LeadSlug)
	filter := botSelectionFilter(selectedBots, leadSlug)
	availableSlugs := starterBotSlugSet(bots)

	members := blankSlateOfficeMembersFromBots(bots, leadSlug, filter)
	// A stale web bundle can post scratch-team slugs from a different
	// synthesized roster. In that case the filter keeps only the lead; prefer
	// the full current roster over a misleading one-bot office.
	if selectionLooksStaleForStarterBots(selectedBots, leadSlug, availableSlugs, members) {
		members = blankSlateOfficeMembersFromBots(bots, leadSlug, nil)
	}
	if len(members) > 0 {
		// The blueprint roster stands as selected. The Librarian and App
		// Builder are no longer appended here: both are retired as default
		// bots, and their jobs (wiki contribution, app building) are system
		// skills every bot carries rather than bots of their own.
		return members
	}
	// Defensive fallback used only when the blueprint had zero parseable
	// bots. The smallest office that works is the Chief of Staff alone; it
	// creates specialists on demand instead of shipping an invented team.
	now := time.Now().UTC().Format(time.RFC3339)
	return []officeMember{
		{Slug: "ceo", Name: company.ChiefOfStaffName(), Role: company.ChiefOfStaffRole(), BuiltIn: true, CreatedBy: "wuphf", CreatedAt: now},
	}
}

func blankSlateOfficeMembersFromBots(bots []operations.StarterBot, leadSlug string, filter func(string) bool) []officeMember {
	members := make([]officeMember, 0, len(bots))
	now := time.Now().UTC().Format(time.RFC3339)
	for _, bot := range bots {
		// The skip tests the RAW value: normalizeChannelSlug turns a nameless
		// starter bot into a bot literally called "general".
		//
		// Normaliser deliberately UNCHANGED — this becomes officeMember.Slug,
		// which is persisted and looked up by findMemberLocked. Switching it is
		// a migration; see broker_indexes.go.
		raw := operationFirstNonEmpty(bot.Slug, bot.EmployeeBlueprint, operationSlug(bot.Name))
		if strings.TrimSpace(raw) == "" {
			continue
		}
		slug := normalizeChannelSlug(raw)
		if filter != nil && !filter(slug) {
			continue
		}
		name := strings.TrimSpace(bot.Name)
		if name == "" {
			name = humanizeSlug(slug)
		}
		role := strings.TrimSpace(bot.Role)
		if role == "" {
			role = name
		}
		// The lead's display name is owned by the code, not the blueprint.
		// Blueprint files predating the rename still say "CEO", and the load
		// reconciler only fixes that on the NEXT boot — so without this, the
		// very first session (including the Chief of Staff's intro message,
		// which interpolates the name) ran under the retired title.
		if slug == "ceo" {
			name = company.ChiefOfStaffName()
			role = company.ChiefOfStaffRole()
		}
		members = append(members, officeMember{
			Slug:         slug,
			Name:         name,
			Role:         role,
			Expertise:    normalizeStringList(bot.Expertise),
			Personality:  strings.TrimSpace(bot.Personality),
			AllowedTools: nil,
			CreatedBy:    "wuphf",
			CreatedAt:    now,
			BuiltIn:      bot.BuiltIn || slug == leadSlug || slug == "operator" || slug == "founder" || slug == "ceo",
		})
	}
	return members
}

func starterBotSlugSet(bots []operations.StarterBot) map[string]struct{} {
	out := make(map[string]struct{}, len(bots))
	for _, bot := range bots {
		// The skip tests the RAW value: normalizeChannelSlug turns a nameless
		// starter bot into a bot literally called "general".
		//
		// Normaliser deliberately UNCHANGED — this becomes officeMember.Slug,
		// which is persisted and looked up by findMemberLocked. Switching it is
		// a migration; see broker_indexes.go.
		raw := operationFirstNonEmpty(bot.Slug, bot.EmployeeBlueprint, operationSlug(bot.Name))
		if strings.TrimSpace(raw) == "" {
			continue
		}
		slug := normalizeChannelSlug(raw)
		out[slug] = struct{}{}
	}
	return out
}

func selectionLooksStaleForStarterBots(selectedBots []string, leadSlug string, availableSlugs map[string]struct{}, members []officeMember) bool {
	if len(selectedBots) == 0 || len(members) != 1 {
		return false
	}
	if leadSlug == "" || members[0].Slug != leadSlug {
		return false
	}
	hasUnknown := false
	hasKnownNonLead := false
	for _, raw := range selectedBots {
		// Bot slugs from the wizard selection: actor normaliser, raw skip.
		if strings.TrimSpace(raw) == "" {
			continue
		}
		slug := normalizeChannelSlug(raw)
		if _, ok := availableSlugs[slug]; !ok {
			hasUnknown = true
			continue
		}
		if slug != leadSlug {
			hasKnownNonLead = true
		}
	}
	return hasUnknown && !hasKnownNonLead
}

// botSelectionFilter returns a membership predicate for the wizard's
// selectedBots array. nil input disables filtering (keep all); empty
// array keeps only the lead so the team isn't empty (the caller relies on
// len(members) == 1 to emit the lead-only system message); a populated
// array keeps only those slugs, always including the lead.
func botSelectionFilter(selectedBots []string, leadSlug string) func(string) bool {
	if selectedBots == nil {
		return nil
	}
	allowed := make(map[string]bool, len(selectedBots)+1)
	for _, s := range selectedBots {
		if slug := normalizeChannelSlug(s); slug != "" {
			allowed[slug] = true
		}
	}
	if leadSlug != "" {
		allowed[leadSlug] = true
	}
	return func(slug string) bool { return allowed[slug] }
}

func blankSlateOfficeChannelsFromBlueprint(blueprint operations.Blueprint, members []officeMember) []teamChannel {
	brandName := operationFirstNonEmpty(blueprint.Name, "New operation")
	commandSlug := operationSlug(brandName + " command")
	if commandSlug == "" {
		commandSlug = "command"
	}
	replacements := map[string]string{
		"brand_name":   brandName,
		"brand_slug":   operationSlug(operationFirstNonEmpty(blueprint.Name, "new-operation")),
		"command_slug": commandSlug,
	}
	now := time.Now().UTC().Format(time.RFC3339)
	lead := officeLeadSlugFromMembers(members)
	// #general kill switch, gate 4 of 7. This prepends general as channels[0]
	// unconditionally, independent of what the blueprint declares, so it is a
	// resurrection point for every seeded and synthesized office.
	var channels []teamChannel
	if generalChannelEnabled() {
		channels = append(channels, teamChannel{
			Slug:        GeneralChannelSlug,
			Name:        GeneralChannelSlug,
			Description: operationRenderTemplateString(blueprint.Starter.GeneralChannelDescription, replacements),
			Members:     memberSlugsFromMembers(members),
			CreatedBy:   "wuphf",
			CreatedAt:   now,
			UpdatedAt:   now,
		})
	}
	// Named-channel retirement. A blueprint's own rooms (#product, #gtm, and
	// whatever a curated blueprint declares) are ordinary named channels, so
	// they go with the rest of them. Gated as a whole rather than per-slug: the
	// decision is "does this office get named rooms at all", not "which ones".
	// The general branch above has its own switch and is unaffected.
	if !namedChannelsEnabled() {
		return channels
	}
	for _, starter := range blueprint.Starter.Channels {
		rawSlug := operationRenderTemplateString(starter.Slug, replacements)
		slug := normalizeChannelSlug(rawSlug)
		// A blueprint that declares general is skipped either way: when the
		// switch is on it is already channels[0] above, and when it is off it
		// must not come back in through the blueprint.
		// Cosmetic: an empty starter slug already normalised to "general" and
		// was caught by the second clause, so this is honest tidying, not a fix.
		if strings.TrimSpace(rawSlug) == "" || slug == GeneralChannelSlug {
			continue
		}
		membersList := make([]string, 0, len(starter.Members))
		for _, member := range starter.Members {
			// Channel MEMBERS are actor slugs. Under the channel normaliser a
			// blank entry became "general" and the `!= ""` test kept it, so a
			// starter channel silently listed #general as one of its members.
			rawMember := operationRenderTemplateString(member, replacements)
			if strings.TrimSpace(rawMember) != "" {
				membersList = append(membersList, normalizeChannelSlug(rawMember))
			}
		}
		channels = append(channels, teamChannel{
			Slug:        slug,
			Name:        operationRenderTemplateString(starter.Name, replacements),
			Description: operationRenderTemplateString(starter.Description, replacements),
			Members:     uniqueSlugs(append([]string{lead}, membersList...)),
			CreatedBy:   "wuphf",
			CreatedAt:   now,
			UpdatedAt:   now,
		})
	}
	return channels
}

func blankSlateOfficeTasksFromBlueprint(blueprint operations.Blueprint) []teamTask {
	now := time.Now().UTC().Format(time.RFC3339)
	prefix := taskIDPrefix(blueprint)
	tasks := make([]teamTask, 0, len(blueprint.Starter.Tasks))
	for i, starter := range blueprint.Starter.Tasks {
		channel := normalizeChannelSlug(starter.Channel)
		if channel == "" {
			channel = "general"
		}
		// normalizeChannelSlug("") returns "general" (lobby fallback) —
		// an ownerless starter task must stay ownerless so it lands READY
		// and dispatches on assignment, not on a phantom "general" owner.
		owner := ""
		if strings.TrimSpace(starter.Owner) != "" {
			owner = normalizeChannelSlug(starter.Owner)
		}
		tasks = append(tasks, teamTask{
			ID:        fmt.Sprintf("%s-%d", prefix, i+1),
			Channel:   channel,
			Title:     strings.TrimSpace(starter.Title),
			Details:   strings.TrimSpace(starter.Details),
			Owner:     owner,
			status:    "open",
			CreatedBy: "wuphf",
			CreatedAt: now,
			UpdatedAt: now,
		})
	}
	return tasks
}

// taskIDPrefix returns a slug usable as a prefix for seeded task IDs.
// Curated blueprints (niche-crm, youtube-factory, etc.) have an ID field
// set by the loader; synthesized blueprints have an inferred ID too, but
// if for any reason the blueprint has no ID we fall back to "blank-slate"
// to preserve the legacy id shape.
func taskIDPrefix(bp operations.Blueprint) string {
	if id := normalizeChannelSlug(bp.ID); id != "" {
		return id
	}
	return "blank-slate"
}

func memberSlugsFromMembers(members []officeMember) []string {
	out := make([]string, 0, len(members))
	for _, member := range members {
		if slug := strings.TrimSpace(member.Slug); slug != "" {
			out = append(out, slug)
		}
	}
	return uniqueSlugs(out)
}

// officeLeadSlugFromMembers picks a lead from a member list when the pack
// doesn't declare one. Sorts a copy of the input by slug before iterating
// so the answer is order-independent — same rationale as officeLeadSlugFrom
// in office_targets.go (callers pass differently-ordered snapshots; without
// the sort they'd disagree on the lead in BuiltIn-free rosters).
//
// The CEO pass mirrors officeLeadSlugFrom and is load-bearing, not cosmetic.
// The Librarian and the App Builder are BuiltIn service bots present in
// every office, and "app-builder" sorts ahead of "ceo", so a BuiltIn-first
// scan handed the lead to the App Builder on every seeded roster: the
// onboarding kickoff issue was tagged to it instead of the CEO, and the
// non-general starter channels listed it as their lead. Every other lead
// lookup in the broker already resolves to the CEO, so this one did too once
// it stopped answering first.
func officeLeadSlugFromMembers(members []officeMember) string {
	sorted := append([]officeMember(nil), members...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slug < sorted[j].Slug })
	for _, member := range sorted {
		if strings.TrimSpace(member.Slug) == "ceo" {
			return "ceo"
		}
	}
	for _, member := range sorted {
		if member.BuiltIn {
			return strings.TrimSpace(member.Slug)
		}
	}
	if len(sorted) > 0 {
		return strings.TrimSpace(sorted[0].Slug)
	}
	return ""
}
