package team

import "time"

// Hardening for bot↔bot pair DMs — the channels behind the consult
// relay (broker_consult_relay.go). The relay makes those conversations
// observable; this file makes them safe:
//
//   - guardBotDMPostLocked keeps the pair thread writable only by its
//     two member bots. The human observes through the consult markers'
//     read-only view; a human post would put words into a conversation
//     the markers present as bot-to-bot.
//   - BotDMWakeAllowed caps partner wakes per DM window so two bots
//     cannot ping-pong each other forever. Structural loop protection,
//     not prompt-level hope: past the cap the message still lands, only
//     the wake is suppressed until the window rolls over.

const (
	botDMWakeWindow = 30 * time.Minute
	botDMWakeCap    = 6
)

// guardBotDMPostLocked enforces the pair DM's write rules. Returns a
// non-empty rejection reason when `from` may not post into `channel`;
// "" for non-pair channels and for the two member bots. Callers must
// hold b.mu and have resolved channel to its canonical slug.
func (b *Broker) guardBotDMPostLocked(channel, from string) string {
	x, y, ok := isBotToBotDM(channel)
	if !ok {
		return ""
	}
	sender := normalizeActorSlug(from)
	if isHumanMessageSender(sender) {
		return "bot DMs are observer-only for humans; open the thread from its consult marker instead"
	}
	if sender != normalizeActorSlug(x) && sender != normalizeActorSlug(y) {
		return "bot DM is limited to its two members"
	}
	return ""
}

// BotDMWakeAllowed reports whether a message in `channel` may wake the
// DM partner, and records the wake against the per-DM cap when it may.
// Always true for channels that are not bot↔bot pair DMs.
func (b *Broker) BotDMWakeAllowed(channel string) bool {
	if _, _, ok := isBotToBotDM(channel); !ok {
		return true
	}
	slug := normalizeChannelSlug(channel)
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if b.botDMWakes == nil {
		b.botDMWakes = make(map[string][]time.Time)
	}
	recent := b.botDMWakes[slug][:0]
	for _, at := range b.botDMWakes[slug] {
		if now.Sub(at) <= botDMWakeWindow {
			recent = append(recent, at)
		}
	}
	if len(recent) >= botDMWakeCap {
		b.botDMWakes[slug] = recent
		return false
	}
	b.botDMWakes[slug] = append(recent, now)
	return true
}
