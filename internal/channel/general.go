// internal/channel/general.go
package channel

import "errors"

// The #general kill switch lives here, in the leaf package, for one reason:
// three packages have to agree on it and they cannot all import each other.
// `internal/team` imports `internal/company` and `internal/operations`, so the
// switch cannot live in `team` — the other two would need a back-import and Go
// would reject the cycle. `internal/channel` already owns channel slug
// semantics (see DirectSlug) and imports nothing but the standard library, so
// every package that mints a channel can reach it.
//
// `internal/team/channels_general.go` is the broker-facing face of this file:
// it re-exports GeneralSlug as GeneralChannelSlug, wraps GeneralEnabled as
// generalChannelEnabled, and adds the broker-only router homeChannelForLocked. Read
// that file for the product rationale; this one is the mechanism.

// GeneralSlug is the slug of the shared #general channel. Declared once so the
// slug is greppable in a single place rather than as a bare "general" literal
// scattered across the seed, manifest, and synthesis paths.
const GeneralSlug = "general"

// GeneralEnabled reports whether #general may be created, routed to, or
// listed. It is THE flip for the whole kill switch: every gate in every
// package funnels through this one return.
//
// Why #general is going away: the product is moving to per-bot DMs. A human
// talks to exactly one bot at a time, 1:1. Tagging another bot inside that
// DM makes the bot you are talking to go consult the tagged bot and report
// back; the tagged bot does not walk into your conversation. A shared room
// undercuts that model — it re-creates the many-to-many surface the DM design
// exists to replace, and it gives every write path a silent dumping ground to
// fall back to.
//
// Why it is a switch and not a delete: the founder asked for exactly this —
// "keep the code for general so that we can bring it back whenever we want but
// right now it should be not functional and no leaks to it". So general's
// persisted channel row, its message history, and the task-general system task
// all stay on disk. Nothing in this kill switch deletes state. Flipping the
// switch back must find the history intact.
//
// How to revive it, in order of preference:
//
//  1. Change the return below to true. That is the whole revival. Every gate
//     reads through here, so one edit restores create, route, and list.
//
//  2. Gate it on an env var instead, following the pattern already in
//     internal/team/governor.go:109 (envTruthy over WUPHF_GOVERNOR_ENABLED):
//
//     func GeneralEnabled() bool {
//     return envTruthy(os.Getenv("WUPHF_GENERAL_CHANNEL_ENABLED"))
//     }
//
//     Prefer this only if general has to be revivable per-workspace at
//     runtime. A constant is easier to reason about and cannot drift between
//     the broker and a subprocess that inherited a different environment.
//
// It returns true today. This stage builds and threads the seam; it does not
// flip it. Behaviour is unchanged until generalEnabled below becomes false.
func GeneralEnabled() bool {
	return generalEnabled
}

// generalEnabled is the switch itself. A package-level var rather than a bare
// `return true` for exactly one reason: the test that proves all the gates are
// threaded has to flip it and re-run a full Load cycle. Treat it as a
// constant in production code — nothing outside SetGeneralEnabledForTest may
// assign to it.
var generalEnabled = false

// SetGeneralEnabledForTest flips the switch and returns a restore function.
// Test-only; production code reads GeneralEnabled and never writes.
//
// It exists because the gates live in three packages (channel, company,
// operations, plus team) and the test that proves none of them resurrect
// #general has to drive them all from outside. Callers must defer the
// returned restore, or they leak the flip into every later test in the
// binary — package-level state is shared across a package's whole test run.
func SetGeneralEnabledForTest(enabled bool) (restore func()) {
	previous := generalEnabled
	generalEnabled = enabled
	return func() { generalEnabled = previous }
}

// ─── Group DMs ───────────────────────────────────────────────────────────────
//
// The second half of the same retirement, kept beside the first because it is
// the same mechanism serving the same end state — but on its own constant, so
// the two can be revived independently.

// ErrGroupDMsDisabled is returned by Store.GetOrCreateGroup while group DMs are
// switched off. Callers get an error rather than a nil channel: a silent nil
// would read as "nothing to do" and let a caller carry on as though the
// conversation surface existed.
var ErrGroupDMsDisabled = errors.New("channel: group DMs are disabled")

// GroupDMsEnabled reports whether a group DM may be created, routed to, or
// listed. Separate from GeneralEnabled on purpose: bringing back the shared
// room and bringing back multi-bot DMs are two different product decisions.
//
// Why group DMs are going away, in the founder's terms: a group DM is a
// channel by another name. ChannelTypeGroup is documented right here in
// types.go as "Group DMs (human + N bots)" — several bots in one room,
// which is precisely the shape #general is being retired to stop. Left alive
// it becomes the new #general within a week.
//
// The point of DM-first is that every conversation has exactly two
// participants, so the human can actually follow it. Tagging another bot
// inside a DM makes the bot you are talking to go consult that bot and
// report back; it does not pull them into the room. Bot-to-bot 1:1 DMs
// stay as a MECHANISM for exactly that consult, but they are not rooms the
// human hangs out in.
//
// Same create/route/list-not-delete rule as GeneralEnabled: existing group
// rows must still load and read, so nothing already on disk becomes
// unreachable and a revive finds it intact. ChannelTypeGroup itself,
// migration.go's type check, and message.go's mention fan-out are deliberately
// NOT gated for that reason.
//
// Revive the same two ways as GeneralEnabled: flip the constant below, or gate
// it on an env var following internal/team/governor.go:109.
//
// Returns true today. This stage threads the seam; it does not flip it.
func GroupDMsEnabled() bool {
	return groupDMsEnabled
}

// groupDMsEnabled is the switch itself. See generalEnabled for why this is a
// var rather than a bare return: the test that proves the gates hold has to
// flip it. Treat it as a constant in production code.
var groupDMsEnabled = false

// SetGroupDMsEnabledForTest flips the switch and returns a restore function.
// Test-only; production code reads GroupDMsEnabled and never writes. Callers
// must defer the restore — the var is shared across the whole test binary.
func SetGroupDMsEnabledForTest(enabled bool) (restore func()) {
	previous := groupDMsEnabled
	groupDMsEnabled = enabled
	return func() { groupDMsEnabled = previous }
}

// ─── Named channels ──────────────────────────────────────────────────────────
//
// The third and last of the conversation-surface retirements, on its own
// constant like the other two.

// NamedChannelsEnabled reports whether an ordinary named channel — #product,
// #planning, anything a blueprint seeds or a human creates — may be created,
// routed to, or listed.
//
// This one carries a caveat the other two do not, and it belongs in the code
// rather than in a review thread. The founder retired #general and group DMs by
// NAME. He did not say this sentence about named channels. The retirement is
// inferred from the stated model — "all chats will be in bot DMs", and "even
// group DMs should be retired because they are essentially channels" — on the
// reasoning that a #product room is the same object as a group DM wearing a
// different label. That inference is the team lead's call, made explicitly and
// on the record, precisely because it is a step beyond what was asked for.
//
// So this switch matters more than the other two: it is the one most likely to
// be flipped back. Keep it independently revivable, and do not fold it into
// GeneralEnabled on the grounds that they always move together.
//
// NOT covered by this switch, deliberately:
//   - Slack and Telegram bridge channels. Those are not rooms bots chat in,
//     they are how EXTERNAL messages arrive. Retiring them breaks integrations
//     and has nothing to do with bots piling into a conversation.
//   - app-<id> edit threads. Hidden plumbing, never listed, and load-bearing
//     for apps being editable at all.
//
// Returns true today. This stage threads the seam; it does not flip it.
func NamedChannelsEnabled() bool {
	return namedChannelsEnabled
}

// namedChannelsEnabled is the switch itself. See generalEnabled for why this is
// a var rather than a bare return.
var namedChannelsEnabled = false

// SetNamedChannelsEnabledForTest flips the switch and returns a restore
// function. Test-only; production code reads NamedChannelsEnabled.
func SetNamedChannelsEnabledForTest(enabled bool) (restore func()) {
	previous := namedChannelsEnabled
	namedChannelsEnabled = enabled
	return func() { namedChannelsEnabled = previous }
}
