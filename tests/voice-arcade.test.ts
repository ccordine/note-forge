import { describe, expect, it } from "vitest";

import {
  DIFFICULTY_PRESETS,
  createChallengeSession,
  createChallengeSteps,
  createSeededRandom,
  generatePitchPattern,
  getDifficultyPreset,
  gradeChallengeScore,
  mapPitchToNormalizedVertical,
  type ChallengeStep,
} from "../apps/web/src/features/voice-arcade/model";
import {
  DEFAULT_PONG_CONFIG,
  createPongState,
  updatePongState,
  type PongState,
} from "../apps/web/src/features/voice-arcade/pong-physics";

function step(overrides: Partial<ChallengeStep> = {}): ChallengeStep {
  return {
    id: "ddr-1",
    index: 0,
    mode: "ddr",
    targetMidi: 60,
    cueAtSeconds: 0.1,
    windowStartSeconds: 0,
    windowEndSeconds: 1,
    requiredSustainSeconds: 0.4,
    toleranceCents: 20,
    maximumPoints: 1_000,
    ...overrides,
  };
}

describe("Voice Arcade difficulties and seeded patterns", () => {
  it("publishes progressively tighter, longer, and faster difficulty presets", () => {
    expect(Object.keys(DIFFICULTY_PRESETS)).toEqual(["easy", "medium", "hard"]);
    expect(DIFFICULTY_PRESETS.easy.toleranceCents)
      .toBeGreaterThan(DIFFICULTY_PRESETS.medium.toleranceCents);
    expect(DIFFICULTY_PRESETS.medium.toleranceCents)
      .toBeGreaterThan(DIFFICULTY_PRESETS.hard.toleranceCents);
    expect(DIFFICULTY_PRESETS.easy.sustainDurationSeconds)
      .toBeLessThan(DIFFICULTY_PRESETS.hard.sustainDurationSeconds);
    expect(DIFFICULTY_PRESETS.easy.tempoBpm).toBeLessThan(DIFFICULTY_PRESETS.hard.tempoBpm);
    expect(DIFFICULTY_PRESETS.easy.speedMultiplier)
      .toBeLessThan(DIFFICULTY_PRESETS.hard.speedMultiplier);
    expect(getDifficultyPreset("medium")).toBe(DIFFICULTY_PRESETS.medium);
    expect(() => getDifficultyPreset("nightmare" as never)).toThrow(RangeError);
  });

  it("creates a stable seeded random stream without sharing mutable state", () => {
    const first = createSeededRandom("phrase-42");
    const second = createSeededRandom("phrase-42");
    const firstRun = Array.from({ length: 8 }, first);
    const secondRun = Array.from({ length: 8 }, second);

    expect(firstRun).toEqual(secondRun);
    expect(firstRun.every((sample) => sample >= 0 && sample < 1)).toBe(true);
    expect(new Set(firstRun).size).toBeGreaterThan(1);
    expect(() => createSeededRandom(Number.NaN)).toThrow(RangeError);
    expect(() => createSeededRandom({} as never)).toThrow(TypeError);
  });

  it("generates the same bounded baseline-first pattern for the same seed", () => {
    const options = {
      seed: "simon-round-3",
      baselineMidi: 48,
      lowMidi: 43,
      highMidi: 55,
      difficulty: "hard" as const,
      length: 20,
    };
    const first = generatePitchPattern(options);
    const second = generatePitchPattern(options);
    const different = generatePitchPattern({ ...options, seed: "simon-round-4" });

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
    expect(first).toHaveLength(20);
    expect(first[0]).toMatchObject({ targetMidi: 48, offsetFromBaseline: 0, cueBeat: 0 });
    expect(first.every(({ targetMidi }) => targetMidi >= 43 && targetMidi <= 55)).toBe(true);
    expect(first.map(({ cueBeat }) => cueBeat)).toEqual(
      first.map((_, index) => index * DIFFICULTY_PRESETS.hard.beatsPerStep),
    );
  });

  it("falls back to a repeated baseline when the range contains one note", () => {
    expect(generatePitchPattern({
      seed: 7,
      baselineMidi: 60,
      lowMidi: 60,
      highMidi: 60,
      difficulty: "easy",
      length: 4,
    }).map(({ targetMidi }) => targetMidi)).toEqual([60, 60, 60, 60]);
  });

  it("rejects invalid pattern ranges, anchors, lengths, difficulties, and seeds", () => {
    expect(() => generatePitchPattern({ seed: 1, baselineMidi: 48, lowMidi: 55, highMidi: 43 })).toThrow(RangeError);
    expect(() => generatePitchPattern({ seed: 1, baselineMidi: 60, lowMidi: 43, highMidi: 55 })).toThrow(RangeError);
    expect(() => generatePitchPattern({ seed: 1, baselineMidi: 48.5, lowMidi: 43, highMidi: 55 })).toThrow(RangeError);
    expect(() => generatePitchPattern({ seed: 1, baselineMidi: 48, lowMidi: -1, highMidi: 55 })).toThrow(RangeError);
    expect(() => generatePitchPattern({ seed: 1, baselineMidi: 48, lowMidi: 43, highMidi: 55, length: 0 })).toThrow(RangeError);
    expect(() => generatePitchPattern({ seed: 1, baselineMidi: 48, lowMidi: 43, highMidi: 55, length: 129 })).toThrow(RangeError);
    expect(() => generatePitchPattern({ seed: 1, baselineMidi: 48, lowMidi: 43, highMidi: 55, difficulty: "expert" as never })).toThrow(RangeError);
  });
});

describe("Simon and DDR challenge timelines", () => {
  const pattern = generatePitchPattern({
    seed: "timeline",
    baselineMidi: 48,
    lowMidi: 43,
    highMidi: 55,
    difficulty: "medium",
    length: 4,
  });

  it("turns one pattern into non-overlapping DDR response windows", () => {
    const steps = createChallengeSteps(pattern, {
      mode: "ddr",
      difficulty: "medium",
      startAtSeconds: 2,
    });

    expect(steps).toHaveLength(pattern.length);
    expect(steps[0]).toMatchObject({
      id: "ddr-1",
      targetMidi: 48,
      cueAtSeconds: 2,
      windowStartSeconds: 2,
      requiredSustainSeconds: DIFFICULTY_PRESETS.medium.sustainDurationSeconds,
      toleranceCents: DIFFICULTY_PRESETS.medium.toleranceCents,
      maximumPoints: 1_200,
    });
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]!.windowStartSeconds).toBeGreaterThanOrEqual(steps[index - 1]!.windowEndSeconds);
    }
  });

  it("places Simon response windows after their audible cues", () => {
    const steps = createChallengeSteps(pattern, { mode: "simon", difficulty: "easy" });
    expect(steps.every((item) => item.windowStartSeconds > item.cueAtSeconds)).toBe(true);
    expect(steps.every((item) => item.mode === "simon")).toBe(true);
  });

  it("shifts unusually dense custom cues so only one note can be active", () => {
    const densePattern = [
      { index: 0, targetMidi: 60, offsetFromBaseline: 0, cueBeat: 0, durationBeats: 1 },
      { index: 1, targetMidi: 62, offsetFromBaseline: 2, cueBeat: 0.01, durationBeats: 1 },
    ];
    const steps = createChallengeSteps(densePattern, { mode: "ddr", difficulty: "hard" });
    expect(steps[1]!.windowStartSeconds).toBeGreaterThan(steps[0]!.windowEndSeconds);
  });

  it("rejects empty, malformed, unordered, or unknown challenge timelines", () => {
    expect(() => createChallengeSteps([], { mode: "ddr" })).toThrow(RangeError);
    expect(() => createChallengeSteps(pattern, { mode: "karaoke" as never })).toThrow(RangeError);
    expect(() => createChallengeSteps(pattern, { mode: "ddr", startAtSeconds: -1 })).toThrow(RangeError);
    expect(() => createChallengeSteps([
      pattern[0]!,
      { ...pattern[1]!, cueBeat: pattern[0]!.cueBeat },
    ], { mode: "simon" })).toThrow(RangeError);
    expect(() => createChallengeSteps([
      { ...pattern[0]!, targetMidi: 128 },
    ], { mode: "simon" })).toThrow(RangeError);
  });
});

describe("challenge session construction", () => {
  it("creates a ready session with one source of scoring state", () => {
    expect(createChallengeSession([step()])).toMatchObject({
      status: "ready",
      combo: 0,
      accuracyPercent: 0,
    });
  });

  it("rejects invalid sessions", () => {
    expect(() => createChallengeSession([])).toThrow(RangeError);
    expect(() => createChallengeSession([step(), step()])).toThrow(RangeError);
    expect(() => createChallengeSession([
      step(),
      step({ id: "ddr-2", windowStartSeconds: 0.5, windowEndSeconds: 1.5 }),
    ])).toThrow(RangeError);
    expect(() => createChallengeSession([step({ toleranceCents: 0 })])).toThrow(RangeError);

  });
});

describe("challenge grades and summary", () => {
  it.each([
    [0, "D"],
    [64.999, "D"],
    [65, "C"],
    [77.999, "C"],
    [78, "B"],
    [87.999, "B"],
    [88, "A"],
    [94.999, "A"],
    [95, "A+"],
    [100, "A+"],
  ] as const)("maps %s percent to grade %s", (score, grade) => {
    expect(gradeChallengeScore(score).grade).toBe(grade);
  });

  it("rejects non-finite and out-of-range grade percentages", () => {
    for (const score of [-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => gradeChallengeScore(score)).toThrow(RangeError);
    }
  });
});

describe("pitch-to-vertical voice controller", () => {
  const options = { lowMidi: 50, highMidi: 70, centerMidi: 60, deadZoneCents: 50 };

  it("maps high pitch to the top, low pitch to the bottom, and center to half", () => {
    expect(mapPitchToNormalizedVertical(50, options)).toEqual({
      normalizedY: 1,
      clampedMidi: 50,
      inDeadZone: false,
    });
    expect(mapPitchToNormalizedVertical(70, options)).toEqual({
      normalizedY: 0,
      clampedMidi: 70,
      inDeadZone: false,
    });
    expect(mapPitchToNormalizedVertical(60, options)).toEqual({
      normalizedY: 0.5,
      clampedMidi: 60,
      inDeadZone: true,
    });
  });

  it("includes both dead-zone boundaries and moves continuously beyond them", () => {
    expect(mapPitchToNormalizedVertical(59.5, options).normalizedY).toBe(0.5);
    expect(mapPitchToNormalizedVertical(60.5, options).normalizedY).toBe(0.5);
    expect(mapPitchToNormalizedVertical(59.49, options).normalizedY).toBeGreaterThan(0.5);
    expect(mapPitchToNormalizedVertical(60.51, options).normalizedY).toBeLessThan(0.5);
  });

  it("clamps pitches beyond the playable range and supports inverted controls", () => {
    expect(mapPitchToNormalizedVertical(10, options)).toMatchObject({ normalizedY: 1, clampedMidi: 50 });
    expect(mapPitchToNormalizedVertical(100, options)).toMatchObject({ normalizedY: 0, clampedMidi: 70 });
    expect(mapPitchToNormalizedVertical(70, { ...options, invert: true }).normalizedY).toBe(1);
    expect(mapPitchToNormalizedVertical(50, { ...options, invert: true }).normalizedY).toBe(0);
  });

  it("rejects invalid ranges, centers, dead zones, and pitch samples", () => {
    expect(() => mapPitchToNormalizedVertical(Number.NaN, options)).toThrow(RangeError);
    expect(() => mapPitchToNormalizedVertical(60, { lowMidi: 60, highMidi: 60 })).toThrow(RangeError);
    expect(() => mapPitchToNormalizedVertical(60, { lowMidi: 50, highMidi: 70, centerMidi: 70 })).toThrow(RangeError);
    expect(() => mapPitchToNormalizedVertical(60, { ...options, deadZoneCents: -1 })).toThrow(RangeError);
    expect(() => mapPitchToNormalizedVertical(60, { ...options, deadZoneCents: 1_000 })).toThrow(RangeError);
  });
});

describe("deterministic voice-controlled Pong", () => {
  it("creates identical serves for identical seeds and distinct serves for another seed", () => {
    const first = createPongState({ seed: "pong-round", serveToward: "player" });
    const second = createPongState({ seed: "pong-round", serveToward: "player" });
    const different = createPongState({ seed: "another-round", serveToward: "player" });
    expect(first).toEqual(second);
    expect(first.ball.velocityX).toBeLessThan(0);
    expect(first.ball).not.toEqual(different.ball);
    expect(first.config).toEqual(DEFAULT_PONG_CONFIG);
  });

  it("clamps the voice paddle to the court without mutating the previous state", () => {
    const initial = createPongState({ seed: 1 });
    const high = updatePongState(initial, { deltaSeconds: 0, voicePaddleY: -10 });
    const low = updatePongState(initial, { deltaSeconds: 0, voicePaddleY: 10 });
    expect(high.playerPaddleY).toBe(DEFAULT_PONG_CONFIG.paddleHeight / 2);
    expect(low.playerPaddleY).toBe(1 - DEFAULT_PONG_CONFIG.paddleHeight / 2);
    expect(initial.playerPaddleY).toBe(0.5);
    expect(high).not.toBe(initial);
  });

  it("reflects from the top wall without leaving normalized court space", () => {
    const initial = createPongState({ seed: 2 });
    const state: PongState = {
      ...initial,
      ball: { x: 0.5, y: initial.config.ballRadius + 0.001, velocityX: 0.1, velocityY: -0.5 },
    };
    const next = updatePongState(state, { deltaSeconds: 0.02, voicePaddleY: 0.5 });
    expect(next.ball.y).toBeGreaterThanOrEqual(next.config.ballRadius);
    expect(next.ball.velocityY).toBeGreaterThan(0);
  });

  it("bounces from the voice paddle and accelerates a rally", () => {
    const initial = createPongState({ seed: 3, serveToward: "player" });
    const playerSurface = initial.config.playerPaddleX + initial.config.paddleWidth / 2;
    const state: PongState = {
      ...initial,
      ball: {
        x: playerSurface + initial.config.ballRadius + 0.01,
        y: 0.5,
        velocityX: -0.5,
        velocityY: 0,
      },
    };
    const next = updatePongState(state, { deltaSeconds: 0.05, voicePaddleY: 0.5 });
    expect(next.ball.velocityX).toBeGreaterThan(0);
    expect(next.rally).toBe(1);
    expect(next.playerScore).toBe(0);
    expect(state.ball.velocityX).toBe(-0.5);
  });

  it("scores against a missed paddle and deterministically resets the serve", () => {
    const initial = createPongState({ seed: 4, serveToward: "player" });
    const state: PongState = {
      ...initial,
      playerPaddleY: 0.11,
      ball: { x: 0.01, y: 0.85, velocityX: -1, velocityY: 0 },
    };
    const next = updatePongState(state, { deltaSeconds: 0.08, voicePaddleY: 0 });
    const replay = updatePongState(state, { deltaSeconds: 0.08, voicePaddleY: 0 });
    expect(next).toEqual(replay);
    expect(next).toMatchObject({ opponentScore: 1, playerScore: 0, rally: 0, serveIndex: 1 });
    expect(next.ball.velocityX).toBeLessThan(0);
  });

  it("limits AI travel by speed and delta time", () => {
    const initial = createPongState({ seed: 5 });
    const state: PongState = {
      ...initial,
      ball: { x: 0.5, y: 0.9, velocityX: 0, velocityY: 0 },
    };
    const next = updatePongState(state, { deltaSeconds: 0.1, voicePaddleY: 0.5 });
    expect(next.opponentPaddleY - state.opponentPaddleY)
      .toBeCloseTo(initial.config.aiSpeed * 0.1, 10);
    expect(next.elapsedSeconds).toBeCloseTo(0.1, 10);
  });

  it("stops physics and declares a winner at the configured score", () => {
    const initial = createPongState({ seed: 6, config: { winningScore: 1 } });
    const state: PongState = {
      ...initial,
      ball: { x: 0.99, y: 0.1, velocityX: 1, velocityY: 0 },
    };
    const won = updatePongState(state, { deltaSeconds: 0.08, voicePaddleY: 0.5 });
    expect(won).toMatchObject({ status: "finished", winner: "player", playerScore: 1 });
    expect(won.ball).toEqual({ x: 0.5, y: 0.5, velocityX: 0, velocityY: 0 });
    expect(updatePongState(won, { deltaSeconds: 0.1, voicePaddleY: 0.2 })).toBe(won);
  });

  it("rejects invalid physics configuration and frame input", () => {
    expect(() => createPongState({ config: { winningScore: 0 } })).toThrow(RangeError);
    expect(() => createPongState({ config: { paddleHeight: 1 } })).toThrow(RangeError);
    expect(() => createPongState({ config: { maximumBounceAngleRadians: Math.PI / 2 } })).toThrow(RangeError);
    expect(() => createPongState({ config: { simulationStepSeconds: 1, maximumDeltaSeconds: 0.5 } })).toThrow(RangeError);
    expect(() => createPongState({ serveToward: "center" as never })).toThrow(RangeError);

    const state = createPongState();
    expect(() => updatePongState(state, { deltaSeconds: -0.01, voicePaddleY: 0.5 })).toThrow(RangeError);
    expect(() => updatePongState(state, { deltaSeconds: state.config.maximumDeltaSeconds + 0.01, voicePaddleY: 0.5 })).toThrow(RangeError);
    expect(() => updatePongState(state, { deltaSeconds: 0.01, voicePaddleY: Number.NaN })).toThrow(RangeError);
  });
});
