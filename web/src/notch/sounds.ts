// Cartoon sound effects for the notch, synthesized live with Web Audio.
//
// Nothing is sampled or bundled: every effect is a few oscillators (or a
// burst of noise) with pitch, filter and gain envelopes, so the sounds are
// ours, weigh nothing, and can be tuned in code. They are written the way
// a Saturday-morning cartoon's foley is: a slide whistle for something
// coming your way, a spring for a question, a bicycle bell for a yes, a
// muted trombone for a flop, a xylophone run and a cymbal for a win, a
// bubble pop for a send. One sound per kind of moment, so the human learns
// what happened before looking:
//
//   question      slide whistle up, then a "boing": someone has a question
//   approval      "ding ding!" a counter bell, twice: something waits on your yes
//   error         "wah wah wah waaah": the sad trombone, with the mute in
//   done          "ta-daaa!": a xylophone run up and a cymbal shimmer
//   sent          "pop!": a bubble pop when you answer or send
//   peek          "yoo-hoo": a squeaky two-note call when an agent peeks out
//   babble        gibberish: squeaky syllables while bored agents chat
//   listen        a short whistle up / down as voice capture starts and stops
//   whoosh        air rushing past as an agent flies in to the notch
//   sparkle       a glockenspiel twinkle up and a shimmer: a bot is born
//   clap          two quick claps: an answer landed, the bot is pleased
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
  | "listen_stop"
  | "whoosh"
  | "sparkle"
  | "clap";

const STORAGE_KEY = "gawkbot.notch.sound";

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
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

/** A filter on a tone: its cutoff follows `freqs` over the tone's length. */
interface ToneFilter {
  type: "lowpass" | "bandpass" | "highpass";
  freqs: number[];
  q?: number;
}

export interface Tone {
  /** Oscillator wave, or `noise` for a burst of white noise. */
  type?: OscillatorType | "noise";
  /** Frequencies (Hz) at evenly spaced points over the tone's duration. */
  freqs: number[];
  start: number;
  dur: number;
  gain?: number;
  /** How long the gain takes to reach its peak (a soft or a hard start). */
  attack?: number;
  /** Vibrato depth in Hz, fading out over the tone (the "boing" wobble). */
  wobble?: number;
  wobbleRate?: number;
  /** Keep the wobble going instead of fading it (a slide whistle's warble). */
  wobbleHold?: boolean;
  filter?: ToneFilter;
}

/** Two seconds of white noise, made once. */
function noise(c: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

/** Ramp `param` through `values`, spread evenly from `start` to `end`. */
function ramp(
  param: AudioParam,
  values: number[],
  start: number,
  end: number,
): void {
  const step = (end - start) / Math.max(1, values.length - 1);
  param.setValueAtTime(Math.max(20, values[0]), start);
  values.slice(1).forEach((v, i) => {
    param.exponentialRampToValueAtTime(Math.max(20, v), start + step * (i + 1));
  });
}

function tone(c: AudioContext, out: AudioNode, t0: number, spec: Tone): void {
  const start = t0 + spec.start;
  const end = start + spec.dur;
  let source: AudioScheduledSourceNode;
  if (spec.type === "noise") {
    const src = c.createBufferSource();
    src.buffer = noise(c);
    src.loop = true;
    source = src;
  } else {
    const osc = c.createOscillator();
    osc.type = spec.type ?? "sine";
    ramp(osc.frequency, spec.freqs, start, end);
    if (spec.wobble) {
      const lfo = c.createOscillator();
      const depth = c.createGain();
      lfo.frequency.value = spec.wobbleRate ?? 18;
      depth.gain.setValueAtTime(spec.wobble, start);
      if (!spec.wobbleHold) {
        depth.gain.exponentialRampToValueAtTime(0.01, end);
      }
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(start);
      lfo.stop(end);
    }
    source = osc;
  }
  let head: AudioNode = source;
  if (spec.filter) {
    const f = c.createBiquadFilter();
    f.type = spec.filter.type;
    f.Q.value = spec.filter.q ?? 1;
    ramp(f.frequency, spec.filter.freqs, start, end);
    head.connect(f);
    head = f;
  }
  const g = c.createGain();
  const peak = spec.gain ?? 0.6;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(
    peak,
    start + Math.min(spec.attack ?? 0.012, spec.dur / 4),
  );
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  head.connect(g).connect(out);
  source.start(start);
  source.stop(end + 0.02);
}

/** Note frequency from a semitone offset to A4. */
const note = (semi: number) => 440 * 2 ** (semi / 12);

/** A bell: a bright partial a tenth above, dying faster than the fundamental. */
function bell(f: number, start: number, dur: number, gain: number): Tone[] {
  return [
    { type: "sine", freqs: [f], start, dur, gain, attack: 0.004 },
    {
      type: "sine",
      freqs: [f * 2.76],
      start,
      dur: dur * 0.45,
      gain: gain * 0.35,
      attack: 0.002,
    },
  ];
}

/** A xylophone bar: a quick wooden tick on a short sine. */
function bar(semi: number, start: number, gain = 0.5): Tone[] {
  const f = note(semi);
  return [
    { type: "sine", freqs: [f], start, dur: 0.16, gain, attack: 0.003 },
    {
      type: "triangle",
      freqs: [f * 3],
      start,
      dur: 0.05,
      gain: gain * 0.25,
      attack: 0.002,
    },
  ];
}

/** The muted trombone: a sawtooth under a wah of lowpass, with vibrato. */
function trombone(
  from: number,
  to: number,
  start: number,
  dur: number,
  gain: number,
): Tone {
  return {
    type: "sawtooth",
    freqs: [note(from), note(to)],
    start,
    dur,
    gain,
    attack: 0.04,
    wobble: 7,
    wobbleRate: 5.5,
    wobbleHold: true,
    filter: { type: "lowpass", freqs: [1600, 500, 900, 420], q: 4 },
  };
}

const RECIPES: Record<SoundKind, (seed: number) => Tone[]> = {
  // A slide whistle swoops up, then the spring goes "boing".
  question: () => [
    {
      type: "sine",
      freqs: [320, 420, 980],
      start: 0,
      dur: 0.3,
      gain: 0.5,
      attack: 0.03,
      wobble: 14,
      wobbleRate: 9,
      wobbleHold: true,
    },
    {
      type: "triangle",
      freqs: [260, 620, 340, 330],
      start: 0.3,
      dur: 0.5,
      gain: 0.7,
      wobble: 110,
      wobbleRate: 24,
      filter: { type: "lowpass", freqs: [4200, 1400], q: 1.5 },
    },
  ],
  // "Ding ding!" the counter bell, hit twice, the second a touch higher.
  approval: () => [
    ...bell(note(19), 0, 0.5, 0.5),
    ...bell(note(21), 0.16, 0.6, 0.55),
  ],
  // The sad trombone: three stumbling steps down and the long sigh.
  error: () => [
    trombone(-7, -7.6, 0, 0.26, 0.26),
    trombone(-8, -8.6, 0.27, 0.26, 0.26),
    trombone(-9, -9.6, 0.54, 0.26, 0.26),
    trombone(-10, -13, 0.82, 0.62, 0.3),
  ],
  // "Ta-daaa!": a xylophone run up, a held sparkle, and a cymbal shimmer.
  done: () => [
    ...bar(0, 0),
    ...bar(4, 0.07),
    ...bar(7, 0.14),
    ...bar(12, 0.21, 0.55),
    {
      type: "sine",
      freqs: [note(16), note(16)],
      start: 0.3,
      dur: 0.7,
      gain: 0.45,
      attack: 0.01,
      wobble: 6,
      wobbleRate: 6,
      wobbleHold: true,
    },
    {
      type: "sine",
      freqs: [note(19)],
      start: 0.3,
      dur: 0.6,
      gain: 0.22,
      attack: 0.01,
    },
    {
      type: "noise",
      freqs: [1],
      start: 0.3,
      dur: 0.75,
      gain: 0.16,
      attack: 0.005,
      filter: { type: "bandpass", freqs: [7000, 3500], q: 0.8 },
    },
  ],
  // A bubble pop: a fast pitch drop with a tiny click in front of it.
  sent: () => [
    {
      type: "noise",
      freqs: [1],
      start: 0,
      dur: 0.02,
      gain: 0.2,
      attack: 0.001,
      filter: { type: "highpass", freqs: [2500], q: 0.7 },
    },
    {
      type: "sine",
      freqs: [1100, 380],
      start: 0.005,
      dur: 0.1,
      gain: 0.7,
      attack: 0.003,
    },
  ],
  // "Yoo-hoo": two squeaky notes, the second swooping down.
  peek: () => [
    {
      type: "sine",
      freqs: [1500, 1950],
      start: 0,
      dur: 0.09,
      gain: 0.28,
      attack: 0.01,
      wobble: 30,
      wobbleRate: 20,
      wobbleHold: true,
    },
    {
      type: "sine",
      freqs: [1900, 1350],
      start: 0.11,
      dur: 0.14,
      gain: 0.26,
      attack: 0.01,
      wobble: 30,
      wobbleRate: 20,
      wobbleHold: true,
    },
  ],
  babble: (seed) => {
    // Three to five squeaky syllables at a per-speaker pitch, each with its
    // own little swoop, and a rising one at the end now and then: gibberish
    // that reads as talking without being words.
    const base = 480 + (seed % 7) * 70;
    const n = 3 + (seed % 3);
    const out: Tone[] = [];
    for (let i = 0; i < n; i++) {
      const jitter = ((seed * (i + 3)) % 9) - 4;
      const f = base * 2 ** (jitter / 12);
      const up = i === n - 1 && seed % 2 === 0;
      out.push({
        type: "square",
        freqs: up ? [f, f * 1.08, f * 1.35] : [f * 0.92, f * 1.1, f * 0.96],
        start: i * 0.095,
        dur: 0.075,
        gain: 0.09,
        attack: 0.008,
        filter: { type: "lowpass", freqs: [2600, 1400], q: 2 },
      });
    }
    return out;
  },
  // A short slide whistle up as the mic opens, and down as it closes.
  listen_start: () => [
    {
      type: "sine",
      freqs: [560, 1100],
      start: 0,
      dur: 0.14,
      gain: 0.35,
      attack: 0.02,
      wobble: 10,
      wobbleRate: 9,
      wobbleHold: true,
    },
  ],
  listen_stop: () => [
    {
      type: "sine",
      freqs: [1100, 520],
      start: 0,
      dur: 0.14,
      gain: 0.35,
      attack: 0.02,
      wobble: 10,
      wobbleRate: 9,
      wobbleHold: true,
    },
  ],
  // Air rushing past: noise through a bandpass that sweeps up and back down,
  // with a soft low swoop under it so it has a body.
  whoosh: () => [
    {
      type: "noise",
      freqs: [1],
      start: 0,
      dur: 0.62,
      gain: 0.32,
      attack: 0.22,
      filter: { type: "bandpass", freqs: [500, 2600, 900], q: 1.6 },
    },
    {
      type: "sine",
      freqs: [180, 340, 220],
      start: 0.06,
      dur: 0.5,
      gain: 0.18,
      attack: 0.15,
    },
  ],
  // A glockenspiel twinkle: a quick run up a major arpeggio, high and bell
  // bright, over a shimmer of airy noise.
  sparkle: () => [
    ...bell(note(19), 0, 0.32, 0.22),
    ...bell(note(23), 0.06, 0.32, 0.22),
    ...bell(note(26), 0.12, 0.34, 0.22),
    ...bell(note(31), 0.18, 0.6, 0.26),
    {
      type: "noise",
      freqs: [1],
      start: 0.05,
      dur: 0.6,
      gain: 0.08,
      attack: 0.1,
      filter: { type: "highpass", freqs: [6000, 9000], q: 0.7 },
    },
  ],
  // Two claps: each a short burst of bandpassed noise with a slap of body.
  clap: () =>
    [0, 0.17].flatMap((start) => [
      {
        type: "noise" as const,
        freqs: [1],
        start,
        dur: 0.09,
        gain: 0.5,
        attack: 0.002,
        filter: { type: "bandpass" as const, freqs: [1400, 1000], q: 1.2 },
      },
      {
        type: "triangle" as const,
        freqs: [220, 120],
        start,
        dur: 0.05,
        gain: 0.25,
        attack: 0.002,
      },
    ]),
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
