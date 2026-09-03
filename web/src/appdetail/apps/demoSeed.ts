// demoSeed.ts — turn a REAL observe capture into the message that teaches the
// bot a tool.
//
// The Demo tab's whole contract is that nothing here is invented. `screens`
// comes from runObserve() → runner/cua_observe.py, which reads the frontmost
// window's accessibility tree and visible text through cua-driver; `goal` is
// what the operator typed before they started. This module only formats those
// two real inputs into a prompt and hands it to the live authoring chat
// (AppToolsChat's `seed` → POST /bot/tools/build).
//
// Deliberately NOT reusing capturePromptSeed() from the old operator shell:
// that formatter speaks to the app-BUILD engine ("What to build: this work
// needs an APP UI…") and would mislead the tool-authoring model. It also
// carried selector/API/entity sections whose only producer — the realtime
// voice call's draft_workflow tool — no longer exists, so filling them would
// mean fabricating. See docs/specs/operator-cua-migration.md §7 (C5).

import type { ObservedScreen } from "./observeClient";

/** How many element labels of one screen make it into the prompt. */
const MAX_ELEMENTS_PER_SCREEN = 20;

/**
 * The chat opener must not trip AppToolsChat's routing heuristics: `matchTool`
 * claims anything starting with run/call/use, and `looksLikeQuestion` claims
 * interrogatives and anything ending in "?". "Teach me a tool…" is neither, so
 * the message reaches the authoring path.
 */
const OPENER = "Teach me a tool for this job";

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

/**
 * Build the teach message from a completed capture.
 *
 * `goal` is the operator's own words. `screens` are the distinct screens the
 * observer actually read, already reduced and bounded by `reduceObserved`.
 * With no screens the message still goes through — it is then simply a typed
 * description, and it says so rather than implying a capture happened.
 */
export function buildTeachSeed(
  goal: string,
  screens: ObservedScreen[],
): string {
  const trimmedGoal = goal.trim();
  const lines: string[] = [`${OPENER}: ${trimmedGoal}`];

  if (screens.length === 0) {
    lines.push(
      "",
      "I did not capture any screens for this one — work from the description above.",
    );
  } else {
    lines.push(
      "",
      "I just demonstrated it on this computer. gawkbot read the real screens " +
        "while I worked — here is what was on them, in the order I used them:",
      "",
    );
    screens.forEach((screen, i) => {
      lines.push(...describeScreen(screen, i));
    });
  }

  lines.push("", "Write one tool that does this job.");
  return lines.join("\n");
}

/** Plain-language count for the review step, so the operator sees the size of
 *  what is about to be sent before they send it. */
export function describeCapture(screens: ObservedScreen[]): string {
  if (screens.length === 0) return "No screens captured";
  const elements = screens.reduce((n, s) => n + s.components.length, 0);
  const screenWord = screens.length === 1 ? "screen" : "screens";
  const elementWord = elements === 1 ? "element" : "elements";
  return `${screens.length} ${screenWord}, ${elements} ${elementWord} read`;
}
