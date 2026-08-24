import { describe, expect, it } from "vitest";
import { midiToFrequency } from "@noteforge/pitch-engine";
import { generateResonanceLevel } from "../apps/web/src/features/voice-arcade/resonance-level";
import {
  advanceResonanceGame,
} from "../apps/web/src/features/voice-arcade/resonance-physics";
import type {
  ResonanceGameState,
  ResonanceVoiceInput,
} from "../apps/web/src/features/voice-arcade/resonance-types";
import { createResonanceGame } from "../apps/web/src/features/voice-arcade/resonance-world";

function nextTargetMidi(state: Readonly<ResonanceGameState>): number {
  return state.level.resonators.find((resonator) => (
    resonator.position.x >= state.ball.position.x
  ))?.targetMidi ?? state.level.resonators.at(-1)?.targetMidi ?? 48;
}

function coherentVoice(midiFloat: number): ResonanceVoiceInput {
  return {
    voiced: true,
    midiFloat,
    frequencyHz: midiToFrequency(midiFloat),
    normalizedLevel: .67,
    coherentDrive: .67,
    confidence: .97,
    stability: .98,
  };
}

/** The same focus policy used by the UI, exercised without rendering cadence. */
function solveGeneratedChamber(
  seed: string,
  difficulty: "easy" | "medium" | "hard",
): ResonanceGameState {
  const generated = generateResonanceLevel({
    seed,
    level: 1,
    difficulty,
    lowMidi: 43,
    highMidi: 55,
    baselineMidi: 48,
  });
  let state = createResonanceGame(generated.definition);
  for (let step = 0; step < 12_000 && state.status === "playing"; step += 1) {
    state = advanceResonanceGame(
      state,
      coherentVoice(nextTargetMidi(state)),
      .01,
    ).state;
  }
  return state;
}

describe("generated Resonance simulation regression (not live-input proof)", () => {
  it.each([
    { seed: "easy-a", difficulty: "easy" as const },
    { seed: "easy-b", difficulty: "easy" as const },
    { seed: "medium-a", difficulty: "medium" as const },
    { seed: "medium-b", difficulty: "medium" as const },
    { seed: "hard-a", difficulty: "hard" as const },
    { seed: "hard-b", difficulty: "hard" as const },
  ])(
    "lets an ideal coherent controller solve a $difficulty generated chamber ($seed)",
    ({ seed, difficulty }) => {
      const state = solveGeneratedChamber(seed, difficulty);
      expect(state.status, JSON.stringify({
        ball: state.ball,
        goal: state.level.goal,
        resonator: state.level.resonators[0],
        collisions: state.collisionCount,
      })).toBe("won");
      expect(state.elapsedSeconds).toBeLessThan(120);
      expect(state.fixedStepCount).toBeGreaterThan(0);
    },
  );

  it("keeps the seeded generator controllably solvable across all difficulties", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      for (let seed = 0; seed < 20; seed += 1) {
        const state = solveGeneratedChamber(`solver-proof-${difficulty}-${seed}`, difficulty);
        expect(state.status, JSON.stringify({
          difficulty,
          seed,
          ball: state.ball.position,
          goal: state.level.goal.position,
          resonators: state.level.resonators,
          obstacles: state.level.obstacles,
          collisions: state.collisionCount,
        })).toBe("won");
      }
    }
  });
});
