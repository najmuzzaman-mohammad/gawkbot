package team

import (
	"log"
	"os"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/channel"
	"github.com/nex-crm/wuphf/internal/company"
	"github.com/nex-crm/wuphf/internal/onboarding"
)

// Defaults + state normalization. Owns:
//   - default office members + channels (loaded from the runtime
//     manifest under repoRootForRuntimeDefaults, with fallback to
//     company.DefaultManifest)
//   - isDefaultChannelState / isDefaultOfficeMemberState — used by
//     saveLocked's "zero-state" branch to detect "nothing worth
//     persisting" and remove the state file
//   - normalizeChannelSlug / normalizeActorSlug — ToLower + replace
//     space/_ with - (preserving the __ DM separator)
//   - ensureDefaultChannelsLocked / ensureDefaultOfficeMembersLocked
//     — idempotent recovery hooks; only seed defaults when state is
//     truly empty
//   - normalizeLoadedStateLocked — the post-load fixup pass that
//     reconciles legacy data shapes (un-slugged channels, missing
//     defaults, deduplicated members, request lifecycle re-scheduling)
//   - reconcileOrphanedBlockedTasksLocked — one-shot migration for
//     tasks left blocked by a since-terminated parent

func defaultOfficeMembers() []officeMember {
	now := time.Now().UTC().Format(time.RFC3339)
	manifest, err := company.LoadRuntimeManifest(repoRootForRuntimeDefaults())
	if err != nil || len(manifest.Members) == 0 {
		manifest = company.DefaultManifest()
	}
	members := make([]officeMember, 0, len(manifest.Members)+1)
	for _, cfg := range manifest.Members {
		builtIn := cfg.System || cfg.Slug == manifest.Lead || cfg.Slug == "ceo"
		members = append(members, memberFromSpec(cfg, "wuphf", now, builtIn))
	}
	return members
}

func defaultOfficeMemberSlugs() []string {
	members := defaultOfficeMembers()
	slugs := make([]string, 0, len(members))
	for _, member := range members {
		slugs = append(slugs, member.Slug)
	}
	return slugs
}

func defaultTeamChannels() []teamChannel {
	now := time.Now().UTC().Format(time.RFC3339)
	manifest, err := company.LoadRuntimeManifest(repoRootForRuntimeDefaults())
	if err != nil || len(manifest.Channels) == 0 {
		manifest = company.DefaultManifest()
	}
	channels := make([]teamChannel, 0, len(manifest.Channels))
	for _, channel := range manifest.Channels {
		// #general kill switch, gate 2 of 7. This is the broker's only view of
		// the manifest's CHANNEL list, so filtering here also covers
		// company.DefaultManifest and company.normalizeManifest re-adding
		// general upstream. Those are gated at the source too (gate 3), but a
		// hand-written manifest.yaml on disk reaches us through here and past
		// them, so the broker filters as well.
		//
		// "Only view" is narrower than it sounds, and the distinction is load
		// bearing. company.DefaultManifest has five other callers —
		// broker_pane.go, broker_misc_handlers.go, cmd/wuphf/channel_splash.go,
		// and two in cmd/wuphf/channelui/manifest.go — plus LoadRuntimeManifest
		// in launcher_membership.go. Every one of them reads manifest.Members
		// and never manifest.Channels, which is the only reason this stays the
		// sole channel path. If any of them starts reading Channels, it becomes
		// another gate; do not assume this one still covers the package.
		if !generalChannelEnabled() && channel.Slug == GeneralChannelSlug {
			continue
		}
		tc := teamChannel{
			Slug:        channel.Slug,
			Name:        channel.Name,
			Description: channel.Description,
			Members:     append([]string(nil), channel.Members...),
			Disabled:    append([]string(nil), channel.Disabled...),
			CreatedBy:   "wuphf",
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		if channel.Surface != nil {
			tc.Surface = &channelSurface{
				Provider:    channel.Surface.Provider,
				RemoteID:    channel.Surface.RemoteID,
				RemoteTitle: channel.Surface.RemoteTitle,
				Mode:        channel.Surface.Mode,
				BotTokenEnv: channel.Surface.BotTokenEnv,
			}
		}
		channels = append(channels, tc)
	}
	return channels
}

func repoRootForRuntimeDefaults() string {
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return "."
}

func isDefaultChannelState(channels []teamChannel) bool {
	defaults := defaultTeamChannels()
	if len(channels) != len(defaults) {
		return false
	}
	for i := range defaults {
		if channels[i].Slug != defaults[i].Slug || channels[i].Name != defaults[i].Name || channels[i].Description != defaults[i].Description {
			return false
		}
		if strings.Join(channels[i].Members, ",") != strings.Join(defaults[i].Members, ",") {
			return false
		}
		if strings.Join(channels[i].Disabled, ",") != strings.Join(defaults[i].Disabled, ",") {
			return false
		}
	}
	return true
}

func isDefaultOfficeMemberState(members []officeMember) bool {
	defaults := defaultOfficeMembers()
	if len(members) != len(defaults) {
		return false
	}
	for i := range defaults {
		if members[i].Slug != defaults[i].Slug || members[i].Name != defaults[i].Name || members[i].Role != defaults[i].Role {
			return false
		}
	}
	return true
}

func normalizeChannelSlug(slug string) string {
	slug = strings.ToLower(strings.TrimSpace(slug))
	slug = strings.TrimLeft(slug, "#")
	slug = strings.ReplaceAll(slug, " ", "-")
	// Preserve "__" (DM slug separator) before replacing single underscores.
	const placeholder = "\x00"
	slug = strings.ReplaceAll(slug, "__", placeholder)
	slug = strings.ReplaceAll(slug, "_", "-")
	slug = strings.ReplaceAll(slug, placeholder, "__")
	if slug == "" {
		// KNOWN WART, kept deliberately (2026-08-30). With #general retired
		// this returns the slug of a channel that cannot exist, which fails
		// CLOSED everywhere (lookups miss, access checks deny) but produced
		// "channel not found" at write sites that passed an empty channel.
		// Every known write site is fixed at the caller (see the ~12 "Raw
		// emptiness first" guards, apps.ts, escalation, the kickoff). The
		// honest fix is returning "" and letting callers resolve a home from
		// the actor — but this function has 259 call sites, so that flip is
		// its own audited change, not a drive-by. If you hit a fresh
		// "channel not found" traced here, fix the CALLER to check emptiness
		// before normalising, like the existing guards do.
		return "general"
	}
	return slug
}

func normalizeActorSlug(slug string) string {
	slug = strings.ToLower(strings.TrimSpace(slug))
	slug = strings.ReplaceAll(slug, " ", "-")
	slug = strings.ReplaceAll(slug, "_", "-")
	return slug
}

func (b *Broker) ensureDefaultChannelsLocked() {
	if len(b.channels) == 0 {
		b.channels = defaultTeamChannels()
	} else {
		// #general kill switch, gate 1 of 7. This block re-prepends general to
		// any roster that lacks it, and it runs on every Load — so leaving it
		// ungated would resurrect the channel on the next boot no matter what
		// the other six gates do. It is the single most likely way the whole
		// switch self-heals.
		//
		// DO NOT "simplify" this gate or gate 2 away on the grounds that
		// removing one changes nothing. It was measured: gates 1+2 here and
		// gate 3 in company/manifest.go are each INDEPENDENTLY sufficient to
		// keep general off a fresh boot, so neutering either alone leaves
		// TestGeneralChannelKillSwitchHasNoResurrectionPath green. Only
		// neutering both turns it red. That is deliberate defence in depth
		// against exactly one resurrection, not redundancy to be cleaned up.
		if generalChannelEnabled() {
			hasGeneral := false
			for _, ch := range b.channels {
				if ch.Slug == GeneralChannelSlug {
					hasGeneral = true
					break
				}
			}
			if !hasGeneral {
				for _, def := range defaultTeamChannels() {
					if def.Slug == GeneralChannelSlug {
						b.channels = append([]teamChannel{def}, b.channels...)
						break
					}
				}
			}
		}
		// Merge surface metadata from manifest into existing channels
		// (handles case where state was saved without surfaces by an older binary)
		defaults := defaultTeamChannels()
		for _, def := range defaults {
			if def.Surface == nil {
				continue
			}
			found := false
			for i := range b.channels {
				if b.channels[i].Slug == def.Slug {
					if b.channels[i].Surface == nil {
						b.channels[i].Surface = def.Surface
					}
					found = true
					break
				}
			}
			if !found {
				b.channels = append(b.channels, def)
			}
		}
	}
	// Always seed the "Backup & Migration" system task that owns #general,
	// now that we have guaranteed #general exists.
	b.ensureBackupMigrationTaskLocked()

	// With #general retired, every conversation is a 1:1 DM — so the DMs have
	// to exist, or the roster has nowhere to talk.
	b.ensureBotDMsLocked()
}

// ensureBotDMsLocked gives every roster member a 1:1 DM with the human.
//
// THIS IS THE THING #general WAS BLOCKING ON. The kill switch was threaded
// through seven gates and left off, and flipping it produced a workspace with
// six bots and ZERO channels: a full roster and nowhere to say anything. The
// switch removed the shared room without anyone building what replaces it.
// Measured, not assumed — a fresh broker with generalEnabled=false seeded
// `channels: 0, members: 6`.
//
// A DM per bot is the replacement the product design already calls for:
// "all chats will be in bot DMs, and you can tag a bot in a DM to make
// your bot go consult them and report back". This seeds exactly that.
//
// Idempotent by slug, so it is safe on every Load: an existing DM is left
// completely alone, including its history and its member list.
//
// Runs regardless of the switch. When #general is enabled these DMs sit
// alongside it and nothing is lost; when it is disabled they are the only way
// to reach a bot. Gating this on the switch would mean the DMs appear only
// in the configuration where they are load-bearing, which is the configuration
// least able to survive a bug in this function.
func (b *Broker) ensureBotDMsLocked() {
	if b.channelStore == nil {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, m := range b.members {
		bot := strings.TrimSpace(strings.ToLower(m.Slug))
		if bot == "" || isHumanMessageSender(bot) {
			continue
		}
		slug := channel.DirectSlug("human", bot)
		if b.findChannelLocked(slug) != nil {
			continue // already there; never touch an existing conversation
		}
		if _, err := b.channelStore.GetOrCreateDirect("human", bot); err != nil {
			// Degrade rather than fail the boot: one unseedable DM must not
			// stop the office from starting.
			log.Printf("seed: could not create DM with %s: %v", bot, err)
			continue
		}
		b.channels = append(b.channels, teamChannel{
			Slug:        slug,
			Name:        m.Name,
			Type:        "dm",
			Description: "Direct messages with " + bot,
			Members:     []string{"human", bot},
			CreatedBy:   "system",
			CreatedAt:   now,
			UpdatedAt:   now,
		})
	}
}

// ensureDefaultOfficeMembersLocked seeds the DefaultManifest roster ONLY when
// no members exist. Prior implementation appended any missing default slug to
// a non-empty roster, which caused ceo/planner/executor/reviewer to leak back
// into blueprint-seeded teams (e.g. niche-crm) on every Broker.Load(). The
// function is called from broker init and post-load normalization as a true
// recovery hook: if state was corrupted or never seeded, fall back to defaults.
func (b *Broker) ensureDefaultOfficeMembersLocked() {
	if len(b.members) > 0 {
		return
	}
	// An onboarded office with zero members is intentional, not corrupted:
	// since the packs/CEO removal, bots are user-created and a fresh office
	// starts empty. Only an office that never finished onboarding gets the
	// recovery roster.
	if s, err := onboarding.Load(); err == nil && s != nil && strings.TrimSpace(s.CompletedAt) != "" {
		return
	}
	b.members = defaultOfficeMembers()
}

func (b *Broker) normalizeLoadedStateLocked() {
	b.sessionMode = NormalizeSessionMode(b.sessionMode)
	b.oneOnOneBot = NormalizeOneOnOneBot(b.oneOnOneBot)
	if b.findMemberLocked(b.oneOnOneBot) == nil {
		b.oneOnOneBot = DefaultOneOnOneBot
	}
	seenMembers := make(map[string]struct{}, len(b.members))
	normalizedMembers := make([]officeMember, 0, len(b.members))
	for _, member := range b.members {
		// A member slug is an ACTOR slug. This is the WRITE half of a pair
		// whose READ half is findMemberLocked (broker_indexes.go) — the two
		// must use the same normaliser or a member that exists is never found.
		//
		// Emptiness is tested on the raw value: normalizeChannelSlug returned
		// "general" for a blank slug, so the `continue` below never fired and a
		// slugless member was silently persisted under the name of a CHANNEL.
		//
		// This value is PERSISTED. Existing rosters were normalised with the
		// channel normaliser, and the two normalisers agree on every ordinary
		// bot slug (lowercase, hyphenated), so this load-path rewrite is a
		// no-op for real data. It would only rewrite a slug containing "__" or
		// a leading "#", which operationSlug cannot produce.
		if strings.TrimSpace(member.Slug) == "" {
			continue
		}
		member.Slug = normalizeChannelSlug(member.Slug)
		if _, ok := seenMembers[member.Slug]; ok {
			continue
		}
		seenMembers[member.Slug] = struct{}{}
		member.Name = strings.TrimSpace(member.Name)
		if member.Name == "" {
			member.Name = humanizeSlug(member.Slug)
		}
		member.Role = strings.TrimSpace(member.Role)
		if member.Role == "" {
			member.Role = member.Name
		}
		// Only the lead is built-in now. A legacy librarian or app-builder on
		// disk becomes an ordinary, removable member: with the bots retired
		// as defaults, pinning them undeletable would strand users with two
		// bots the product no longer defines.
		member.BuiltIn = member.Slug == "ceo"
		// A built-in's display name is owned by the code, not by the saved
		// roster. Renaming the Librarian to "Pam the librarian" changed the
		// constant, but every office already on disk kept the old name — the
		// rename only reached brand-new workspaces, which is the least useful
		// place for it. A built-in is not a user-editable member, so its name
		// is reconciled on load like its BuiltIn flag directly above.
		if isLibrarianSlug(member.Slug) {
			member.Name = librarianName
		}
		// Same treatment for the lead: "Chief of Staff" became "Chief of Staff", and
		// without this the rename would only ever reach brand-new workspaces.
		if member.Slug == "ceo" {
			member.Name = company.ChiefOfStaffName()
			member.Role = company.ChiefOfStaffRole()
		}
		member.Expertise = normalizeStringList(member.Expertise)
		member.AllowedTools = normalizeStringList(member.AllowedTools)
		normalizedMembers = append(normalizedMembers, member)
	}
	// Phase 6 migration: the Librarian (Pam) is a built-in bot like the CEO,
	// added to every NEW workspace at seed time. Existing rosters loaded from
	// disk predate her, and ensureDefaultOfficeMembersLocked only seeds when the
	// roster is empty — so append her here on every load. Idempotent (no-op once
	// present); the BuiltIn line above keeps her flag set on subsequent loads.
	// No back-fill. The load path used to append the Librarian and App Builder
	// to any non-empty roster ("legacy-safe migration"), which is precisely how
	// the founder's removal of both bots kept undoing itself: the seed edit
	// was real, and this line resurrected them on the next boot. Existing
	// members already on disk load unchanged — the migration's data-safety half
	// — but nothing is ever appended.
	b.members = normalizedMembers
	b.ensureSystemSkillsLocked()
	for i := range b.channels {
		b.channels[i].Slug = normalizeChannelSlug(b.channels[i].Slug)
		if strings.TrimSpace(b.channels[i].Name) == "" {
			b.channels[i].Name = b.channels[i].Slug
		}
		if strings.TrimSpace(b.channels[i].Description) == "" {
			b.channels[i].Description = defaultTeamChannelDescription(b.channels[i].Slug, b.channels[i].Name)
		}
		if b.channels[i].Slug == "general" && len(b.channels[i].Members) < len(b.members) {
			// Re-populate general channel with all office members.
			// This fixes stale state where only CEO survived a previous normalization.
			allSlugs := make([]string, 0, len(b.members))
			for _, m := range b.members {
				allSlugs = append(allSlugs, m.Slug)
			}
			b.channels[i].Members = allSlugs
		}
		// A DM's membership is its ACCESS CONTROL LIST, not a roster view.
		// canAccessChannelLocked authorizes a bot by membership alone, so
		// anything added here is granted read AND post on that conversation.
		//
		// Two bugs lived in this block, both invisible until #general was
		// switched off and DMs became the only surface:
		//
		//  1. The filter below drops any slug that is not a roster member.
		//     "human" is not a bot, so it was stripped from every DM --
		//     the one participant who is always a party to it.
		//  2. The CEO pin below prepended "ceo" to EVERY channel, DMs
		//     included. Measured before this fix:
		//         app-builder__human members = [ceo app-builder]
		//         canAccess(ceo, app-builder__human) = true
		//     The blanket read the CEO/Librarian/App-Builder bypasses were
		//     deliberately removed for (see broker_channel_access.go) was
		//     handed straight back through the seed. The access check was
		//     never wrong; its input was.
		//
		// So DMs keep exactly their two participants and skip the pin. The
		// CEO still routes work and consults specialists -- by DMing them,
		// not by sitting inside their conversations.
		isDM := b.channels[i].Type == "dm" || IsDMSlug(b.channels[i].Slug)
		filteredMembers := make([]string, 0, len(b.channels[i].Members))
		for _, slug := range uniqueSlugs(b.channels[i].Members) {
			if isHumanMessageSender(slug) || b.findMemberLocked(slug) != nil {
				filteredMembers = append(filteredMembers, slug)
			}
		}
		// The CEO pin only applies when a ceo member actually exists — since
		// the packs/CEO removal an office may have no CEO at all, and pinning
		// the slug into channel membership renders a ghost participant.
		channelSeed := filteredMembers
		if !isDM && b.findMemberLocked("ceo") != nil {
			channelSeed = append([]string{"ceo"}, filteredMembers...)
		}
		b.channels[i].Members = uniqueSlugs(channelSeed)
		filteredDisabled := make([]string, 0, len(b.channels[i].Disabled))
		for _, slug := range uniqueSlugs(b.channels[i].Disabled) {
			if slug == "ceo" {
				continue
			}
			if b.findMemberLocked(slug) != nil && containsString(b.channels[i].Members, slug) {
				filteredDisabled = append(filteredDisabled, slug)
			}
		}
		b.channels[i].Disabled = filteredDisabled
	}
	for i := range b.messages {
		if strings.TrimSpace(b.messages[i].Channel) == "" {
			b.messages[i].Channel = "general"
		}
	}
	for i := range b.incidents {
		incChannel := normalizeChannelSlug(channel.MigrateDMSlugString(b.incidents[i].Channel))
		if incChannel == "" {
			incChannel = "general"
		}
		b.incidents[i].Channel = incChannel
		if strings.TrimSpace(b.incidents[i].UpdatedAt) == "" {
			b.incidents[i].UpdatedAt = b.incidents[i].CreatedAt
		}
		if b.incidents[i].Count <= 0 {
			b.incidents[i].Count = 1
		}
	}
	// #general kill switch, load-path gate. preferredTaskChannelLocked can now
	// legitimately give a task NO channel (an unowned intake task has no
	// conversation home yet), and this backfill would have rewritten every one
	// of them to "general" on the next Load — quietly undoing the resolver and
	// making "empty" a state that cannot survive a restart. Gated rather than
	// removed so the backfill still heals genuinely channel-less legacy tasks
	// while the shared room exists.
	if generalChannelEnabled() {
		for i := range b.tasks {
			if strings.TrimSpace(b.tasks[i].Channel) == "" {
				b.tasks[i].Channel = GeneralChannelSlug
			}
		}
	}
	// Heal task channels missing their own task's owner. A workspace seeded
	// before the App Builder was registered minted its first build channel
	// with no bot member, so every streamed build post bounced with
	// "channel access denied" (2026-08-16 fresh-workspace QA). The owner is
	// only added when it is a registered member now.
	ownerByChannel := make(map[string]string, len(b.tasks))
	for i := range b.tasks {
		if owner := normalizeActorSlug(b.tasks[i].Owner); owner != "" {
			ownerByChannel[normalizeChannelSlug(b.tasks[i].Channel)] = owner
		}
	}
	for i := range b.channels {
		if strings.TrimSpace(b.channels[i].TaskID) == "" {
			continue
		}
		owner := ownerByChannel[b.channels[i].Slug]
		if owner == "" || owner == "ceo" || isHumanMessageSender(owner) ||
			b.findMemberLocked(owner) == nil ||
			containsString(b.channels[i].Members, owner) {
			continue
		}
		b.channels[i].Members = uniqueSlugs(append(b.channels[i].Members, owner))
	}
	for i := range b.requests {
		if strings.TrimSpace(b.requests[i].Channel) == "" {
			b.requests[i].Channel = "general"
		}
		if strings.TrimSpace(b.requests[i].Kind) == "" {
			b.requests[i].Kind = "choice"
		}
		// core-loop R5 migration: the skill-proposal and skill-enable
		// approval flows were removed. A pending card of either kind would
		// render an Accept/Enable button with no effect behind it (the
		// dead-Accept surface) — cancel them on load instead.
		if kind := strings.TrimSpace(b.requests[i].Kind); kind == "skill_proposal" || kind == "skill_enable_request" {
			if b.requests[i].Answered == nil && b.requests[i].Status != "canceled" {
				b.requests[i].Status = "canceled"
				b.requests[i].UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			}
		}
		if strings.TrimSpace(b.requests[i].Status) == "" {
			if b.requests[i].Answered != nil {
				b.requests[i].Status = "answered"
			} else {
				b.requests[i].Status = "pending"
			}
		}
		if requestIsHumanInterview(b.requests[i]) {
			b.requests[i].Blocking = false
			b.requests[i].Required = false
		}
		if strings.TrimSpace(b.requests[i].UpdatedAt) == "" {
			b.requests[i].UpdatedAt = b.requests[i].CreatedAt
		}
		b.scheduleRequestLifecycleLocked(&b.requests[i])
	}
	for i := range b.tasks {
		normalizeTaskPlan(&b.tasks[i])
		syncTaskMemoryWorkflow(&b.tasks[i], "")
		b.ensureTaskOwnerChannelMembershipLocked(b.tasks[i].Channel, b.tasks[i].Owner)
		b.queueTaskBehindActiveOwnerLaneLocked(&b.tasks[i])
		b.scheduleTaskLifecycleLocked(&b.tasks[i])
		_ = b.syncTaskWorktreeLocked(&b.tasks[i])
	}
	b.reconcileOrphanedBlockedTasksLocked()
	b.reconcileSharedTaskChannelsLocked()
	b.pendingInterview = firstBlockingRequest(b.requests)
}

// reconcileSharedTaskChannelsLocked re-homes tasks that are squatting in
// another task's dedicated per-task channel. Before the channel-minting fix,
// a top-level Issue created from inside an existing Issue's chat inherited that
// chat's channel, so several tasks could share one task-<id> channel (e.g.
// OFFICE-28 sitting in OFFICE-22's "task-office-22"). This one-shot migration
// gives each squatter its own task-<childID> channel going forward.
//
// A channel "belongs" to the task whose ID equals its linked TaskID. A task
// whose Channel is a per-task channel owned by a DIFFERENT task is re-homed;
// the task that legitimately owns the channel, tasks in #general, and tasks in
// non-per-task shared channels (no TaskID — project/bridged channels) are left
// alone. System and incident tasks legitimately live in #general and are
// skipped. Historical messages stay in the old channel — only the task→channel
// link moves, so new activity lands in the task's own chat.
//
// Idempotent: after the first pass each re-homed task owns its new channel
// (TaskID == its own ID), so a second pass finds nothing to move. Caller must
// hold b.mu. Runs once per broker boot from normalizeLoadedStateLocked.
func (b *Broker) reconcileSharedTaskChannelsLocked() {
	for i := range b.tasks {
		t := &b.tasks[i]
		if t.System || strings.TrimSpace(t.PipelineID) == "incident" {
			continue
		}
		ch := b.findChannelLocked(t.Channel)
		if ch == nil {
			continue
		}
		owner := strings.TrimSpace(ch.TaskID)
		// Not a per-task channel (general / project / bridged), or this task
		// already owns it — nothing to do.
		if owner == "" || owner == strings.TrimSpace(t.ID) {
			continue
		}
		// Squatting in another task's channel — mint its own and move the link.
		newCh := b.createPerTaskChannelLocked(t.ID, t.Title, t.Owner, "system")
		if newCh == nil {
			// createPerTaskChannelLocked logs the failure; leave the task in the
			// shared channel rather than dropping it somewhere worse.
			continue
		}
		old := t.Channel
		t.Channel = newCh.Slug
		t.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		b.appendActionLocked("task_rehomed", "office", newCh.Slug, "system",
			truncateSummary("Moved out of shared channel "+old+" into its own", 140), t.ID)
	}
}

// reconcileOrphanedBlockedTasksLocked unblocks tasks whose dependencies
// have all reached a terminal status (done/completed/canceled/cancelled)
// but who never received the unblock notification because the parent
// terminated under the pre-fix semantics where only Status="done" fired
// unblockDependentsLocked. This is a one-shot migration: tasks blocked
// by a still-active dependency are left alone. Idempotent — running it
// twice has no effect since the second pass finds nothing blocked.
//
// Caller must hold b.mu. Called from normalizeLoadedStateLocked so it
// runs once per broker boot against persisted state.
func (b *Broker) reconcileOrphanedBlockedTasksLocked() {
	for i := range b.tasks {
		t := &b.tasks[i]
		if !t.blocked || t.status != "blocked" {
			continue
		}
		if b.hasUnresolvedDepsLocked(t) {
			continue
		}
		t.blocked = false
		t.status = "in_progress"
		t.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		b.appendActionLocked("task_unblocked", "office", t.Channel, "system",
			truncateSummary("Reconciled: parent dep terminated while task was blocked", 140), t.ID)
	}
}
