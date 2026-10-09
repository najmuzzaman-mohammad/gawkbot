// Keyboard map for the open notch. Everything has a key, so answering an
// agent is one keystroke:
//
//   J / ↓        next question          K / ↑      previous question
//   ← / →        move along the question's buttons (↵ presses the one in focus)
//   1–9          pick that answer       ↵          the recommended answer
//   R            reply in words         V (hold)   reply with your voice
//                                       ⌥V (hold)  the same, from inside the reply box
//   M            message the Chief of Staff
//   Esc          close (or cancel the reply you are typing)
//
// ⌃⌥Space opens the notch from anywhere; that one is a global hotkey
// registered by the Mac app (notch_darwin.m), not handled here.

import type { NotchAttention } from "./types";

export type NotchAction =
  | { type: "move"; delta: 1 | -1 }
  /** Step the focus along the selected question's buttons. */
  | { type: "option"; delta: 1 | -1 }
  | { type: "choose"; optionId: string }
  | { type: "reply" }
  | { type: "voice_start" }
  | { type: "voice_stop" }
  | { type: "message_lead" }
  | { type: "open_full" }
  | { type: "close" }
  | { type: "none" };

export interface KeyInput {
  key: string;
  /** Physical key (KeyboardEvent.code): ⌥V types "√" on a Mac, code stays "KeyV". */
  code?: string;
  /** True while a text field has focus: only Esc and Enter are ours then. */
  typing: boolean;
  /**
   * True while one of the panel's buttons has the focus (the arrows put it
   * there): Enter then presses that button, as it would anywhere.
   */
  onButton?: boolean;
  repeat?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

function oneTap(item: NotchAttention | undefined) {
  return (item?.options ?? []).filter((o) => !o.requires_text);
}

const MOVES: Readonly<Record<string, 1 | -1>> = {
  j: 1,
  J: 1,
  ArrowDown: 1,
  k: -1,
  K: -1,
  ArrowUp: -1,
};

function enterAction(selected: NotchAttention | undefined): NotchAction {
  const opts = oneTap(selected);
  const rec =
    opts.find((o) => o.id === selected?.recommended_id) ??
    (opts.length === 1 ? opts[0] : undefined);
  if (rec) return { type: "choose", optionId: rec.id };
  return selected ? { type: "reply" } : { type: "none" };
}

function letterAction(
  key: string,
  input: KeyInput,
  selected: NotchAttention | undefined,
): NotchAction {
  switch (key.toLowerCase()) {
    case "r":
      return selected ? { type: "reply" } : { type: "message_lead" };
    case "m":
      return { type: "message_lead" };
    case "o":
      return { type: "open_full" };
    case "v":
      return input.repeat ? { type: "none" } : { type: "voice_start" };
    default:
      return { type: "none" };
  }
}

function isVKey(input: KeyInput): boolean {
  return input.code === "KeyV" || input.key.toLowerCase() === "v";
}

/** Inside the reply box plain V is a letter, so push-to-talk is ⌥V there. */
function typingVoiceAction(input: KeyInput): NotchAction | null {
  if (!(input.typing && input.alt && isVKey(input)) || input.meta || input.ctrl)
    return null;
  return input.repeat ? { type: "none" } : { type: "voice_start" };
}

function keyUpAction(input: KeyInput): NotchAction {
  return isVKey(input) || input.key === "Alt"
    ? { type: "voice_stop" }
    : { type: "none" };
}

export function keyAction(
  input: KeyInput,
  selected: NotchAttention | undefined,
  phase: "down" | "up" = "down",
): NotchAction {
  if (phase === "up") return keyUpAction(input);
  const { key } = input;
  if (key === "Escape") return { type: "close" };
  const typingVoice = typingVoiceAction(input);
  if (typingVoice) return typingVoice;
  if (input.typing || input.meta || input.ctrl || input.alt)
    return { type: "none" };
  const delta = MOVES[key];
  if (delta) return { type: "move", delta };
  if (key === "ArrowRight") return { type: "option", delta: 1 };
  if (key === "ArrowLeft") return { type: "option", delta: -1 };
  // A focused button takes Enter itself; we must not also answer for it.
  if (key === "Enter") {
    return input.onButton ? { type: "none" } : enterAction(selected);
  }
  if (/^[1-9]$/.test(key)) {
    const opt = oneTap(selected)[Number(key) - 1];
    return opt ? { type: "choose", optionId: opt.id } : { type: "none" };
  }
  return letterAction(key, input, selected);
}

/** The shortcut legend shown in the panel footer. */
export const SHORTCUTS: readonly [string, string][] = [
  ["J K", "move"],
  ["← →", "buttons"],
  ["1–9", "answer"],
  ["↵", "recommended"],
  ["R", "reply"],
  ["V", "hold to talk"],
  ["O", "full view"],
  ["Esc", "close"],
];
