/**
 * Wizard-local view types.
 *
 * `BlueprintOption` is the trimmed shape the step screens consume for the team
 * picker. It is derived from the wire `BlueprintSummary` (api/onboarding.ts)
 * but narrowed to exactly what the UI needs, so the screens do not depend on
 * the full additive Go summary and cannot accidentally render fields the
 * wizard never plumbs.
 */

import type {
  BlueprintBotSummary,
  BlueprintSummary,
} from "../../../api/onboarding";

/** One bot row in a blueprint roster, as the team step renders it. */
export interface BlueprintBotOption {
  slug: string;
  name: string;
  role: string;
  emoji: string;
  /** Whether the bot is kept by default. */
  checked: boolean;
  /** The lead bot; the team step must keep it checked. */
  builtIn: boolean;
}

/** One selectable starter roster in the team step. */
export interface BlueprintOption {
  id: string;
  name: string;
  description: string;
  emoji: string;
  agents: BlueprintBotOption[];
}

function toBotOption(agent: BlueprintBotSummary): BlueprintBotOption {
  return {
    slug: agent.slug,
    name: agent.name,
    role: agent.role ?? "",
    emoji: agent.emoji ?? "",
    checked: agent.checked,
    builtIn: agent.built_in === true,
  };
}

/**
 * Narrow a wire `BlueprintSummary` to the `BlueprintOption` the step screens
 * consume. Drops the pack-library fields the wizard never renders.
 */
export function toBlueprintOption(summary: BlueprintSummary): BlueprintOption {
  return {
    id: summary.id,
    name: summary.name,
    description: summary.description ?? "",
    emoji: summary.emoji ?? "",
    agents: (summary.agents ?? []).map(toBotOption),
  };
}
