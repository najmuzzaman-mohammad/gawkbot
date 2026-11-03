import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";

import { keyAction, type NotchAction } from "./keys";
import { claimNudge } from "./nudge";
import type { ComposerState, ReplyTarget } from "./shared";
import { play, soundForAttention } from "./sounds";
import type { Mood, NotchAgent, NotchAttention, NotchState } from "./types";
import { startVoice, type VoiceSession } from "./voice";

// The notch's behaviour, one concern per hook. NotchApp wires them together.

/**
 * Ids of attention items that were not in `prev`. The first snapshot only
 * seeds `prev`, so opening the app with three old asks pending does not
 * buzz three times.
 */
export function newAttentionIds(
  prev: ReadonlySet<string> | null,
  state: NotchState,
): string[] {
  if (prev === null) return [];
  return state.attention.map((a) => a.id).filter((id) => !prev.has(id));
}

/** Agents whose mood just became error or done: they get a sound each. */
export function moodTransitions(
  prev: ReadonlyMap<string, Mood> | null,
  agents: readonly NotchAgent[],
): ("error" | "done")[] {
  if (prev === null) return [];
  const out: ("error" | "done")[] = [];
  for (const a of agents) {
    // Terminal sessions start and finish all day: they make no sound.
    if (a.kind === "session" || prev.get(a.slug) === a.mood) continue;
    if (a.mood === "error" || a.mood === "done") out.push(a.mood);
  }
  return out;
}

/** Records when each open ask was first seen; forgets answered ones. */
export function trackFirstSeen(
  map: Map<string, number>,
  attention: readonly NotchAttention[],
  now: number,
): void {
  const open = new Set(attention.map((a) => a.id));
  for (const id of [...map.keys()]) {
    if (!open.has(id)) map.delete(id);
  }
  for (const id of open) {
    if (!map.has(id)) map.set(id, now);
  }
}

/**
 * Sounds when something new happens. Returns when
 * this notch first saw each open ask (the boredom clock runs from it).
 */
export function useAttentionSignals(
  state: NotchState | null,
): MutableRefObject<Map<string, number>> {
  const seen = useRef<Set<string> | null>(null);
  const firstSeen = useRef(new Map<string, number>());
  const moods = useRef<Map<string, Mood> | null>(null);
  useEffect(() => {
    if (!state) return;
    const fresh = newAttentionIds(seen.current, state);
    seen.current = new Set(state.attention.map((a) => a.id));
    trackFirstSeen(firstSeen.current, state.attention, Date.now());
    // A new question makes a sound at most once in five minutes (nudge.ts).
    // The notch never opens by itself: the asker's card at the top right
    // (NotchDock.tsx) says what it needs.
    if (fresh.length > 0 && claimNudge("ask")) {
      const item = state.attention.find((a) => a.id === fresh[0]);
      play(soundForAttention(item?.kind ?? ""));
    }
    for (const s of moodTransitions(moods.current, state.agents)) play(s);
    moods.current = new Map(state.agents.map((a) => [a.slug, a.mood]));
  }, [state]);
  return firstSeen;
}

/**
 * True when the person turned off bots jumping out of the notch to get
 * attention: no opening by itself, no peek, no fly-in, no chatter.
 */
export function staysInNotch(state: NotchState | null): boolean {
  return state?.jump_out === false;
}

/** A value that is always current inside timers, without restarting them. */
function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Push-to-talk into the composer. Returns setVoice(on). */
export function useVoice(
  setComposer: Dispatch<SetStateAction<ComposerState | null>>,
  setError: (message: string | null) => void,
): (on: boolean) => void {
  const session = useRef<VoiceSession | null>(null);
  return useCallback(
    (on: boolean) => {
      if (!on) {
        if (session.current) {
          play("listen_stop");
          session.current.stop();
        }
        return;
      }
      if (session.current) return;
      setComposer((c) => (c ? { ...c, listening: true } : c));
      play("listen_start");
      session.current = startVoice({
        onPartial: (text) => setComposer((c) => (c ? { ...c, text } : c)),
        onFinal: (text) =>
          setComposer((c) => (c ? { ...c, text: text || c.text } : c)),
        onError: (message) => setError(message),
        onEnd: () => {
          session.current = null;
          setComposer((c) => (c ? { ...c, listening: false } : c));
        },
      });
      if (!session.current) {
        setComposer((c) => (c ? { ...c, listening: false } : c));
        setError("Voice is not available here");
      }
    },
    [setComposer, setError],
  );
}

export interface KeyHandlers {
  attention: NotchAttention[];
  selected: NotchAttention | undefined;
  composer: ComposerState | null;
  select: (id: string) => void;
  choose: (requestId: string, optionId: string) => void;
  /** Sends text as the answer to a card: a question or a finished turn. */
  suggest: (cardId: string, text: string) => void;
  /** Marks a finished turn done. */
  done: (cardId: string) => void;
  reply: () => ReplyTarget | null;
  lead: () => ReplyTarget | null;
  open: (target: ReplyTarget) => void;
  voice: (on: boolean) => void;
  /**
   * Talk to the office out loud (realtime/useRealtime.ts). Returns false
   * when that is not possible here, and the key dictates instead.
   */
  talk?: (on: boolean) => boolean;
  close: () => void;
  /** Open the full app at the selected question's conversation. */
  openFull: () => void;
  /** The notch's own settings screen. */
  settings?: () => void;
}

/** Runs one keyboard action. Returns false when the key was not ours. */
export function runKeyAction(action: NotchAction, h: KeyHandlers): boolean {
  switch (action.type) {
    case "option":
      return moveOptionFocus(action.delta);
    case "choice":
      return moveChoiceFocus(action.delta);
    case "done":
      if (h.selected) h.done(h.selected.id);
      return true;
    case "move": {
      if (h.attention.length === 0) return false;
      dropButtonFocus();
      const i = Math.max(
        0,
        h.attention.findIndex((a) => a.id === h.selected?.id),
      );
      h.select(
        h.attention[
          (i + action.delta + h.attention.length) % h.attention.length
        ].id,
      );
      return true;
    }
    case "choose":
      if (h.selected) h.choose(h.selected.id, action.optionId);
      return true;
    case "suggest":
      if (h.selected) h.suggest(h.selected.id, action.text);
      return true;
    case "reply":
    case "message_lead": {
      const t = action.type === "reply" ? h.reply() : h.lead();
      if (t) h.open(t);
      return true;
    }
    case "voice_start": {
      // With no reply box open the key is a conversation with the office
      // when one is possible; inside a box it dictates into the box.
      if (!h.composer && h.talk?.(true)) return true;
      const t = h.composer?.target ?? h.reply();
      if (!t) return false;
      if (!h.composer) h.open(t);
      h.voice(true);
      return true;
    }
    case "close":
      h.close();
      return true;
    case "open_full":
      h.openFull();
      return true;
    case "settings":
      h.settings?.();
      return true;
    default:
      return false;
  }
}

/** A button in the open panel has the focus. */
function focusOnButton(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLButtonElement && el.closest(".npanel") !== null;
}

/**
 * Steps the focus along the selected question's buttons, wrapping at the
 * ends. With none in focus yet, → starts at the first and ← at the last.
 * Returns false when there is no selected question to move within.
 */
export function moveOptionFocus(delta: 1 | -1): boolean {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".nq.is-selected .nchoices button:not(:disabled), .nq.is-selected .nq-actions button:not(:disabled)",
    ),
  );
  if (buttons.length === 0) return false;
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    at < 0
      ? delta > 0
        ? 0
        : buttons.length - 1
      : (at + delta + buttons.length) % buttons.length;
  buttons[next].focus();
  return true;
}

/**
 * What ↑ and ↓ step through: every card's replies in the order shown, or
 * for a card with none, its first button (Reply).
 */
function choiceTargets(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".npanel .nq"),
  ).flatMap((card) => {
    const rows = Array.from(
      card.querySelectorAll<HTMLButtonElement>(".nchoice:not(:disabled)"),
    );
    if (rows.length > 0) return rows;
    const first = card.querySelector<HTMLButtonElement>(
      ".nq-actions button:not(:disabled)",
    );
    return first ? [first] : [];
  });
}

/**
 * Steps the focus through the replies on offer, from one card into the
 * next, stopping at the ends. With none in focus yet, it starts on the
 * selected card's first (recommended) reply. The card in focus becomes the
 * selected one (the panel selects on focus), so ↵ and 1–9 follow it.
 * Returns false when no card offers anything.
 */
export function moveChoiceFocus(delta: 1 | -1): boolean {
  const targets = choiceTargets();
  if (targets.length === 0) return false;
  const at = targets.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (at >= 0) {
    next = Math.min(targets.length - 1, Math.max(0, at + delta));
  } else {
    // The tour's practice card first while it shows, else the selected card.
    const selected =
      document.querySelector(".npanel .nq.is-lesson") ??
      document.querySelector(".npanel .nq.is-selected");
    const start = selected
      ? targets.findIndex((t) => selected.contains(t))
      : -1;
    next = start >= 0 ? start : 0;
  }
  targets[next].focus();
  return true;
}

/** Moving to another question leaves the button the arrows had reached. */
function dropButtonFocus(): void {
  if (focusOnButton()) (document.activeElement as HTMLElement).blur();
}

function typingInField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** Window keyboard handling while the notch is open. */
export function useNotchKeys(active: boolean, handlers: KeyHandlers): void {
  const latest = useLatest(handlers);
  useEffect(() => {
    if (!active) return;
    const onDown = (e: KeyboardEvent) => {
      const h = latest.current;
      const action = keyAction(
        {
          key: e.key,
          code: e.code,
          typing: typingInField(),
          onButton: focusOnButton(),
          repeat: e.repeat,
          meta: e.metaKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
        },
        h.selected,
      );
      if (runKeyAction(action, h)) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      if (
        keyAction(
          { key: e.key, code: e.code, typing: false },
          latest.current.selected,
          "up",
        ).type === "voice_stop"
      ) {
        latest.current.talk?.(false);
        latest.current.voice(false);
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [active, latest]);
}
