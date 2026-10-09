import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { prefersReducedMotion } from "../lib/orbAvatar";
import {
  type BanterLine,
  banterScript,
  gang as gangOf,
  nextPeekDelayMs,
  PEEK_DURATION_MS,
  pickPeeker,
  seedOf,
} from "./antics";
import { postNative } from "./bridge";
import { keyAction, type NotchAction } from "./keys";
import type { ComposerState, ReplyTarget } from "./NotchPanel";
import { claimNudge, nudgeWaitMs } from "./nudge";
import { play, soundForAttention } from "./sounds";
import type { Mood, NotchAgent, NotchAttention, NotchState } from "./types";
import { startVoice, type VoiceSession } from "./voice";

// The notch's behaviour, one concern per hook. NotchApp wires them together.

const LINE_MS = 3_200;
const BETWEEN_SCRIPTS_MS = 7_000;

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
    if (prev.get(a.slug) === a.mood) continue;
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
 * Sounds and the native tap/peek when something new happens. Returns when
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
    // A new question nudges (a sound, and the notch peeks open) at most
    // once in five minutes (nudge.ts); in between, the count on the notch
    // goes up and that is all. Play never spends this turn.
    if (fresh.length > 0 && claimNudge("ask")) {
      const item = state.attention.find((a) => a.id === fresh[0]);
      play(soundForAttention(item?.kind ?? ""));
      postNative({
        type: "attention",
        count: state.attention.length,
        headline: state.headline,
      });
    }
    for (const s of moodTransitions(moods.current, state.agents)) play(s);
    moods.current = new Map(state.agents.map((a) => [a.slug, a.mood]));
  }, [state]);
  return firstSeen;
}

/** A value that is always current inside timers, without restarting them. */
function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * The bored gang's conversation. Restarts only when WHO is waiting changes,
 * not on every poll; reads the latest asks through refs.
 */
export function useBanter(
  chatting: boolean,
  attention: NotchAttention[],
  agents: NotchAgent[],
): BanterLine | null {
  const [line, setLine] = useState<BanterLine | null>(null);
  const latest = useLatest({ attention, agents });
  const gangKey = gangOf(attention, agents)
    .map((g) => g.slug)
    .join(",");
  useEffect(() => {
    if (!chatting || gangKey === "") {
      setLine(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    let round = 0;
    const runScript = () => {
      // Chatter is play: it waits five minutes after anything else.
      if (!claimNudge("play")) {
        setLine(null);
        timer = window.setTimeout(runScript, nudgeWaitMs() + 1_000);
        return;
      }
      const script = banterScript(
        latest.current.attention,
        latest.current.agents,
        round++,
      );
      let i = 0;
      const next = () => {
        if (cancelled) return;
        if (i >= script.length) {
          setLine(null);
          timer = window.setTimeout(runScript, BETWEEN_SCRIPTS_MS);
          return;
        }
        const l = script[i++];
        setLine(l);
        play("babble", seedOf(l.speaker));
        timer = window.setTimeout(next, LINE_MS);
      };
      next();
    };
    runScript();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chatting, gangKey, latest]);
  return line;
}

/** How long the stage stays open for an arrival: the pop, then the flight. */
export const ARRIVAL_MS = 1_650;

/**
 * The agent that just asked something, while the notch is closed: it pops
 * into being under the notch and flies up into the ear (NotchArrival). One
 * at a time; a second ask during a flight joins the gang without one. Nobody
 * flies when the notch is open (the question card arrives instead) or for
 * people who have asked for less motion.
 */
export function useArrival(
  state: NotchState | null,
  expanded: boolean,
): NotchAgent | null {
  const [arrival, setArrival] = useState<NotchAgent | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const flying = useRef(false);
  const latestExpanded = useLatest(expanded);
  useEffect(() => {
    if (!state) return;
    const fresh = newAttentionIds(seen.current, state);
    seen.current = new Set(state.attention.map((a) => a.id));
    if (
      fresh.length === 0 ||
      flying.current ||
      latestExpanded.current ||
      prefersReducedMotion()
    ) {
      return;
    }
    const item = state.attention.find((a) => a.id === fresh[0]);
    const who = state.agents.find((a) => a.slug === item?.from);
    if (!(who && claimNudge("ask"))) return;
    flying.current = true;
    setArrival(who);
    window.setTimeout(() => {
      flying.current = false;
      setArrival(null);
    }, ARRIVAL_MS);
  }, [state, latestExpanded]);
  return expanded ? null : arrival;
}

/** Now and then, an agent peeks out from under the notch. Just for fun. */
export function usePeeks(
  agents: NotchAgent[],
  attention: NotchAttention[],
  blocked: boolean,
  everyMs: number,
): NotchAgent | null {
  const [peeker, setPeeker] = useState<NotchAgent | null>(null);
  const latest = useLatest({ agents, attention, blocked });
  useEffect(() => {
    let timer = 0;
    let hide = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        const { agents: a, attention: att, blocked: b } = latest.current;
        const busy = new Set(gangOf(att, a).map((g) => g.slug));
        const who = b ? null : pickPeeker(a, busy, Math.random);
        if (who && claimNudge("play")) {
          setPeeker(who);
          play("peek");
          hide = window.setTimeout(() => setPeeker(null), PEEK_DURATION_MS);
        }
        schedule();
      }, everyMs || nextPeekDelayMs(Math.random));
    };
    schedule();
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(hide);
    };
  }, [everyMs, latest]);
  return peeker;
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
  reply: () => ReplyTarget | null;
  lead: () => ReplyTarget | null;
  open: (target: ReplyTarget) => void;
  voice: (on: boolean) => void;
  close: () => void;
  /** Open the full app at the selected question's conversation. */
  openFull: () => void;
}

/** Runs one keyboard action. Returns false when the key was not ours. */
export function runKeyAction(action: NotchAction, h: KeyHandlers): boolean {
  switch (action.type) {
    case "move": {
      if (h.attention.length === 0) return false;
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
    case "reply":
    case "message_lead": {
      const t = action.type === "reply" ? h.reply() : h.lead();
      if (t) h.open(t);
      return true;
    }
    case "voice_start": {
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
    default:
      return false;
  }
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
      )
        latest.current.voice(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [active, latest]);
}
