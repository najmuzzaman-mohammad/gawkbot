// teachWorkflowSeed.ts — turn a REAL screenshare capture into the direct
// message that teaches ONE BOT a workflow.
//
// Nothing here is invented. `screens` comes from runObserve() →
// runner/cua_observe.py, which reads the frontmost window's accessibility tree
// and visible text through cua-driver; `goal` is what the operator typed before
// they started. This module only formats those two real inputs.
//
// It is deliberately NOT buildTeachSeed() from appdetail/apps/demoSeed.ts.
// That formatter addresses the tool-AUTHORING endpoint ("Write one tool that
// does this job") and lands in AppToolsChat. This one addresses a bot in its
// own DM channel, where the ask is different: replicate the job, and say
// plainly which steps it cannot run yet. That closing instruction is the
// honesty gate — the bot's first reply is a capability statement, not a
// claim of success this UI would have had to invent.

import type { ObservedScreen } from "../../appdetail/apps/observeClient";

/** How many element labels of one screen make it into the message. */
const MAX_ELEMENTS_PER_SCREEN = 20;

function describeScreen(screen: ObservedScreen, index: number): string[] {
  const lines = [`${index + 1}. ${screen.app} — ${screen.title}`];
  if (screen.components.length > 0) {
    lines.push(
      `   on screen: ${screen.components
        .slice(0, MAX_ELEMENTS_PER_SCREEN)
        .map((c) => `${c.role}:${c.label}`)
        .join(", ")}`,
    );
  }
  if (screen.text) {
    lines.push(`   text: ${screen.text}`);
  }
  return lines;
}

export interface BotWorkflowSeedInput {
  /** The bot being taught. Used to address the message. */
  agentSlug: string;
  /** The operator's own words for the job, typed before the capture. */
  goal: string;
  /** The distinct screens the observer actually read, already reduced. */
  screens: ObservedScreen[];
}

/**
 * Build the message that hands a captured workflow to a bot.
 *
 * With no screens the message still goes through — it is then a typed
 * description, and it says so rather than implying a capture happened.
 */
export function buildBotWorkflowSeed({
  agentSlug,
  goal,
  screens,
}: BotWorkflowSeedInput): string {
  const lines: string[] = [`Learn this workflow: ${goal.trim()}`];

  if (screens.length === 0) {
    lines.push(
      "",
      "No screens were read during the screenshare, so work from the description above.",
    );
  } else {
    lines.push(
      "",
      "I just did this on my own screen while you watched. These are the " +
        "screens that were actually read, in the order I used them:",
      "",
    );
    screens.forEach((screen, i) => {
      lines.push(...describeScreen(screen, i));
    });
  }

  lines.push(
    "",
    `Write this up as a repeatable workflow you own, @${agentSlug.trim()}. ` +
      "List the steps you would take to run it yourself, and name every step " +
      "you cannot do yet with the tools you have.",
  );
  return lines.join("\n");
}
