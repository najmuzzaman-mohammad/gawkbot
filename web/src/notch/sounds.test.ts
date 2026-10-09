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

  it("is cartoon foley, not beeps: slides, springs, a wah and a shimmer", () => {
    // The slide whistle swoops over at least an octave before the boing.
    const [whistle, boing] = recipe("question");
    expect(whistle.freqs.at(-1)! / whistle.freqs[0]).toBeGreaterThan(2);
    expect(boing.wobble).toBeGreaterThan(50);
    // The trombone is a filtered sawtooth that only ever goes down.
    for (const t of recipe("error")) {
      expect(t.type).toBe("sawtooth");
      expect(t.filter?.type).toBe("lowpass");
      expect(t.freqs[1]).toBeLessThan(t.freqs[0]);
    }
    // The ta-da ends on a cymbal: a bandpassed noise burst.
    expect(recipe("done").some((t) => t.type === "noise" && t.filter)).toBe(
      true,
    );
    // A pop drops an octave and more in a tenth of a second.
    const pop = recipe("sent").find((t) => t.type === "sine");
    expect(pop && pop.freqs[0] / pop.freqs[1]).toBeGreaterThan(2);
    expect(pop?.dur).toBeLessThanOrEqual(0.1);
  });

  it("maps approvals and questions to different sounds", () => {
    expect(soundForAttention("approval")).toBe("approval");
    expect(soundForAttention("interview")).toBe("question");
  });
});
