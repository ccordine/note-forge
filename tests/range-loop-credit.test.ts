import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  RANGE_LOOP_CREDIT_GOAL_SECONDS,
  createRangeLoopCredit,
  reconfigureRangeLoopTolerance,
  updateRangeLoopCredit,
  type RangeLoopCreditState,
} from "../apps/web/src/features/range-loop/range-loop-credit";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;

interface ObservationOverrides {
  readonly kind?: PitchObservation["observationKind"];
  readonly midiFloat?: number | null;
  readonly confidence?: number;
  readonly sampleRate?: number;
  readonly captureEpoch?: number;
  readonly continuityEpoch?: number;
  readonly graphGeneration?: number;
  readonly discontinuity?: boolean;
}

function observation(
  endSample: number,
  overrides: ObservationOverrides = {},
): PitchObservation {
  const kind = overrides.kind ?? "voiced";
  const voiced = kind === "voiced";
  const midiFloat = overrides.midiFloat === undefined
    ? voiced ? 60 : null
    : overrides.midiFloat;
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
  const sampleRate = overrides.sampleRate ?? SAMPLE_RATE;
  return Object.freeze({
    observationKind: kind,
    timeSeconds: (endSample - WINDOW_SIZE / 2) / sampleRate,
    sampleRate,
    startSample: endSample - WINDOW_SIZE,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: overrides.captureEpoch ?? 1,
    continuityEpoch: overrides.continuityEpoch ?? 0,
    graphGeneration: overrides.graphGeneration ?? 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: overrides.discontinuity ?? false,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: midiFloat === null || nearestMidi === null
      ? null
      : (midiFloat - nearestMidi) * 100,
    rms: voiced ? 0.02 : 0,
    confidence: overrides.confidence ?? (voiced ? 0.96 : 0),
    voiced,
    detector: "yin",
    periodSamples: voiced ? 184 : null,
    yinValue: voiced ? 0.04 : null,
    reason: kind === "voiced"
      ? "detected"
      : kind === "unvoiced"
        ? "below-rms-threshold"
        : "below-confidence-threshold",
    periodicity: voiced ? 0.96 : 0,
  });
}

function controller(acceptingCredit = true): RangeLoopCreditState {
  return createRangeLoopCredit({
    targetMidi: 60,
    toleranceCents: 20,
    acceptingCredit,
  });
}

function feed(
  initial: RangeLoopCreditState,
  frames: readonly PitchObservation[],
): RangeLoopCreditState {
  return frames.reduce(updateRangeLoopCredit, initial);
}

describe("Range Loop cumulative sample-time credit", () => {
  it("awards one practice millisecond per exact in-range sample millisecond", () => {
    const first = updateRangeLoopCredit(controller(), observation(WINDOW_SIZE));
    const second = updateRangeLoopCredit(first, observation(WINDOW_SIZE + HOP_SIZE));

    expect(first).toMatchObject({ creditedSamples: 0, creditedSeconds: 0 });
    expect(second).toMatchObject({
      creditedSamples: HOP_SIZE,
      creditedSeconds: 0.02,
      previousFrameQualified: true,
      currentInTolerance: true,
    });
    expect(Math.floor(second.creditedSeconds * 1_000)).toBe(20);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.lastAuthority)).toBe(true);
  });

  it("keeps all prior credit through breaths, uncertainty, and wrong pitches", () => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE * 2),
    ]);
    expect(state.creditedSeconds).toBeCloseTo(0.04, 12);

    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 3, {
      kind: "unvoiced",
    }));
    expect(state).toMatchObject({
      creditedSamples: HOP_SIZE * 2,
      currentObservationKind: "unvoiced",
      currentInTolerance: null,
      previousFrameQualified: false,
    });

    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 4, {
      kind: "uncertain",
      midiFloat: 60.02,
      confidence: 0.2,
    }));
    expect(state.creditedSeconds).toBeCloseTo(0.04, 12);

    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 5, {
      midiFloat: 61,
      confidence: 0.01,
    }));
    expect(state).toMatchObject({
      creditedSamples: HOP_SIZE * 2,
      currentInTolerance: false,
      previousFrameQualified: false,
    });

    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 6));
    expect(state.creditedSamples).toBe(HOP_SIZE * 2);
    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 7));
    expect(state.creditedSamples).toBe(HOP_SIZE * 3);
    expect(state.creditedSeconds).toBeCloseTo(0.06, 12);
  });

  it("reaches 30 collective seconds and continues accumulating afterward", () => {
    let state = controller();
    const intervalsThroughGoal = RANGE_LOOP_CREDIT_GOAL_SECONDS / (HOP_SIZE / SAMPLE_RATE);
    for (let index = 0; index <= intervalsThroughGoal; index += 1) {
      state = updateRangeLoopCredit(
        state,
        observation(WINDOW_SIZE + HOP_SIZE * index),
      );
    }

    expect(state).toMatchObject({
      achievementReached: true,
      creditedSamples: RANGE_LOOP_CREDIT_GOAL_SECONDS * SAMPLE_RATE,
      progress: 1,
    });
    expect(state.creditedSeconds).toBeCloseTo(RANGE_LOOP_CREDIT_GOAL_SECONDS, 10);

    state = updateRangeLoopCredit(
      state,
      observation(WINDOW_SIZE + HOP_SIZE * (intervalsThroughGoal + 1)),
    );
    expect(state.achievementReached).toBe(true);
    expect(state.creditedSeconds).toBeCloseTo(30.02, 11);
    expect(state.progress).toBe(1);
  });

  it("preserves credit when tolerance changes and classifies only new evidence", () => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    state = reconfigureRangeLoopTolerance(state, 30);
    expect(state).toMatchObject({
      creditedSamples: HOP_SIZE,
      toleranceCents: 30,
      currentInTolerance: null,
      previousFrameQualified: false,
    });

    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 2, {
      midiFloat: 60.25,
    }));
    expect(state.creditedSamples).toBe(HOP_SIZE);
    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 3, {
      midiFloat: 60.25,
    }));
    expect(state.creditedSamples).toBe(HOP_SIZE * 2);
  });

  it("adds no catch-up time across gaps or changed sample authority", () => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 5));
    expect(state.creditedSamples).toBe(HOP_SIZE);
    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 6));
    expect(state.creditedSamples).toBe(HOP_SIZE * 2);

    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 9, {
      captureEpoch: 2,
    }));
    expect(state.creditedSamples).toBe(HOP_SIZE * 2);
    state = updateRangeLoopCredit(state, observation(WINDOW_SIZE + HOP_SIZE * 10, {
      captureEpoch: 2,
    }));
    expect(state.creditedSamples).toBe(HOP_SIZE * 3);
  });

  it("ignores duplicate/reordered observations and never scores an excluded target", () => {
    const first = observation(WINDOW_SIZE);
    const second = observation(WINDOW_SIZE + HOP_SIZE);
    const afterSecond = feed(controller(), [first, second]);
    expect(updateRangeLoopCredit(afterSecond, second)).toBe(afterSecond);
    expect(updateRangeLoopCredit(afterSecond, first)).toBe(afterSecond);

    const excluded = feed(controller(false), [
      first,
      second,
      observation(WINDOW_SIZE + HOP_SIZE * 2),
    ]);
    expect(excluded).toMatchObject({
      acceptingCredit: false,
      creditedSamples: 0,
      creditedSeconds: 0,
      achievementReached: false,
      previousFrameQualified: false,
    });
  });
});
