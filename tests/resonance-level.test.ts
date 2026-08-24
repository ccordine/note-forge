import { describe, expect, it } from "vitest";

import { generateResonanceLevel } from "../apps/web/src/features/voice-arcade/resonance-level";
import {
  evaluateResonanceVoice,
  evaluateResonatorActivation,
} from "../apps/web/src/features/voice-arcade/resonance-voice";
import type { VoiceArcadeDifficulty } from "../apps/web/src/features/voice-arcade/model";

const PROGRESSION = {
  easy: { count: 2, minimum: 1, maximum: 2 },
  medium: { count: 3, minimum: 2, maximum: 4 },
  hard: { count: 4, minimum: 3, maximum: 7 },
} as const satisfies Readonly<Record<VoiceArcadeDifficulty, {
  readonly count: number;
  readonly minimum: number;
  readonly maximum: number;
}>>;

function consecutiveIntervals(notes: readonly number[]): number[] {
  return notes.slice(1).map((note, index) => Math.abs(note - notes[index]!));
}

describe("difficulty-shaped Resonance note progressions", () => {
  it("keeps every wide-range transition inside its deterministic difficulty band", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const expected = PROGRESSION[difficulty];
      for (let seed = 0; seed < 50; seed += 1) {
        const options = {
          seed: `progression-${difficulty}-${seed}`,
          level: (seed % 18) + 1,
          difficulty,
          lowMidi: 36,
          highMidi: 72,
          baselineMidi: 52,
        } as const;
        const first = generateResonanceLevel(options);
        const repeated = generateResonanceLevel(options);
        const notes = first.metadata.targetMidis;

        expect(repeated).toEqual(first);
        expect(notes).toHaveLength(expected.count);
        expect(notes[0]).toBe(options.baselineMidi);
        expect(new Set(notes).size).toBe(notes.length);
        for (const interval of consecutiveIntervals(notes)) {
          expect(interval).toBeGreaterThanOrEqual(expected.minimum);
          expect(interval).toBeLessThanOrEqual(expected.maximum);
        }
      }
    }
  });

  it("falls back within minimum-size profiles without widening or repeating notes", () => {
    const cases = [
      { difficulty: "easy", lowMidi: 52, highMidi: 53, baselineMidi: 52 },
      { difficulty: "medium", lowMidi: 52, highMidi: 54, baselineMidi: 53 },
      { difficulty: "hard", lowMidi: 52, highMidi: 55, baselineMidi: 53 },
    ] as const;

    for (const options of cases) {
      const generated = generateResonanceLevel({
        ...options,
        seed: `minimum-${options.difficulty}`,
        level: 1,
      });
      const notes = generated.metadata.targetMidis;
      expect(notes).toHaveLength(options.highMidi - options.lowMidi + 1);
      expect(new Set(notes)).toEqual(new Set(
        Array.from(
          { length: options.highMidi - options.lowMidi + 1 },
          (_, index) => options.lowMidi + index,
        ),
      ));
    }
  });
});

describe("generated Resonance pitch separation", () => {
  it("keeps an exact adjacent semitone below five percent wrong-resonator activation", () => {
    const voice = evaluateResonanceVoice({
      voiced: true,
      midiFloat: 52,
      frequencyHz: 440 * 2 ** ((52 - 69) / 12),
      normalizedLevel: 2 / 3,
      coherentDrive: 2 / 3,
      confidence: 0.98,
      stability: 0.98,
    });

    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const generated = generateResonanceLevel({
        seed: `adjacent-separation-${difficulty}`,
        level: 1,
        difficulty,
        lowMidi: 43,
        highMidi: 67,
        baselineMidi: 52,
      });
      for (const resonator of generated.definition.resonators) {
        const centered = evaluateResonatorActivation(voice, {
          ...resonator,
          targetMidi: 52,
        });
        const adjacent = evaluateResonatorActivation(voice, {
          ...resonator,
          targetMidi: 53,
        });
        expect(centered.pitchAccuracy).toBe(1);
        expect(adjacent.pitchAccuracy).toBeLessThan(0.05);
        expect(adjacent.effectiveEnergy).toBeLessThan(0.05);
      }
    }
  });
});
