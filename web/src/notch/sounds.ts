// Cartoon sound effects for the notch, synthesised live with Web Audio,
// in the foley of a 1930s cartoon short.
//
// Nothing is sampled or bundled: every effect is a few oscillators, or a
// burst of noise, with pitch, filter and gain envelopes, so the sounds are
// ours and weigh nothing. They are built from the instruments a studio
// orchestra of the era used for effects: the slide whistle, the xylophone
// and the glockenspiel, a muted trumpet with a plunger "wah", a bulb horn,
// a bicycle bell, woodblocks, a ratchet, a jaw harp, a bass drum and a
// cymbal. And every one plays through the same chain, an optical sound
// track of the time: the lows and highs gone, a little grit, a slow wow,
// and crackle under it (see `vintage`).
//
//   question      slide whistle up, then a jaw-harp "boing"
//   approval      a bicycle bell: "brrring!"
//   error         muted trumpet, plunger wah: "wah wah wah waaah"
//   done          xylophone run up, a harp sweep and a cymbal: "ta-daaa!"
//   sent          a cork pop and a woodblock "tock"
//   peek          kazoo "yoo-hoo"
//   babble        muted trumpet gibberish while bored agents chat
//   listen        a short slide whistle up / down as voice capture starts and stops
//   whoosh        a slide-whistle swoop and a brushed cymbal
//   sparkle       a harp glissando and a glockenspiel twinkle
//   clap          two woodblocks
//   poof          a bass drum, a choked cymbal and a whistle dropping away
//   ratchet       the blind's ratchet under a falling slide whistle and xylophone
//   thud          a bass drum and a wood thump
//   strain        a muted trumpet growl and a creak
//   honk          a bulb horn, squeezed twice
//   rollup        the ratchet racing, a whistle shooting up, a woodblock thwack
//   phew          a long slide whistle down and a breath
//   zip           a whistle up fast and one xylophone note
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
  | "clap"
  | "poof"
  | "ratchet"
  | "thud"
  | "strain"
  | "honk"
  | "rollup"
  | "phew"
  | "zip";

const STORAGE_KEY = "gawkbot.notch.sound";

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let crackleBus: GainNode | null = null;
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
    master.gain.value = 0.34;
    crackleBus = ctx.createGain();
    crackleBus.gain.value = 0.02;
    const out = vintage(ctx);
    master.connect(out);
    crackleBus.connect(out);
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * The optical track: everything below 240 Hz and above 4.8 kHz is gone,
 * the middle is a little gritty (a soft clip), and a slow wow of a few
 * cents rides on it, the way a 1930s print ran through a projector.
 */
function vintage(c: AudioContext): AudioNode {
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 240;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 4800;
  lp.Q.value = 0.8;
  const grit = c.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
  }
  grit.curve = curve;
  const wow = c.createDelay(0.05);
  wow.delayTime.value = 0.006;
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.7;
  const depth = c.createGain();
  depth.gain.value = 0.0007;
  lfo.connect(depth).connect(wow.delayTime);
  lfo.start();
  hp.connect(lp).connect(grit).connect(wow).connect(c.destination);
  return hp;
}

/** Dust on the print: crackle under a sound, for as long as it lasts. */
function crackle(c: AudioContext, t0: number, dur: number): void {
  if (!crackleBus) return;
  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = 2600;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(1, t0 + 0.03);
  g.gain.setValueAtTime(1, t0 + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.25);
  src.connect(f).connect(g).connect(crackleBus);
  src.start(t0);
  src.stop(t0 + dur + 0.3);
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

// ── The instruments ──────────────────────────────────────────────────

/** A slide whistle: a breathy sine gliding through `freqs`, with a warble. */
function whistle(
  freqs: number[],
  start: number,
  dur: number,
  gain: number,
): Tone[] {
  return [
    {
      type: "sine",
      freqs,
      start,
      dur,
      gain,
      attack: 0.025,
      wobble: 9,
      wobbleRate: 7,
      wobbleHold: true,
    },
    {
      type: "noise",
      freqs: [1],
      start,
      dur,
      gain: gain * 0.12,
      attack: 0.03,
      filter: { type: "bandpass", freqs: freqs.map((f) => f * 2), q: 6 },
    },
  ];
}

/** A xylophone bar: a quick wooden tick on a short sine. */
function xylo(semi: number, start: number, gain = 0.5): Tone[] {
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

/** A glockenspiel bar: a bright partial a tenth above, dying faster. */
function glock(f: number, start: number, dur: number, gain: number): Tone[] {
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

/** A muted trumpet with the plunger working: a sawtooth under a wah. */
function trumpet(
  from: number,
  to: number,
  start: number,
  dur: number,
  gain: number,
  wah: number[] = [1400, 500, 900, 420],
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
    filter: { type: "lowpass", freqs: wah, q: 4 },
  };
}

/** A woodblock: a knock, hollow and short. */
function woodblock(start: number, gain = 0.5, pitch = 1100): Tone[] {
  return [
    {
      type: "noise",
      freqs: [1],
      start,
      dur: 0.045,
      gain: gain * 0.7,
      attack: 0.001,
      filter: { type: "bandpass", freqs: [pitch, pitch * 0.8], q: 2.5 },
    },
    {
      type: "sine",
      freqs: [pitch * 0.9, pitch * 0.6],
      start,
      dur: 0.05,
      gain: gain * 0.5,
      attack: 0.001,
    },
  ];
}

/** A bass drum. */
function bassDrum(start: number, gain = 0.7): Tone {
  return {
    type: "sine",
    freqs: [120, 48],
    start,
    dur: 0.2,
    gain,
    attack: 0.003,
  };
}

/** A cymbal: bright noise through a bandpass that falls as it rings. */
function cymbal(start: number, dur: number, gain = 0.16): Tone {
  return {
    type: "noise",
    freqs: [1],
    start,
    dur,
    gain,
    attack: 0.005,
    filter: { type: "bandpass", freqs: [7000, 3500], q: 0.8 },
  };
}

/** A ratchet: clicks at the given times. */
function ratchet(times: number[], gain = 0.35): Tone[] {
  return times.map((start) => ({
    type: "noise" as const,
    freqs: [1],
    start,
    dur: 0.018,
    gain,
    attack: 0.001,
    filter: { type: "bandpass" as const, freqs: [3400], q: 3 },
  }));
}

/** A bulb horn: two reedy tones a third apart, squeezed once. */
function horn(start: number, dur = 0.2): Tone[] {
  return [
    {
      type: "square",
      freqs: [430, 440],
      start,
      dur,
      gain: 0.16,
      attack: 0.01,
      filter: { type: "lowpass", freqs: [1600, 1200], q: 2 },
    },
    {
      type: "square",
      freqs: [545, 554],
      start,
      dur,
      gain: 0.12,
      attack: 0.01,
      filter: { type: "lowpass", freqs: [1800, 1300], q: 2 },
    },
  ];
}

/** A harp glissando: a run of quick plucked notes up (or down). */
function harp(start: number, semis: number[], gain = 0.2): Tone[] {
  return semis.flatMap((semi, i) => [
    {
      type: "triangle" as const,
      freqs: [note(semi)],
      start: start + i * 0.045,
      dur: 0.3,
      gain,
      attack: 0.003,
    },
  ]);
}

// ── The sounds ───────────────────────────────────────────────────────

const RECIPES: Record<SoundKind, (seed: number) => Tone[]> = {
  // A slide whistle swoops up, then the jaw harp goes "boing".
  question: () => [
    ...whistle([320, 420, 980], 0, 0.3, 0.5),
    {
      type: "sawtooth",
      freqs: [260, 620, 340, 330],
      start: 0.3,
      dur: 0.5,
      gain: 0.4,
      wobble: 110,
      wobbleRate: 24,
      filter: { type: "lowpass", freqs: [600, 2400, 500], q: 6 },
    },
  ],
  // "Brrring!": a bicycle bell, the striker hitting a bright bell fast.
  approval: () => [
    ...[0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3].flatMap((start) =>
      glock(note(31), start, 0.26, 0.3),
    ),
    {
      type: "sine",
      freqs: [note(31)],
      start: 0.3,
      dur: 0.5,
      gain: 0.3,
      attack: 0.004,
    },
  ],
  // The trumpet with the plunger in: three stumbling steps down and the long sigh.
  error: () => [
    trumpet(-7, -7.6, 0, 0.26, 0.26),
    trumpet(-8, -8.6, 0.27, 0.26, 0.26),
    trumpet(-9, -9.6, 0.54, 0.26, 0.26),
    trumpet(-10, -13, 0.82, 0.62, 0.3, [1600, 500, 900, 420]),
  ],
  // "Ta-daaa!": a xylophone run up, a harp sweep and a cymbal.
  done: () => [
    ...xylo(0, 0),
    ...xylo(4, 0.07),
    ...xylo(7, 0.14),
    ...xylo(12, 0.21, 0.55),
    ...harp(0.28, [12, 16, 19, 24, 28, 31], 0.16),
    {
      type: "sine",
      freqs: [note(16), note(16)],
      start: 0.3,
      dur: 0.7,
      gain: 0.4,
      attack: 0.01,
      wobble: 6,
      wobbleRate: 6,
      wobbleHold: true,
    },
    cymbal(0.3, 0.75),
  ],
  // A cork pop and a woodblock "tock".
  sent: () => [
    {
      type: "sine",
      freqs: [1100, 380],
      start: 0,
      dur: 0.1,
      gain: 0.7,
      attack: 0.003,
    },
    ...woodblock(0.02, 0.45, 900),
  ],
  // "Yoo-hoo" on a kazoo: a buzzy two-note call.
  peek: () => [
    {
      type: "sawtooth",
      freqs: [520, 660],
      start: 0,
      dur: 0.12,
      gain: 0.14,
      attack: 0.01,
      wobble: 20,
      wobbleRate: 18,
      wobbleHold: true,
      filter: { type: "bandpass", freqs: [1300, 1500], q: 2.5 },
    },
    {
      type: "sawtooth",
      freqs: [640, 440],
      start: 0.14,
      dur: 0.18,
      gain: 0.14,
      attack: 0.01,
      wobble: 20,
      wobbleRate: 18,
      wobbleHold: true,
      filter: { type: "bandpass", freqs: [1400, 1100], q: 2.5 },
    },
  ],
  babble: (seed) => {
    // Three to five "wah"s on a muted trumpet at a per-speaker pitch, each
    // with its own little swoop, a rising one at the end now and then:
    // gibberish that reads as talking without being words.
    const base = -14 + (seed % 7) * 2;
    const n = 3 + (seed % 3);
    const out: Tone[] = [];
    for (let i = 0; i < n; i++) {
      const jitter = ((seed * (i + 3)) % 9) - 4;
      const up = i === n - 1 && seed % 2 === 0;
      out.push(
        trumpet(
          base + jitter,
          base + jitter + (up ? 4 : -1),
          i * 0.11,
          0.09,
          0.1,
          [700, 1600, 800],
        ),
      );
    }
    return out;
  },
  // A short slide whistle up as the mic opens, and down as it closes.
  listen_start: () => whistle([560, 1100], 0, 0.14, 0.35),
  listen_stop: () => whistle([1100, 520], 0, 0.14, 0.35),
  // A swoop on the slide whistle with a brushed cymbal under it.
  whoosh: () => [
    ...whistle([900, 400, 1300], 0, 0.5, 0.26),
    {
      type: "noise",
      freqs: [1],
      start: 0,
      dur: 0.62,
      gain: 0.3,
      attack: 0.22,
      filter: { type: "bandpass", freqs: [500, 2600, 900], q: 1.6 },
    },
  ],
  // A harp glissando up and a glockenspiel twinkle on top.
  sparkle: () => [
    ...harp(0, [7, 11, 14, 19, 23, 26], 0.14),
    ...glock(note(19), 0.1, 0.32, 0.2),
    ...glock(note(23), 0.16, 0.32, 0.2),
    ...glock(note(26), 0.22, 0.34, 0.2),
    ...glock(note(31), 0.28, 0.6, 0.24),
  ],
  // Two woodblocks.
  clap: () => [...woodblock(0, 0.55, 1300), ...woodblock(0.17, 0.5, 1150)],
  // "Poof": a bass drum, a choked cymbal, a whistle dropping away.
  poof: () => [
    bassDrum(0, 0.6),
    cymbal(0, 0.12, 0.25),
    ...whistle([700, 180], 0.02, 0.3, 0.2),
  ],
  // The blind coming down: ratchet clicks speeding up under a slide
  // whistle falling, and three xylophone steps down.
  ratchet: () => [
    ...whistle([1250, 900, 420], 0, 0.68, 0.26),
    ...ratchet([0, 0.11, 0.2, 0.28, 0.35, 0.41, 0.46, 0.51, 0.55, 0.59, 0.63]),
    ...xylo(7, 0.1, 0.3),
    ...xylo(3, 0.32, 0.3),
    ...xylo(-2, 0.56, 0.35),
  ],
  thud: () => [bassDrum(0, 0.75), ...woodblock(0, 0.35, 400)],
  // "Nnngh!": a low trumpet growl under the plunger, and a creak of the spring.
  strain: () => [
    trumpet(-22, -21, 0, 0.42, 0.22, [500, 1100, 600]),
    {
      type: "sawtooth",
      freqs: [340, 290, 330],
      start: 0.05,
      dur: 0.3,
      gain: 0.08,
      attack: 0.02,
      wobble: 40,
      wobbleRate: 30,
      wobbleHold: true,
      filter: { type: "bandpass", freqs: [900, 1400], q: 5 },
    },
  ],
  honk: () => [...horn(0, 0.18), ...horn(0.26, 0.22)],
  // The blind snapping up: the ratchet racing, a whistle shooting up, a
  // xylophone run with it, and a woodblock thwack as it hits the roller.
  rollup: () => [
    ...whistle([380, 700, 1700], 0, 0.36, 0.26),
    ...ratchet([0, 0.07, 0.13, 0.18, 0.22, 0.26, 0.29, 0.32, 0.345], 0.32),
    ...xylo(-2, 0.05, 0.25),
    ...xylo(5, 0.17, 0.25),
    ...xylo(12, 0.29, 0.3),
    ...woodblock(0.38, 0.7, 800),
  ],
  // A long sigh: breath through a closing bandpass, the whistle sliding down.
  phew: () => [
    {
      type: "noise",
      freqs: [1],
      start: 0,
      dur: 0.75,
      gain: 0.22,
      attack: 0.08,
      filter: { type: "bandpass", freqs: [1900, 1100, 600], q: 1.4 },
    },
    ...whistle([820, 700, 380], 0.05, 0.65, 0.12),
  ],
  // The whistle up fast, and one high xylophone note at the top.
  zip: () => [...whistle([300, 700, 1900], 0, 0.2, 0.3), ...xylo(19, 0.2, 0.4)],
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
    const tones = recipe(kind, seed);
    for (const t of tones) tone(c, master, t0, t);
    crackle(c, t0, Math.max(...tones.map((t) => t.start + t.dur)));
  } catch {
    // An audio glitch must never break the notch.
  }
}

/** The sound for a newly arrived attention item. */
export function soundForAttention(kind: string): SoundKind {
  return kind === "approval" ? "approval" : "question";
}
