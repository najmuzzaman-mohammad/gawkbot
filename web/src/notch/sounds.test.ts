import { describe, expect, it } from "vitest";

import { recipe, type SoundKind, soundForAttention } from "./sounds";

const KINDS: SoundKind[] = [
  "question",
  "approval",
  "error",
  "done",
  "sent",
  "peek",
  "babble",
  "listen_start",
  "listen_stop",
  "whoosh",
  "sparkle",
  "clap",
  "poof",
  "ratchet",
  "thud",
  "strain",
  "honk",
  "rollup",
  "phew",
  "zip",
];

describe("sounds", () => {
  it("every kind of moment has its own, short, well-formed sound", () => {
    const fingerprints = new Set<string>();
    for (const kind of KINDS) {
      const tones = recipe(kind, 3);
      expect(tones.length).toBeGreaterThan(0);
      for (const t of tones) {
        // A noise burst has no pitch; its filter has one.
        if (t.type !== "noise") {
          expect(t.freqs.every((f) => f > 20 && f < 8000)).toBe(true);
        }
        if (t.filter) {
          expect(t.filter.freqs.every((f) => f > 20 && f < 20000)).toBe(true);
        }
        expect(t.dur).toBeGreaterThan(0);
        expect(t.start + t.dur).toBeLessThan(1.5);
      }
      fingerprints.add(JSON.stringify(tones));
    }
    expect(fingerprints.size).toBe(KINDS.length);
  });

  it("gives each babbling agent its own voice", () => {
    expect(JSON.stringify(recipe("babble", 1))).not.toBe(
      JSON.stringify(recipe("babble", 2)),
    );
  });

  it("is 1930s foley, not beeps: a whistle, a jaw harp, a plunger mute, a cymbal", () => {
    // The slide whistle swoops over at least an octave before the boing.
    const q = recipe("question");
    const whistle = q[0];
    const boing = q[q.length - 1];
    expect(
      whistle.freqs[whistle.freqs.length - 1] / whistle.freqs[0],
    ).toBeGreaterThan(2);
    expect(boing.wobble).toBeGreaterThan(50);
    // The muted trumpet is a filtered sawtooth that only ever goes down.
    for (const t of recipe("error")) {
      expect(t.type).toBe("sawtooth");
      expect(t.filter?.type).toBe("lowpass");
      expect(t.freqs[1]).toBeLessThan(t.freqs[0]);
    }
    // The ta-da ends on a cymbal: a bandpassed noise burst.
    expect(recipe("done").some((t) => t.type === "noise" && t.filter)).toBe(
      true,
    );
    // A cork pop drops an octave and more in a tenth of a second.
    const pop = recipe("sent").find((t) => t.type === "sine");
    expect(pop && pop.freqs[0] / pop.freqs[1]).toBeGreaterThan(2);
    expect(pop?.dur).toBeLessThanOrEqual(0.1);
    // The bicycle bell is one bright note struck fast, many times.
    const bell = recipe("approval").filter((t) => t.dur >= 0.26);
    expect(bell.length).toBeGreaterThan(5);
    expect(new Set(bell.map((t) => Math.round(t.freqs[0]))).size).toBe(1);
  });

  it("gives the character's moves their own foley", () => {
    // A whoosh is air, not a note: a swept bandpass on noise.
    const air = recipe("whoosh").find((t) => t.type === "noise");
    expect(air?.filter?.type).toBe("bandpass");
    // The twinkle climbs: every bell starts higher than the one before.
    const bells = recipe("sparkle").filter(
      (t) => t.type === "sine" && t.dur >= 0.3,
    );
    expect(bells.length).toBe(4);
    for (let i = 1; i < bells.length; i++) {
      expect(bells[i].freqs[0]).toBeGreaterThan(bells[i - 1].freqs[0]);
      expect(bells[i].start).toBeGreaterThan(bells[i - 1].start);
    }
    // Two woodblocks, each a knock of noise.
    expect(recipe("clap").filter((t) => t.type === "noise").length).toBe(2);
  });

  it("gives the blind its foley: a ratchet down, a flutter up", () => {
    // Coming down: the whistle falls while the ratchet clicks speed up.
    const down = recipe("ratchet");
    const [whistle] = down;
    expect(whistle.freqs[whistle.freqs.length - 1]).toBeLessThan(
      whistle.freqs[0],
    );
    const clicks = down
      .filter((t) => t.type === "noise" && t.dur < 0.05)
      .map((t) => t.start);
    expect(clicks.length).toBeGreaterThan(6);
    const gaps = clicks.slice(1).map((s, i) => s - clicks[i]);
    expect(gaps[gaps.length - 1]).toBeLessThan(gaps[0]);
    // Going up: the whistle rises and it ends on the roller's thwack.
    const up = recipe("rollup");
    expect(up[0].freqs[up[0].freqs.length - 1]).toBeGreaterThan(
      up[0].freqs[0] * 3,
    );
    const last = Math.max(...up.map((t) => t.start));
    expect(up.some((t) => t.start === last && t.type === "sine")).toBe(true);
    // Phew is breath: noise first.
    expect(recipe("phew")[0].type).toBe("noise");
  });

  it("maps approvals and questions to different sounds", () => {
    expect(soundForAttention("approval")).toBe("approval");
    expect(soundForAttention("interview")).toBe("question");
  });
});
