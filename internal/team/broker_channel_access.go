package team

import (
	"strings"
	"time"
)

// Channel access control: the security boundary that gates message
// publishing. canAccessChannelLocked is the policy decision; the
// supporting predicates (channelHasMemberLocked,
// channelMemberEnabledLocked, enabledChannelMembersLocked) are its
// data lookups. ensureTaskOwnerChannelMembershipLocked is the
// auto-promotion rule that keeps task owners on the channel they
// own work in.
//
// The reservedChannelSlugs invariant — that user-created channels
// cannot shadow a trusted sender slug or a built-in bot slug — is
// co-located here on purpose. The channel-create handler in
// broker_office_channels.go is the call site that must reject any new
// channel whose slug matches.

// reservedChannelSlugs are slug values a user-created channel may not take.
//
// Two distinct reasons, no longer one:
//   - "system", the legacy "nex" automation slug, "you", "human" are
//     universally trusted senders in
//     canAccessChannelLocked. A channel sharing one of those slugs would
//     inherit that trust, letting those senders read every message in it
//     without an explicit Members entry. Keep these in sync with the trust
//     check below.
//   - "ceo", the Librarian, and the App Builder are built-in BOT slugs.
//     They are no longer access bypasses (membership is authoritative for
//     every bot), but a channel that shadows a bot slug still breaks
//     DM slug resolution and @-mention routing, so they stay reserved.
var reservedChannelSlugs = map[string]bool{
	"system":       true,
	"nex":          true,
	"you":          true,
	"human":        true,
	"ceo":          true,
	LibrarianSlug:  true,
	appBuilderSlug: true,
}

func (b *Broker) canAccessChannelLocked(slug, channel string) bool {
	slug = normalizeActorSlug(slug)
	// NO CHANNEL IS NOT A MEMBERSHIP QUESTION.
	//
	// Tested on the RAW argument, before normalising, for the usual reason:
	// normalizeChannelSlug("") returns "general", so a guard after the
	// normalise cannot tell "no channel" from "explicitly #general".
	//
	// A record with no channel is not scoped to a room, so there is no room to
	// be a member of and no room-shaped confidentiality to enforce. Membership
	// is the wrong gate for it; the owner check the callers already run
	// (checkTaskActionAuthLocked and friends) is the right one.
	//
	// Measured, not assumed. Today this returns true on an UPGRADED workspace
	// and false on a FRESH one, purely by accident: #general's row is still on
	// disk after the retirement, broker_defaults.go re-populates its member
	// list with every bot on each Load, and normalizeChannelSlug("") lands
	// the lookup on exactly that row. A fresh workspace has no such row, so
	// findChannelLocked("") is nil and every bot is already denied — which
	// is why channel-less tasks vanish from bot task lists and office stats
	// on a new workspace. Same broker, same code, opposite answer, decided by
	// leftover state. Making it explicit fixes the fresh-workspace bug now and
	// keeps the answer stable when normalizeChannelSlug stops inventing a room.
	//
	// DM privacy is untouched: a DM always has a slug, so it never reaches here.
	if strings.TrimSpace(channel) == "" {
		return true
	}
	channel = normalizeChannelSlug(channel)
	if b.sessionMode == SessionModeOneOnOne {
		if isHumanMessageSender(slug) {
			return true
		}
		return slug == b.oneOnOneBot
	}
	// The human sees everything in their own workspace. "nex" and "system"
	// are synthetic senders rather than bots — broker-authored notices —
	// and are being retired as senders separately; this bypass should go
	// with them.
	//
	// NOTE: any new entry added here MUST also be added to
	// reservedChannelSlugs above so the channel-create handler keeps the
	// invariant "no user channel can shadow a trusted sender slug".
	if isHumanMessageSender(slug) || slug == "nex" || slug == "system" {
		return true
	}
	// A DM admits exactly the two participants its SLUG names — never its
	// stored Members list, which can drift (a member edit through the
	// channel API, a legacy seed pin). There is no path for a third party
	// into a DM: not the lead, not a task owner, not a drifted roster row.
	if a, c, ok := DMParticipants(channel); ok {
		return slug == normalizeActorSlug(a) || slug == normalizeActorSlug(c)
	}
	// Every BOT is gated by membership. There are no org-wide readers: a
	// DM is readable and postable by exactly its two participants, which is
	// the promise the DM packet preamble already makes to the model ("This
	// is a private 1:1 conversation with the human", notification_context.go)
	// and the promise the human is owed. Under DM-first that matters more,
	// not less — when DMs are the main conversation surface, one
	// cross-channel reader is a reader of everything.
	//
	// The CEO, the Librarian (Pam), and the App Builder each used to bypass
	// this. All three are ordinary built-in roster members, seeded at every
	// chokepoint (broker_defaults.go, broker_onboarding.go,
	// broker_onboarding_reseed.go), so membership authorizes them wherever
	// they legitimately belong:
	//   - a channel they own work in, via
	//     ensureTaskOwnerChannelMembershipLocked below
	//   - an app build thread, which seeds the App Builder as a member
	//   - anywhere a human or another bot adds them
	// What they lose is exactly what they should never have had: reading a
	// conversation they are not a party to. The CEO still routes work and
	// consults specialists — by DMing them, not by reading their DMs.
	//
	// This does NOT hide the roster. Who exists and what each bot is good
	// for comes from the AVAILABLE BOTS block, which renders from the
	// member list and never consults channel access
	// (renderAvailableBotsBlock, prompt_builder.go). The directory is
	// public; the conversations are private.
	return b.channelHasMemberLocked(channel, slug)
}

func (b *Broker) channelHasMemberLocked(channel, slug string) bool {
	ch := b.findChannelLocked(channel)
	if ch == nil {
		// Fall back to channelStore for new-format channels (e.g. "eng__human")
		if b.channelStore != nil {
			return b.channelStore.IsMemberBySlug(channel, slug)
		}
		return false
	}
	for _, member := range ch.Members {
		if member == slug {
			return true
		}
	}
	return false
}

func (b *Broker) channelMemberEnabledLocked(channel, slug string) bool {
	if !b.channelHasMemberLocked(channel, slug) {
		return false
	}
	ch := b.findChannelLocked(channel)
	if ch == nil {
		return true
	}
	for _, disabled := range ch.Disabled {
		if disabled == slug {
			return false
		}
	}
	return true
}

func (b *Broker) enabledChannelMembersLocked(channel string, candidates []string) []string {
	var out []string
	for _, candidate := range candidates {
		if b.channelMemberEnabledLocked(channel, candidate) {
			out = append(out, candidate)
		}
	}
	return out
}

// ensureTaskOwnerChannelMembershipLocked auto-promotes a task owner
// onto the channel where the task lives. The auto-promotion lives in
// the channel-access file because it shares the same invariant set:
// "every actor that posts/owns work in a channel must be a Member of
// that channel" (canAccessChannelLocked enforces it from the publish
// side; this helper restores it from the assignment side).
func (b *Broker) ensureTaskOwnerChannelMembershipLocked(channel, owner string) {
	// Emptiness is tested on the RAW arguments, BEFORE normalising, and that
	// order is the whole point — do not "tidy" it back.
	//
	// normalizeChannelSlug("") returns "general". A guard placed AFTER the
	// normalise therefore never fires: "no channel" arrives indistinguishable
	// from "explicitly #general", and a caller that resolved no channel
	// silently adds the task owner as a member of the general room. With
	// #general being retired that is a write into a room nobody is meant to
	// be in. The previous shape looked correct and was dead code.
	if strings.TrimSpace(channel) == "" || strings.TrimSpace(owner) == "" {
		return
	}
	channel = normalizeChannelSlug(channel)
	// owner is an ACTOR slug, not a channel slug, so it takes the actor
	// normaliser — the same one canAccessChannelLocked applies to this value.
	// Two reasons, both load-bearing: membership is then stored under exactly
	// the string the access check looks up (normalizeChannelSlug would diverge
	// on "__" and a leading "#"), and normalizeActorSlug preserves "" instead
	// of laundering it into "general". This is the same trap, and the same
	// fix, as the CreatedBy guard in broker_office_channels.go.
	owner = normalizeActorSlug(owner)
	if b.findMemberLocked(owner) == nil {
		return
	}
	ch := b.findChannelLocked(channel)
	if ch == nil {
		return
	}
	// A human's 1:1 DM has exactly two participants by contract. Promoting
	// a task owner into someone else's DM is how a third bot ended up
	// narrating its work inside the human's private thread with the Chief
	// of Staff; the task is re-homed to a pair DM instead (see
	// reHomeTaskOutOfHumanDMLocked).
	if botSide := humanDMBot(channel); botSide != "" && botSide != owner {
		return
	}
	if !containsString(ch.Members, owner) {
		ch.Members = uniqueSlugs(append(ch.Members, owner))
		ch.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if len(ch.Disabled) > 0 {
		filtered := ch.Disabled[:0]
		for _, disabled := range ch.Disabled {
			if disabled != owner {
				filtered = append(filtered, disabled)
			}
		}
		ch.Disabled = filtered
	}
}
