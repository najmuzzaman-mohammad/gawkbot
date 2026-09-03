/**
 * Channel slug helpers.
 *
 * This lives in `lib/` rather than in `stores/app.ts` (where it started)
 * because the API layer needs it too, and `api/*` must not import a zustand
 * store to build a request body. `stores/app.ts` re-exports it, so every
 * existing `import { directChannelSlug } from "../stores/app"` keeps working.
 *
 * There are no shared rooms any more — no #general, no group DMs, no named
 * channels. Every conversation is a 1:1 DM between the human and exactly one
 * bot, so "which channel does this belong in?" is now always answered by
 * naming a BOT. That makes this the canonical answer, and the reason there
 * must be exactly one implementation of the pair-sort: a second one that
 * disagrees about ordering builds a slug the broker cannot find, and the write
 * fails with "channel not found".
 */

/**
 * Build the broker's canonical direct-message channel slug for a bot.
 * The broker pairs `<lower>__<higher>` for stable ordering across sides
 * (Go: `channel.DirectSlug`); we pass `humanSlug="human"` to match what the
 * `/dm` API endpoints expect.
 */
export function directChannelSlug(
  agentSlug: string,
  humanSlug = "human",
): string {
  const a = humanSlug.trim().toLowerCase();
  const b = agentSlug.trim().toLowerCase();
  return a > b ? `${b}__${a}` : `${a}__${b}`;
}

/**
 * The DM channel a bot's work belongs in, or "" when no bot is named.
 *
 * The empty return is the point, and it is why callers should prefer this over
 * calling {@link directChannelSlug} directly on a value that might be blank:
 * `directChannelSlug("")` cheerfully returns `"human__"`, a slug for a bot
 * that does not exist. Returning "" instead lets the caller OMIT the channel
 * field and let the broker resolve a home from the actor — which is what the
 * Go side's `homeChannelFor` does — rather than send a destination that cannot
 * resolve.
 *
 * Never substitutes a default room. There isn't one.
 */
export function botHomeChannel(agentSlug: string | undefined | null): string {
  const slug = (agentSlug ?? "").trim().toLowerCase();
  if (!slug) return "";
  return directChannelSlug(slug);
}
