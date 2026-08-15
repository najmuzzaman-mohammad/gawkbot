// The onboarding → operator handoff for the user's first workflow.
//
// Onboarding's final step collects one manual workflow. The operator surface is
// the front door, so instead of dropping that text into an office channel the
// user never sees, onboarding stashes it here and OperatorApp consumes it on
// mount: the build flow opens with the text already sent, and the user lands on
// their first agent being assembled. localStorage (not the app store) because
// completing onboarding remounts the tree.

export const OPERATOR_FIRST_WORKFLOW_SEED_KEY = "wuphf.operator.firstWorkflowSeed";

/** Read + clear the pending seed. Returns null when there is none. */
export function consumeFirstWorkflowSeed(): string | null {
  try {
    const text = window.localStorage.getItem(OPERATOR_FIRST_WORKFLOW_SEED_KEY);
    if (text === null) return null;
    window.localStorage.removeItem(OPERATOR_FIRST_WORKFLOW_SEED_KEY);
    const trimmed = text.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}
