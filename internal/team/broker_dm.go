package team

import (
	"strings"

	"github.com/nex-crm/wuphf/internal/channel"
)

// Direct-message slug helpers. The broker has two DM slug formats it
// must recognize:
//   - legacy "dm-<bot>" / "dm-human-<bot>"
//   - canonical "<a>__<b>" pair-sorted, owned by channel.DirectSlug
//
// Loading state from disk migrates legacy → canonical (see
// channel.MigrateDMSlugString in broker_persistence.go's loadState),
// but recognition has to handle both. The IsDMSlug + DMTargetBot +
// canonicalDMTargetBot trio makes the dual-format awareness explicit
// in one place.

// DO NOT switch this to normalizeActorSlug.
//
// These are DM CHANNEL slugs, and normalizeChannelSlug's "__" placeholder
// dance exists precisely to preserve the DM separator: "human__ceo" must stay
// "human__ceo". normalizeActorSlug folds a double underscore to "--", which
// would turn every DM slug into a different string and break DM lookup,
// DMTargetBot, and the canonical-slug migration at once.
//
// The wider slug cleanup moved actor-shaped values off the channel normaliser.
// This file is the deliberate exception, in BOTH directions: here the channel
// normaliser is the correct one and the actor normaliser is the dangerous one.
func (ch *teamChannel) isDM() bool {
	return ch.Type == "dm" || IsDMSlug(ch.Slug)
}

// IsDMSlug checks whether a channel slug represents a direct message.
//
// The canonical arm tests the SHAPE of the slug, not who is in it. It used to
// route through canonicalDMTargetBot, which returns "" unless one side is
// the human — so a bot-to-bot pair like "ceo__designer" was not
// recognised as a DM at all and fell through to channel routing. That blocks
// the consult relay: tagging a bot inside your DM sends your bot to talk
// to theirs, which needs bot-to-bot DMs to route like any other DM.
//
// Shape is a safe test because normalizeChannelSlug deliberately preserves
// "__" while collapsing every single "_" to "-" (broker_defaults.go), so a
// normalized slug can only contain "__" if channel.DirectSlug built it.
func IsDMSlug(slug string) bool {
	slug = normalizeChannelSlug(slug)
	if strings.HasPrefix(slug, "dm-") {
		return true
	}
	_, _, ok := canonicalDMPair(slug)
	return ok
}

// DMSlugFor returns the DM channel slug for a given bot.
func DMSlugFor(botSlug string) string {
	botSlug = normalizeActorSlug(botSlug)
	if botSlug == "" {
		return ""
	}
	return channel.DirectSlug("human", botSlug)
}

// DMTargetBot extracts the bot slug from a HUMAN's DM channel slug.
// Returns "" if the slug is not a DM, or if it is a bot-to-bot DM where
// there is no human side to be "the other" of.
//
// Deliberately still human-relative: a dozen call sites mean "the bot the
// human is talking to" by it (notifier delivery, the onboarding CEO-DM check,
// DM channel descriptions). Use DMOtherParticipant when you have a viewer and
// want the participant across from THEM.
func DMTargetBot(slug string) string {
	slug = normalizeChannelSlug(slug)
	if strings.HasPrefix(slug, "dm-human-") {
		return strings.TrimPrefix(slug, "dm-human-")
	}
	if strings.HasPrefix(slug, "dm-") {
		return strings.TrimPrefix(slug, "dm-")
	}
	return canonicalDMTargetBot(slug)
}

// DMPartner returns the bot on the other side of the HUMAN's 1:1 DM
// channel. Returns "" if the channel is not a DM, does not exist, is a group
// DM, or has no human side. Used by surface bridges to resolve who the human
// is talking to when routing DM posts without requiring an @mention.
//
// The no-human case returns "" rather than picking a side. In an
// bot-to-bot DM both members are non-human, and the old "first non-human
// member wins" loop would hand the bridge whichever happened to be stored
// first — a coin flip between two real bots. There is no viewer here to
// resolve against, so the honest answer is "cannot route"; the caller already
// guards on "". Use DMOtherParticipant where a viewer IS known.
func (b *Broker) DMPartner(channelSlug string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := b.findChannelLocked(normalizeChannelSlug(channelSlug))
	if ch == nil || !ch.isDM() {
		return ""
	}
	if len(ch.Members) != 2 {
		return ""
	}
	partner := ""
	humans := 0
	for _, m := range ch.Members {
		if isHumanMessageSender(m) {
			humans++
			continue
		}
		partner = m
	}
	if humans != 1 {
		return ""
	}
	return partner
}

// DMParticipants returns the two sides of a 1:1 DM slug in slug order, for
// both the legacy "dm-…" and canonical "<a>__<b>" formats. ok is false for
// anything that is not a 1:1 DM — a regular channel, or a group DM (which
// hashes its members via channel.GroupSlug and carries no pair to read).
func DMParticipants(slug string) (string, string, bool) {
	slug = normalizeChannelSlug(slug)
	if strings.HasPrefix(slug, "dm-") {
		// Legacy slugs are human<->bot by construction.
		bot := normalizeActorSlug(DMTargetBot(slug))
		if bot == "" {
			return "", "", false
		}
		return "human", bot, true
	}
	return canonicalDMPair(slug)
}

// DMOtherParticipant returns the participant across the DM from viewer.
//
// This is the viewer-relative counterpart to DMTargetBot, and the one to
// reach for when routing: in "ceo__designer" the answer is "designer" to the
// CEO and "ceo" to the designer, which no human-relative lookup can express.
// Returns "" when the slug is not a 1:1 DM, or when viewer is not one of its
// two participants — callers must treat that as "cannot route", not as a
// licence to guess a side.
func DMOtherParticipant(slug, viewer string) string {
	a, b, ok := DMParticipants(slug)
	if !ok {
		return ""
	}
	v := normalizeActorSlug(viewer)
	if v == "" {
		return ""
	}
	// Match the human by identity rather than by string: the human posts under
	// several aliases ("human", "you", "human:<name>"), and any of them sits
	// across from the bot in a human<->bot DM.
	if isHumanMessageSender(viewer) {
		switch {
		case isHumanMessageSender(a):
			return b
		case isHumanMessageSender(b):
			return a
		}
		return ""
	}
	switch v {
	case normalizeActorSlug(a):
		return b
	case normalizeActorSlug(b):
		return a
	}
	return ""
}

// canonicalDMPair splits a canonical "<a>__<b>" slug into its participants.
// Shape only — it says nothing about who the two sides are. ok is false unless
// there are exactly two non-empty parts, so "a__b__c" (not a pair) and
// "__b" (empty side) are both rejected.
func canonicalDMPair(slug string) (string, string, bool) {
	parts := strings.Split(normalizeChannelSlug(slug), "__")
	if len(parts) != 2 {
		return "", "", false
	}
	a := strings.TrimSpace(parts[0])
	b := strings.TrimSpace(parts[1])
	if a == "" || b == "" {
		return "", "", false
	}
	return a, b, true
}

func canonicalDMTargetBot(slug string) string {
	a, b, ok := canonicalDMPair(slug)
	if !ok {
		return ""
	}
	switch {
	case isHumanMessageSender(a):
		return b
	case isHumanMessageSender(b):
		return a
	default:
		return ""
	}
}
