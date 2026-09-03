/**
 * Rotating loading verbs, in the spirit of the Claude Code spinner's gerunds
 * ("Cogitating…", "Percolating…"). Kept short so they fit a typing bubble.
 *
 * These have now been wrong twice, in opposite directions, so the reasoning is
 * worth writing down properly.
 *
 * They began as The Office references ("Schruting", "Channeling Prison Mike").
 * That gag belonged to a product named after Ryan Howard's failed startup and
 * did not survive the rename, so it was replaced with watching verbs:
 * "Gawking", "Staring", "Not blinking". The comment above them asserted that
 * "watching IS the job".
 *
 * It is not, and that framing is retired. Founder, verbatim: "gawkbot should
 * not be called a bystander in any messaging. gawkbots outsource menial tasks
 * from lazy humans to AI models and let the humans have a false sense of
 * control by giving them microapps to manage the outcomes."
 *
 * So the bot is the one WORKING. The human is the one gawking, at a
 * dashboard, after the fact. A spinner that says "Staring" while the bot
 * grinds through real work tells the exact inverse of the product story, and
 * it does it at the single moment the user is watching most closely.
 *
 * These are therefore the drudgery being absorbed: flat, specific, tedious
 * verbs for the work a person no longer has to do. The comedy is in how
 * boring the task is and how untroubled the bot is by it, never in the
 * bot being idle or dim. Do not reintroduce a spectating verb here.
 *
 * House style: no contractions, no em-dashes. They cycle decoratively, so they
 * are aria-hidden behind a stable status label.
 *
 * The export name keeps "office" because it is an identifier, not copy, and
 * renaming it would churn every import for no reader's benefit.
 */
export const OFFICE_LOADING_PHRASES = [
  "Doing the boring part",
  "Reading the whole thread",
  "Opening the other tab",
  "Copying it across",
  "Checking every row",
  "Filling in the form",
  "Clicking through the pagination",
  "Waiting on the export",
  "Cross-referencing the spreadsheet",
  "Reformatting the dates",
  "Deduplicating the list",
  "Chasing the missing field",
  "Re-entering it by hand",
  "Reading the terms of service",
  "Doing it the slow way",
  "Tabbing between windows",
  "Handling it",
  "Not asking you about it",
  "Almost through the list",
  "Nearly done, genuinely",
] as const;
