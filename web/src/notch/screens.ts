import type { ReplyTarget } from "./shared";

/**
 * What the open notch's right pane shows. Home is the default pick
 * (home/model.ts: the bot waiting on you, else the suggestions, else the
 * lead); the sidebar picks the others. Esc comes back Home, and so does
 * closing the notch.
 */
export type NotchScreen =
  | { kind: "home" }
  | { kind: "agent"; slug: string; name: string; channel: string }
  | { kind: "suggestions" }
  | { kind: "sessions" }
  | { kind: "new" }
  | { kind: "settings" };

export const SETTINGS: NotchScreen = { kind: "settings" };

export const HOME: NotchScreen = { kind: "home" };

export const SUGGESTIONS: NotchScreen = { kind: "suggestions" };

export const SESSIONS: NotchScreen = { kind: "sessions" };

export const NEW_BOT: NotchScreen = { kind: "new" };

/** The screen a reply target belongs on: a bot's chat, or none (a card's answer stays where it is). */
export function screenForTarget(target: ReplyTarget): NotchScreen | null {
  if (target.kind !== "message") return null;
  return {
    kind: "agent",
    slug: target.slug,
    name: target.name,
    channel: target.channel,
  };
}

export function isAgentScreen(
  screen: NotchScreen,
): screen is Extract<NotchScreen, { kind: "agent" }> {
  return screen.kind === "agent";
}
