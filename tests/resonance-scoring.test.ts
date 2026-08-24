import { describe, expect, it } from "vitest";

import { generateResonanceLevel } from "../apps/web/src/features/voice-arcade/resonance-level";
import {
  authoredResonanceRouteDistance,
  createResonanceRunStats,
  recordResonanceCollisionAdvance,
  resonanceTunedEnergyForTarget,
  summarizeResonanceRun,
} from "../apps/web/src/features/voice-arcade/resonance-scoring";
import {
  createResonanceGame,
  type ResonanceGameState,
} from "../apps/web/src/features/voice-arcade/resonance-physics";

function chamber(): ResonanceGameState {
  return createResonanceGame(generateResonanceLevel({
    seed: "scoring-proof",
    level: 4,
    difficulty: "hard",
    lowMidi: 43,
    highMidi: 58,
    baselineMidi: 48,
  }).definition);
}

describe("Resonance grading invariants", () => {
  it("uses the authored gate route instead of an impossible straight line", () => {
    const game = chamber();
    const straight = Math.hypot(
      game.level.goal.position.x - game.level.ball.position.x,
      game.level.goal.position.y - game.level.ball.position.y,
    );
    const authored = authoredResonanceRouteDistance(game);
    expect(authored).toBeGreaterThanOrEqual(straight);

    const stats = createResonanceRunStats(game);
    stats.pathDistance = authored;
    stats.effectiveIntensityIntegral = 8;
    stats.coherentDriveIntegral = 8;
    stats.tunedEnergyIntegral = 8;
    const result = summarizeResonanceRun({ ...game, elapsedSeconds: 20 }, stats);
    expect(result.pathEfficiencyPercent).toBe(100);
    expect(result.coherentEfficiencyPercent).toBe(100);
    expect(result.tunedEfficiencyPercent).toBe(100);
    expect(result.score).toBe(100);
    expect(result.grade).toBe("S");
  });

  it("compares tuned transfer with canonical coherent energy in the same units", () => {
    const game = chamber();
    const stats = createResonanceRunStats(game);
    stats.pathDistance = authoredResonanceRouteDistance(game);
    stats.effectiveIntensityIntegral = 12;
    stats.coherentDriveIntegral = 9;
    stats.tunedEnergyIntegral = 6;
    const result = summarizeResonanceRun({ ...game, elapsedSeconds: 50 }, stats);
    expect(result.coherentEfficiencyPercent).toBeCloseTo(75, 8);
    expect(result.tunedEfficiencyPercent).toBeCloseTo(66.666666, 5);
    expect(result.tunedEfficiencyPercent).toBeLessThan(100);
  });

  it("does not award a stronger irrelevant resonator than the focused target", () => {
    const game = chamber();
    const focused = game.level.resonators[0]!;
    const irrelevant = game.level.resonators[1]!;
    const scoredState: ResonanceGameState = {
      ...game,
      voice: { ...game.voice, active: true, directEnergy: .8 },
      resonatorActivations: game.resonatorActivations.map((activation) => ({
        ...activation,
        effectiveEnergy: activation.resonatorId === focused.id
          ? .12
          : activation.resonatorId === irrelevant.id
            ? .8
            : 0,
      })),
    };
    expect(Math.max(...scoredState.resonatorActivations.map((item) => item.effectiveEnergy)))
      .toBe(.8);
    expect(resonanceTunedEnergyForTarget(scoredState, focused.id)).toBe(.12);
  });

  it("collapses repeated solver contacts into separate collision episodes", () => {
    const stats = createResonanceRunStats(chamber());
    recordResonanceCollisionAdvance(stats, 0, 3, .05);
    recordResonanceCollisionAdvance(stats, 3, 7, .05);
    recordResonanceCollisionAdvance(stats, 7, 10, .05);
    expect(stats.collisionEpisodes).toBe(1);

    recordResonanceCollisionAdvance(stats, 10, 10, .2);
    recordResonanceCollisionAdvance(stats, 10, 11, .05);
    expect(stats.collisionEpisodes).toBe(2);
  });
});
