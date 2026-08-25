import { describe, expect, it } from "vitest";

import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  createChallengeSession,
  type ChallengeStep,
} from "../apps/web/src/features/voice-arcade/model";
import {
  createPatternChallengeController,
  reducePatternChallenge,
  scorePatternObservation,
} from "../apps/web/src/features/voice-arcade/pattern-challenge-controller";

const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;

function step(overrides: Partial<ChallengeStep> = {}): ChallengeStep {
  return {
    id: "ddr-1",
    index: 0,
    mode: "ddr",
    targetMidi: 60,
    cueAtSeconds: 0,
    windowStartSeconds: 0,
    windowEndSeconds: 2,
    requiredSustainSeconds: 0.4,
    toleranceCents: 20,
    maximumPoints: 1_000,
    ...overrides,
  };
}

function observation(
  endSample: number,
  overrides: Partial<PitchObservation> = {},
): PitchObservation {
  const sampleRate = overrides.sampleRate ?? 48_000;
  const startSample = endSample - 4_096;
  const midiFloat = overrides.midiFloat === undefined ? 60 : overrides.midiFloat;
  const voiced = overrides.voiced ?? midiFloat !== null;
  const reason = overrides.reason ?? (voiced ? "detected" : "no-periodic-candidate");
  const observationKind = overrides.observationKind ?? (voiced ? "voiced" : "unvoiced");
  return {
    observationKind,
    timeSeconds: (startSample + endSample) / (2 * sampleRate),
    sampleRate,
    startSample,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: false,
    frequencyHz: voiced ? 261.625565 : null,
    midiFloat,
    nearestMidi: voiced ? Math.round(midiFloat!) : null,
    centsFromNearest: voiced ? (midiFloat! - Math.round(midiFloat!)) * 100 : null,
    confidence: voiced ? 0.95 : 0,
    voiced,
    periodicity: voiced ? 0.95 : 0,
    rms: voiced ? 0.05 : 0,
    detector: "yin",
    periodSamples: voiced ? sampleRate / 261.625565 : null,
    yinValue: voiced ? 0.05 : null,
    reason,
    ...overrides,
  };
}

describe("Pattern Challenge sample-authoritative scoring", () => {
  it("freezes earned dwell through silence and uncertain evidence", () => {
    let session = createChallengeSession([step()]);
    const first = observation(4_096);
    session = scorePatternObservation(session, first, 0, false);
    session = scorePatternObservation(session, observation(5_056), 0.2, true);
    expect(session.steps[0]!.heldSeconds).toBeCloseTo(0.2);

    session = scorePatternObservation(session, observation(6_016, {
      voiced: false,
      midiFloat: null,
      observationKind: "unvoiced",
      reason: "no-periodic-candidate",
    }), 0.4, true);
    session = scorePatternObservation(session, observation(6_976, {
      voiced: false,
      midiFloat: null,
      observationKind: "uncertain",
      reason: "below-confidence-threshold",
      confidence: 0.4,
    }), 0.6, true);
    expect(session.steps[0]!.heldSeconds).toBeCloseTo(0.2);

    session = scorePatternObservation(session, observation(7_936), 0.8, true);
    expect(session.steps[0]!.heldSeconds).toBeCloseTo(0.2);
    session = scorePatternObservation(session, observation(8_896), 1, true);
    expect(session).toMatchObject({ status: "complete", hitSteps: 1, missedSteps: 0 });
  });

  it("resets dwell only for a credible voiced pitch outside the target lane", () => {
    let session = createChallengeSession([step({ requiredSustainSeconds: 0.6 })]);
    session = scorePatternObservation(session, observation(4_096), 0, false);
    session = scorePatternObservation(session, observation(5_056), 0.2, true);
    expect(session.steps[0]!.heldSeconds).toBeCloseTo(0.2);

    session = scorePatternObservation(session, observation(6_016, { midiFloat: 61 }), 0.3, true);
    expect(session.steps[0]).toMatchObject({ heldSeconds: 0, progress: 0, firstMatchedAtSeconds: null });

    session = scorePatternObservation(session, observation(6_976), 0.4, true);
    session = scorePatternObservation(session, observation(7_936), 0.6, true);
    expect(session.steps[0]!.heldSeconds).toBeCloseTo(0.2);
  });

  it("derives game time from sample hops and never catches up across a gap or discontinuity", () => {
    let game = createPatternChallengeController({
      difficulty: "easy",
      lowMidi: 60,
      highMidi: 60,
      baselineMidi: 60,
    });
    game = reducePatternChallenge(game, { type: "prepare", seed: "clock-proof" });
    game = reducePatternChallenge(game, { type: "begin" });

    game = reducePatternChallenge(game, { type: "observation", observation: observation(4_096, { voiced: false, midiFloat: null }) });
    expect(game.elapsedSeconds).toBe(0);
    game = reducePatternChallenge(game, { type: "observation", observation: observation(5_056, { voiced: false, midiFloat: null }) });
    expect(game.elapsedSeconds).toBeCloseTo(0.02);

    const beforeDuplicate = game;
    game = reducePatternChallenge(game, { type: "observation", observation: observation(5_056, { voiced: false, midiFloat: null }) });
    expect(game).toBe(beforeDuplicate);

    game = reducePatternChallenge(game, { type: "observation", observation: observation(6_976, { voiced: false, midiFloat: null }) });
    expect(game.elapsedSeconds).toBeCloseTo(0.02);
    game = reducePatternChallenge(game, { type: "observation", observation: observation(7_936, { voiced: false, midiFloat: null }) });
    expect(game.elapsedSeconds).toBeCloseTo(0.04);
    game = reducePatternChallenge(game, { type: "observation", observation: observation(8_896, {
      voiced: false,
      midiFloat: null,
      discontinuity: true,
      continuityEpoch: 1,
    }) });
    expect(game.elapsedSeconds).toBeCloseTo(0.04);
    game = reducePatternChallenge(game, { type: "observation", observation: observation(9_856, {
      voiced: false,
      midiFloat: null,
      continuityEpoch: 1,
    }) });
    expect(game.elapsedSeconds).toBeCloseTo(0.06);
  });

  it("keeps setup, preview, play, and result as legal reducer transitions", () => {
    let game = createPatternChallengeController({
      difficulty: "medium",
      lowMidi: 48,
      highMidi: 60,
      baselineMidi: 54,
    });
    expect(game.phase).toBe("setup");
    game = reducePatternChallenge(game, { type: "select-mode", mode: "ddr" });
    game = reducePatternChallenge(game, { type: "prepare", seed: "transition-proof" });
    expect(game).toMatchObject({ phase: "preview", mode: "ddr", elapsedSeconds: 0 });
    expect(game.pattern).toHaveLength(8);
    game = reducePatternChallenge(game, { type: "begin" });
    expect(game).toMatchObject({ phase: "playing", runSerial: 1 });
    game = reducePatternChallenge(game, { type: "stop" });
    expect(game.phase).toBe("result");
    expect(game.result).toMatchObject({ totalSteps: 8, hitSteps: 0, missedSteps: 8 });
    game = reducePatternChallenge(game, { type: "next-round" });
    expect(game).toMatchObject({ phase: "setup", round: 2, session: null, result: null });
  });

  it("recycles target progression and whole-session scoring for an hour until explicit Stop", () => {
    let game = createPatternChallengeController({
      difficulty: "easy",
      lowMidi: 60,
      highMidi: 60,
      baselineMidi: 60,
    });
    game = reducePatternChallenge(game, { type: "select-mode", mode: "ddr" });
    game = reducePatternChallenge(game, { type: "prepare", seed: "user-owned-lifetime" });
    game = reducePatternChallenge(game, { type: "begin" });

    for (let index = 0; index <= 180_000; index += 1) {
      game = reducePatternChallenge(game, {
        type: "observation",
        observation: observation(WINDOW_SIZE + HOP_SIZE * index, {
          voiced: false,
          midiFloat: null,
          observationKind: "unvoiced",
          reason: "no-periodic-candidate",
        }),
      });
    }

    expect(game).toMatchObject({ phase: "playing", result: null });
    expect(game.session?.status).not.toBe("complete");
    expect(game.achievementCount).toBeGreaterThan(100);
    expect(game.scoreAggregate.totalSteps).toBe(game.achievementCount * 6);
    expect(game.scoreAggregate.missedSteps).toBe(game.scoreAggregate.totalSteps);
    expect(game.elapsedSeconds).toBeCloseTo(3_600, 8);
    const elapsedAfterPhrase = game.elapsedSeconds;
    const aggregateAfterHour = game.scoreAggregate;
    game = reducePatternChallenge(game, {
      type: "observation",
      observation: observation(WINDOW_SIZE + HOP_SIZE * 180_001, { midiFloat: 60 }),
    });
    expect(game.phase).toBe("playing");
    expect(game.liveMidi).toBe(60);
    expect(game.elapsedSeconds).toBeGreaterThan(elapsedAfterPhrase);
    expect(game.clock?.lastEndSample).toBe(WINDOW_SIZE + HOP_SIZE * 180_001);
    expect(game.result).toBeNull();
    expect(game.scoreAggregate).toBe(aggregateAfterHour);
    const stillLive = game;
    expect(reducePatternChallenge(game, { type: "change-loadout" })).toBe(stillLive);
    expect(reducePatternChallenge(game, { type: "next-round" })).toBe(stillLive);

    game = reducePatternChallenge(game, { type: "stop" });
    expect(game.phase).toBe("result");
    expect(game.result?.totalSteps).toBeGreaterThan(game.achievementCount * 6);
    expect(game.result?.missedSteps).toBeGreaterThanOrEqual(game.scoreAggregate.missedSteps);
    const completed = game;
    game = reducePatternChallenge(game, {
      type: "observation",
      observation: observation(WINDOW_SIZE + HOP_SIZE * 180_002, { midiFloat: 60 }),
    });
    expect(game).toBe(completed);
  }, 15_000);
});
