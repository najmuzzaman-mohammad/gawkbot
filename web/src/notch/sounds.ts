// Cartoon sound effects for the notch, synthesized live with Web Audio.
//
// Nothing is sampled or bundled: every effect is a couple of oscillators with
// pitch and gain envelopes, so the sounds are ours, weigh nothing, and can be
// tuned in code. One sound per kind of moment, so the human learns what
// happened before looking:
//
//   question  "boing"      a sprung pitch wobble: someone has a question
//   approval  "doo-dee"    two rising notes: something waits for your yes
//   error     "wah-wah"    a sad descending trombone-ish slide
//   done      "ta-da"      a bright three-note arpeggio
//   sent      "pop"        a short bubbly pop when you answer or send
//   peek      "pip"        a tiny chirp when an agent peeks out for fun
//   babble    gibberish    squeaky syllables while bored agents chat
//   listen    blip up/down voice capture starting and stopping
//
// Browsers (and WKWebView) keep an AudioContext suspended until a user
// gesture unless the host allows it; the Mac app does (see notch_darwin.m).
// `unlock()` resumes it on the first gesture for everyone else.

export type SoundKind =
  | "question"
  | "approval"
  | "error"
  | "done"
  | "sent"
  | "peek"
  | "babble"
  | "listen_start"
  | "listen_stop";

const STORAGE_KEY = "gawkbot.notch.sound";

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = readEnabled();

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the toggle still works for this session.
  }
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const w = window as unknown as {
    AudioContext?: Ctor;
    webkitAudioContext?: Ctor;
  };
  const AC = w.AudioContext ?? w.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Resume a suspended context; call from any user gesture. */
export function unlock(): void {
  const c = audio();
  if (c && c.state === "suspended") void c.resume();
}

interface Tone {
  type?: OscillatorType;
  /** Frequencies (Hz) at evenly spaced points over the tone's duration. */
  freqs: number[];
  start: number;
  dur: number;
  gain?: number;
  /** Vibrato depth in Hz (the "boing" wobble). */
  wobble?: number;
  wobbleRate?: number;
}

function tone(c: AudioContext, out: AudioNode, t0: number, spec: Tone): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = spec.type ?? "sine";
  const start = t0 + spec.start;
  const end = start + spec.dur;
  const step = spec.dur / Math.max(1, spec.freqs.length - 1);
  osc.frequency.setValueAtTime(spec.freqs[0], start);
  spec.freqs.slice(1).forEach((f, i) => {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, f),
      start + step * (i + 1),
    );
  });
  if (spec.wobble) {
    const lfo = c.createOscillator();
    const depth = c.createGain();
    lfo.frequency.value = spec.wobbleRate ?? 18;
    depth.gain.setValueAtTime(spec.wobble, start);
    depth.gain.exponentialRampToValueAtTime(0.01, end);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(start);
    lfo.stop(end);
  }
  const peak = spec.gain ?? 0.6;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(
    peak,
    start + Math.min(0.012, spec.dur / 4),
  );
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(g).connect(out);
  osc.start(start);
  osc.stop(end + 0.02);
}

/** Note frequency from a semitone offset to A4. */
const note = (semi: number) => 440 * 2 ** (semi / 12);

const RECIPES: Record<SoundKind, (seed: number) => Tone[]> = {
  question: () => [
    {
      type: "triangle",
      freqs: [220, 520, 330, 300],
      start: 0,
      dur: 0.42,
      wobble: 70,
      wobbleRate: 22,
      gain: 0.7,
    },
  ],
  approval: () => [
    { type: "sine", freqs: [note(3)], start: 0, dur: 0.14, gain: 0.55 },
    { type: "sine", freqs: [note(10)], start: 0.13, dur: 0.22, gain: 0.6 },
    { type: "triangle", freqs: [note(22)], start: 0.13, dur: 0.18, gain: 0.12 },
  ],
  error: () => [
    {
      type: "sawtooth",
      freqs: [note(-2), note(-3)],
      start: 0,
      dur: 0.24,
      gain: 0.22,
      wobble: 6,
      wobbleRate: 7,
    },
    {
      type: "sawtooth",
      freqs: [note(-4), note(-5)],
      start: 0.24,
      dur: 0.24,
      gain: 0.22,
      wobble: 6,
      wobbleRate: 7,
    },
    {
      type: "sawtooth",
      freqs: [note(-6), note(-11)],
      start: 0.48,
      dur: 0.55,
      gain: 0.24,
      wobble: 10,
      wobbleRate: 6,
    },
  ],
  done: () => [
    { type: "triangle", freqs: [note(3)], start: 0, dur: 0.12, gain: 0.5 },
    { type: "triangle", freqs: [note(7)], start: 0.09, dur: 0.12, gain: 0.5 },
    { type: "triangle", freqs: [note(10)], start: 0.18, dur: 0.12, gain: 0.5 },
    {
      type: "sine",
      freqs: [note(15)],
      start: 0.27,
      dur: 0.45,
      gain: 0.55,
      wobble: 8,
      wobbleRate: 6,
    },
  ],
  sent: () => [
    { type: "sine", freqs: [380, 1100], start: 0, dur: 0.08, gain: 0.6 },
  ],
  peek: () => [
    { type: "sine", freqs: [1500, 2300], start: 0, dur: 0.06, gain: 0.25 },
    { type: "sine", freqs: [1900, 2600], start: 0.08, dur: 0.05, gain: 0.2 },
  ],
  babble: (seed) => {
    // Three to five squeaky syllables at a per-speaker pitch: gibberish
    // that reads as talking without being words.
    const base = 520 + (seed % 7) * 70;
    const n = 3 + (seed % 3);
    const out: Tone[] = [];
    for (let i = 0; i < n; i++) {
      const jitter = ((seed * (i + 3)) % 9) - 4;
      const f = base * 2 ** (jitter / 12);
      out.push({
        type: "square",
        freqs: [f, f * 1.12, f * 0.94],
        start: i * 0.085,
        dur: 0.07,
        gain: 0.08,
      });
    }
    return out;
  },
  listen_start: () => [
    { type: "sine", freqs: [660, 990], start: 0, dur: 0.09, gain: 0.35 },
  ],
  listen_stop: () => [
    { type: "sine", freqs: [990, 560], start: 0, dur: 0.09, gain: 0.35 },
  ],
};

/** The tones a sound is made of (exported for tests). */
export function recipe(kind: SoundKind, seed = 0): Tone[] {
  return RECIPES[kind](seed);
}

/** Plays `kind` unless sound is off. Never throws. */
export function play(kind: SoundKind, seed = 0): void {
  if (!enabled) return;
  const c = audio();
  if (!(c && master)) return;
  try {
    if (c.state === "suspended") void c.resume();
    const t0 = c.currentTime + 0.01;
    for (const t of recipe(kind, seed)) tone(c, master, t0, t);
  } catch {
    // An audio glitch must never break the notch.
  }
}

/** The sound for a newly arrived attention item. */
export function soundForAttention(kind: string): SoundKind {
  return kind === "approval" ? "approval" : "question";
}
