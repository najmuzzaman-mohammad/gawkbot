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
        expect(t.freqs.every((f) => f > 20 && f < 8000)).toBe(true);
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

  it("maps approvals and questions to different sounds", () => {
    expect(soundForAttention("approval")).toBe("approval");
    expect(soundForAttention("interview")).toBe("question");
  });
});
