package team

import (
	"errors"
	"fmt"
	"strings"

	"github.com/nex-crm/wuphf/internal/channel"
)

// The broker-facing face of the #general kill switch.
//
// Shape borrowed from shouldMintPerTaskChannel (broker_tasks_worktrees.go):
// keep the function, keep every call site, return a constant, and put the
// rationale in the doc comment. That is this tree's proven way to switch a
// behaviour off reversibly — the callers keep their fallback branch, so
// flipping the constant back restores the old behaviour without re-threading
// anything.
//
// The actual boolean lives in internal/channel (see general.go there), because
// internal/company and internal/operations also mint #general and cannot
// import internal/team without a cycle. This file is where broker code should
// look; internal/channel is where the switch physically is.
//
// CREATE / ROUTE / LIST only. Nothing here deletes. #general's persisted
// channel row, its messages, and the task-general system task stay on disk,
// and the archive guard at broker_migration_channels.go:73 that keeps
// general's history out of the fold stays exactly as it is.

// GeneralChannelSlug is the slug of the shared #general channel.
const GeneralChannelSlug = channel.GeneralSlug

// ErrNoHomeChannel is returned by homeChannelForLocked when #general is switched off
// and the actor cannot be resolved to a roster member, so there is no DM to
// route to either. It is deliberately an error and not a fallback slug: a
// fallback would be a channel nobody reads, which is the "leak" the founder
// asked us to prevent. Callers must surface it, not swallow it.
var ErrNoHomeChannel = errors.New("team: no home channel for actor")

// generalChannelEnabled reports whether #general may be created, routed to, or
// listed. THE flip for the kill switch; see internal/channel/general.go for
// why #general is going away, why it is a switch rather than a delete, and how
// to revive it (change the constant there, or gate it on an env var following
// internal/team/governor.go:109).
//
// Returns true today. This stage threads the seam through every resurrection
// point without changing behaviour.
func generalChannelEnabled() bool {
	return channel.GeneralEnabled()
}

// strictChannelWrites reports whether a write addressed to a channel that does
// not exist should fail loudly instead of being quietly redirected.
//
// It is the inverse of generalChannelEnabled, and that is not a coincidence:
// while #general exists it is the universal fallback, so a misaddressed write
// always has somewhere to land and silently landing there is tolerable. Once
// #general is gone that same silence becomes a dropped message, so writes have
// to start failing where they used to fall through.
//
// Unused at this stage by design — a later stage turns the write paths strict.
// Kept here so the switch and its consequence live together and cannot drift.
func strictChannelWrites() bool {
	return !generalChannelEnabled()
}

// groupDMsEnabled reports whether a group DM may be created, routed to, or
// listed. A SEPARATE switch from generalChannelEnabled, on purpose: reviving
// the shared room and reviving multi-bot DMs are two different product
// decisions, so they get two constants.
//
// A group DM is a channel by another name — internal/channel/types.go
// documents ChannelTypeGroup as "Group DMs (human + N bots)", which is the
// same several-bots-in-one-room shape #general is being retired to stop.
// Left alive, it becomes the new #general within a week.
//
// The point of DM-first is that every conversation has exactly two
// participants, so the human can follow it. Tagging another bot inside a DM
// sends the bot you are talking to off to consult them and report back; it
// does not pull them into the room.
//
// Create / route / list only, same as general: existing group rows still load
// and read, so nothing on disk becomes unreachable. See
// internal/channel/general.go for the switch and the revival routes.
//
// Returns true today.
func groupDMsEnabled() bool {
	return channel.GroupDMsEnabled()
}

// isGroupDM reports whether a channel is a multi-participant DM rather than a
// 1:1 one.
//
// Two independent signals, because a group row can be identified by either:
// its slug is a GroupSlug hash, so it names no single partner bot (unlike
// "human__ceo" or the legacy "dm-ceo"); and it carries more than two members.
// Checking both catches a row whose members drifted as well as one whose slug
// did, and the member count is the direct expression of the rule that matters
// — three or more participants in one conversation is the thing being retired.
func (ch *teamChannel) isGroupDM() bool {
	if !ch.isDM() {
		return false
	}
	return DMTargetBot(ch.Slug) == "" || len(ch.Members) > 2
}

// namedChannelsEnabled reports whether an ordinary named channel may be
// created, routed to, or listed. A THIRD independent switch, alongside
// generalChannelEnabled and groupDMsEnabled.
//
// Read internal/channel/general.go for the caveat that matters here: unlike the
// other two, this retirement was INFERRED from the founder's stated model
// rather than asked for by name. It is the one most likely to be flipped back,
// so it stays independently revivable.
//
// Scope: blueprint-seeded rooms (#product, #gtm), synthesis rooms (#planning,
// #execution, #review, #integrations), and open channel creation. NOT the Slack
// or Telegram bridges (those are how external messages arrive, not rooms bots
// chat in) and NOT app-<id> edit threads (hidden plumbing, load-bearing).
//
// Returns true today.
func namedChannelsEnabled() bool {
	return channel.NamedChannelsEnabled()
}

// ErrNamedChannelsRetired is returned when a caller tries to mint an ordinary
// named channel while they are switched off. An error, never a silent skip:
// a caller that asked for a room and got nothing back must find out.
var ErrNamedChannelsRetired = errors.New("team: named channels are retired; conversations happen in bot DMs")

// homeChannelFor is the lock-taking wrapper around homeChannelForLocked, for
// callers that do not already hold b.mu — HTTP handlers, mostly. Mirrors the
// hasMember / findMemberLocked pairing in broker_indexes.go.
//
// The bare name belongs to this one and the Locked suffix to the other, which
// is the convention doing its job: the boundary sites that need this are
// exactly the ones that would deadlock or race on the Locked variant, and the
// name is what tells them apart at the call site.
func (b *Broker) homeChannelFor(actorSlug string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.homeChannelForLocked(actorSlug)
}

// bucketChannelKey normalises a channel slug for GROUPING and COMPARISON —
// deciding whether two records live in the same conversation — and maps the
// absent channel to "" rather than to a room.
//
// It is deliberately not normalizeChannelSlug, whose empty case returns
// "general". That laundering is invisible and self-consistent, which is exactly
// what made it dangerous: every "same channel?" test in the tree silently
// agreed that "no channel" meant the shared room, so channel-less records
// gated, filtered, and deduped against a room that no longer exists. Records
// with no channel are their own bucket. They are not in #general.
func bucketChannelKey(slug string) string {
	if raw := strings.TrimSpace(slug); raw != "" {
		return normalizeChannelSlug(raw)
	}
	return ""
}

// homeChannelForWriter returns the home channel of the first candidate that
// both resolves to a roster member AND that `writer` is allowed to post in.
// ErrNoHomeChannel if none qualify.
//
// It exists because "who does this belong to?" often has more than one honest
// answer, ranked. A task has an OWNER (the bot that will do the work) and a
// CREATOR (frequently "human", who is not on the roster and therefore has no
// DM at all). Asking about the creator alone means a human-created task can
// never find a home, even though the owner's DM was sitting right there — the
// bug that made every human-initiated task create fail once #general was
// retired.
//
// The access check is the half that is easy to miss, and leaving it out
// produces a worse failure than the one being fixed. A DM has exactly two
// participants, so when the CEO opens a task owned by the planner, the
// planner's DM is a room the CEO may not write to — routing there would turn a
// working create into "channel access denied". Checking here means the CEO's
// task lands in the CEO's own DM, which is where the human is actually having
// that conversation. The human passes every check, so a human-created task
// still lands on its owner.
//
// Empty, unresolvable, and inaccessible candidates are all skipped rather than
// treated as failures, so a caller can pass a field it is not sure is populated
// without a nil-check dance.
//
// Takes b.mu, like homeChannelFor. Never returns a fallback slug. Callers that
// already hold the lock want homeChannelForWriterLocked.
func (b *Broker) homeChannelForWriter(writer string, candidates ...string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.homeChannelForWriterLocked(writer, candidates...)
}

// homeChannelForWriterLocked is homeChannelForWriter for callers already
// holding b.mu. Same bare-name / Locked-suffix pairing as homeChannelFor and
// findMemberLocked elsewhere in this package.
func (b *Broker) homeChannelForWriterLocked(writer string, candidates ...string) (string, error) {
	for _, actor := range candidates {
		if strings.TrimSpace(actor) == "" {
			continue
		}
		home, err := b.homeChannelForLocked(actor)
		if err != nil {
			continue
		}
		if !b.canAccessChannelLocked(writer, home) {
			continue
		}
		return home, nil
	}
	return "", fmt.Errorf("%w: none of %v give %q a home it can post in",
		ErrNoHomeChannel, candidates, writer)
}

// homeChannelForLocked resolves the channel an actor's work belongs in when no
// explicit channel was given. It is the no-leak replacement for the
// `if channel == "" { channel = "general" }` fallback that is currently spread
// across the write paths.
//
// Exactly three outcomes, and deliberately no fourth:
//
//  1. #general is enabled            -> GeneralChannelSlug, as today.
//  2. Disabled, actor is on the roster -> that bot's DM, created if missing.
//  3. Disabled, actor does not resolve -> ErrNoHomeChannel.
//
// The third outcome is the point. Returning some default slug for an
// unresolvable actor would put messages in a channel nobody reads, which is
// exactly the leak this switch exists to prevent. A caller that cannot name a
// real recipient must fail rather than invent one.
//
// Caller MUST hold b.mu: this reads the roster and may append to b.channels
// via ensureDMConversationLocked.
func (b *Broker) homeChannelForLocked(actorSlug string) (string, error) {
	if generalChannelEnabled() {
		return GeneralChannelSlug, nil
	}

	slug := normalizeActorSlug(actorSlug)
	if slug == "" {
		return "", fmt.Errorf("%w: empty actor", ErrNoHomeChannel)
	}
	if b.findMemberLocked(slug) == nil {
		return "", fmt.Errorf("%w: %q is not a roster member", ErrNoHomeChannel, slug)
	}

	dmSlug := DMSlugFor(slug)
	if dmSlug == "" {
		return "", fmt.Errorf("%w: no DM slug for %q", ErrNoHomeChannel, slug)
	}
	// ensureDMConversationLocked may rewrite the slug to the canonical
	// pair-sorted form when the channel store is live, so trust what it
	// returns over what we computed.
	ch := b.ensureDMConversationLocked(dmSlug)
	if ch == nil {
		return "", fmt.Errorf("%w: could not open a DM with %q", ErrNoHomeChannel, slug)
	}
	return ch.Slug, nil
}
