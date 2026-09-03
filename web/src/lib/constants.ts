// Sidebar TOOLS entries (labels, ids, order) live in
// `routes/routeRegistry.ts`. This file historically re-exported a
// duplicate `SIDEBAR_APPS` list — that was deleted to keep the registry
// the single source of truth. Resolve labels through `APP_LABELS` /
// `SIDEBAR_TOOLS` and read the displayed order from `SIDEBAR_TOOLS`.
import {
  APP_LABELS,
  type AppPanelId,
  type FirstClassAppId,
  isAppPanelId,
  isFirstClassAppId,
} from "../routes/routeRegistry";

export function appTitle(app: string): string {
  if (isAppPanelId(app) || isFirstClassAppId(app)) {
    return APP_LABELS[app as AppPanelId | FirstClassAppId];
  }
  return app.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Roster slug of the built-in App Builder bot (mirrors
 * company.AppBuilderSlug / team's appBuilderSlug on the Go side). Tasks owned
 * by this slug get the live app-build preview surface.
 */
export const APP_BUILDER_SLUG = "app-builder";

/**
 * The lead's roster slug. The DISPLAY name is "Chief of Staff"; the slug stays
 * "ceo" because it is an identifier that owns DMs (ceo__human), task
 * ownership, and message history on existing disks. Rename the copy, never
 * the slug.
 */
export const CHIEF_OF_STAFF_SLUG = "ceo";

export const ONBOARDING_COPY = {
  step1_headline: "AI employees with a shared brain",
  step1_subhead:
    "A collaborative office where AI bots like Claude Code, Codex, and Opencode learn your work playbooks, build personalized skills, and execute, 24x7.\nEach bot is backed by its own knowledge graph.",
  step1_cta: "Continue",
  step2_headline: "Name your team",
  step2_subhead: "This becomes the workspace your bots call home.",
  step2_cta: "Continue",
  step3_headline: "Pick a blueprint",
  step3_subhead: "Pre-built teams and workflows. Start here, customize later.",
  step3_cta: "Continue",
  step4_headline: "Meet your team",
  step4_subhead:
    "These specialists ship work while you sleep. Toggle anyone you don't need.",
  step4_cta: "Continue",
  step5_headline: "Connect a provider",
  step5_subhead:
    "Pick one or more providers your bots can use. Drag to set fallback order.",
  step5_cta: "Continue",
  step6_headline: "Power up with Nex",
  step6_subhead:
    "Shared memory, entity briefs, and integrations. Optional but powerful.",
  step7_headline: "First assignment",
  step7_subhead: "Give your team something real to work on.",
  step7_placeholder:
    "e.g. Sign our first three pilot customers in the next two weeks.",
  step7_skip: "Skip for now",
  step7_cta: "Review setup",
  step8_headline: "Ready to launch",
  step8_subhead: "Here's what's configured. Fix anything later from Settings.",
  step8_cta: "Launch office",
} as const;

export const DISCONNECT_THRESHOLD = 3;
export const MESSAGE_POLL_INTERVAL = 2000;
export const MEMBER_POLL_INTERVAL = 5000;
export const REQUEST_POLL_INTERVAL = 3000;

/**
 * Named-channel retirement, web half.
 *
 * Conversations are moving to per-bot DMs, so ordinary named rooms (#product,
 * #planning, anything a human creates) are switched off. This constant hides
 * the affordance; the broker independently 409s the create call, so the two are
 * belt and braces rather than one guard split across a wire.
 *
 * MIRRORS internal/channel/general.go's namedChannelsEnabled. There is no wire
 * field carrying it, so THESE TWO CAN DRIFT — if you flip one, flip the other.
 * A stale `true` here shows a button that fails with a 409, which is ugly but
 * honest; a stale `false` hides a working feature, which is worse. Prefer
 * flipping the web one last when enabling, first when disabling.
 *
 * Typed `boolean` rather than left to literal inference so the disabled branch
 * stays live code for the type checker.
 */
export const NAMED_CHANNELS_ENABLED: boolean = false;
