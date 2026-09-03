/**
 * needsYou — the ONE definition of "how many things are waiting on the human".
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A FUNCTION RATHER THAN A CONVENTION.
 *
 * Three surfaces answer "what needs me?": the runtime strip under the header,
 * the board's Needs-human lane, and the sidebar Tasks badge. They used to
 * compute it three different ways from the same /office/stats payload:
 *
 *   strip  = requests.blocking
 *   lane   = tasks.needs_human + every request/review in the inbox feed
 *   badge  = inbox_attention
 *
 * so the strip could say "all quiet" while the lane said 1 and the badge said
 * 2 — observed live on 2026-08-25, all three on screen at once.
 *
 * Both the strip and the badge carried comments claiming this was impossible:
 * "the strip can never disagree with the board", "consistent ... by
 * construction". Those comments were the fix applied to an EARLIER drift of
 * exactly this shape, and they encoded the wrong lesson from it. Sharing the
 * PAYLOAD does not produce agreement. Sharing the FORMULA does. A comment
 * cannot hold an invariant; a function and a test can, which is what this is.
 *
 * If you are about to compute a "needs you" number inline somewhere: don't.
 * Call this. If it is wrong, fix it here and every surface moves together.
 */

import type { OfficeStats } from "../api/platform";
import type { InboxItemRequest } from "./types/inbox";

/**
 * A notice is an informational request — "task-12 delivered" — rather than
 * something waiting on a decision. The broker marks these `kind: "notice"`
 * (see the delivery notice raised in internal/team, titled "<id> delivered").
 *
 * Matched on the explicit kind rather than inferred from `blocking`, because
 * the wire shape does not carry the broker's `required` flag: a required-but-
 * not-blocking request would be misread as a notice and silently dropped from
 * the one surface that is supposed to catch it.
 */
export function isNoticeRequest(item: InboxItemRequest): boolean {
  return item.request?.kind === "notice";
}

/**
 * Things genuinely waiting on the human:
 *
 *   - tasks parked in a decision lifecycle state (the cards the Needs-human
 *     lane renders), and
 *   - pending requests that are blocking or required — a bot that cannot
 *     proceed until the human answers.
 *
 * NOTICES ARE DELIBERATELY EXCLUDED. A notice is news, not a decision: the
 * delivery post already announced it in the channel the human is reading, and
 * the Acknowledge-only card it used to raise was deleted precisely because the
 * only thing a human could do with it was dismiss it. Counting news as "needs
 * you" is what made the badge disagree with the strip — `inbox_attention`
 * counts EVERY request kind, notices included (see inboxItemNeedsAttention in
 * internal/team/broker_office_stats.go, which returns true for any request).
 *
 * Returns 0 for a missing payload — before the stats query resolves, or when
 * the broker is unreachable, the honest answer is "nothing known", not a guess.
 */
export function needsYouCount(stats: OfficeStats | undefined | null): number {
  if (!stats) return 0;
  const decisions = stats.tasks?.needs_human ?? 0;
  const blocking = stats.requests?.blocking ?? 0;
  return decisions + blocking;
}

/**
 * True when nothing anywhere is asking for the human — the "all quiet" case.
 *
 * Kept next to the count rather than derived at the call site so the strip's
 * quiet state and every other surface's number cannot drift apart: quiet means
 * no work running, nothing blocked, and nothing waiting on you.
 */
export function officeIsQuiet(stats: OfficeStats | undefined | null): boolean {
  if (!stats) return false;
  return (
    (stats.agents_active ?? 0) === 0 &&
    (stats.tasks?.blocked ?? 0) === 0 &&
    needsYouCount(stats) === 0
  );
}
