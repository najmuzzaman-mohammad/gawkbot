import { createContext, useContext } from "react";

// What a bot runs on, as the broker resolves it (internal/team/
// broker_member_runtime.go). Every avatar reads this to draw its model badge,
// so the web app, the notch and the phone agree without each re-deriving it
// from the provider binding.
export interface BotRuntime {
  /** Effective provider kind; the install default for an unbound bot. */
  harness: string;
  /** What a person calls the tool: "Claude Code", "Gemini CLI". */
  harness_name?: string;
  /** Raw model id. Absent when nobody knows (a gateway bot, a bare CLI). */
  model?: string;
  /** Short form for a badge: "Opus 5.5". */
  model_label?: string;
  /** "claude" | "gpt" | "gemini", or absent for a model we do not group. */
  family?: string;
  /** Where the model came from: observed | binding | default. */
  source?: "observed" | "binding" | "default";
}

export type BotRuntimeLookup = (slug: string) => BotRuntime | undefined;

const noRuntime: BotRuntimeLookup = () => undefined;

/**
 * Supplies each avatar's runtime by slug. The app feeds it from the office
 * roster and the notch from its own state; with no provider above it an
 * avatar simply draws no badge.
 */
export const BotRuntimeContext = createContext<BotRuntimeLookup>(noRuntime);

export function useBotRuntime(slug: string): BotRuntime | undefined {
  return useContext(BotRuntimeContext)(slug);
}

export type BadgeDensity = "dot" | "code" | "word" | "full";

// How much the badge can say next to an avatar of this size. Below 16px
// there is no room for a legible character, so it is a dot with a tooltip.
export function badgeDensity(avatarSize: number): BadgeDensity {
  if (avatarSize < 16) return "dot";
  if (avatarSize < 32) return "code";
  if (avatarSize < 44) return "word";
  return "full";
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * The badge text at a density. The model when it is known, else the tool:
 *   full  "Opus 5.5"   word  "Opus"   code  "O5"
 * A model label is "<Name> <version>" for Claude ("Opus 5.5") and
 * "<Family>-<version> …" for the rest ("GPT-6 Astra"), so the code is the
 * first letter plus the first digit either way.
 */
export function badgeText(runtime: BotRuntime, density: BadgeDensity): string {
  if (density === "dot") return "";
  const label = runtime.model_label?.trim();
  if (!label) {
    const name = runtime.harness_name?.trim() || runtime.harness;
    return density === "code" ? initials(name) : name;
  }
  if (density === "full") return label;
  const firstWord = label.split(/\s+/)[0];
  if (density === "word") return firstWord;
  const digit = label.match(/\d/)?.[0] ?? "";
  return digit ? `${label[0].toUpperCase()}${digit}` : label.slice(0, 2);
}

/** "Opus 5.5 in Claude Code", "Claude Code" when the model is unknown. */
export function runtimeTitle(runtime: BotRuntime): string {
  const tool = runtime.harness_name?.trim() || runtime.harness;
  const label = runtime.model_label?.trim();
  return label ? `${label} in ${tool}` : tool;
}
