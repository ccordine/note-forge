import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  createRangeDwell,
  updateRangeDwell,
  type RangeDwellState,
} from "../apps/web/src/features/range-loop/range-dwell";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;

interface ObservationOverrides {
  readonly kind?: PitchObservation["observationKind"];
  readonly midiFloat?: number | null;
  readonly nearestMidi?: number | null;
  readonly frequencyHz?: number | null;
  readonly confidence?: number;
  readonly voiced?: boolean;
  readonly sampleRate?: number;
  readonly captureEpoch?: number;
  readonly continuityEpoch?: number;
  readonly graphGeneration?: number;
  readonly workletProcessCount?: number;
  readonly discontinuity?: boolean;
}

function observation(
  endSample: number,
  overrides: ObservationOverrides = {},
): PitchObservation {
  const kind = overrides.kind ?? "voiced";
  const voiced = overrides.voiced ?? kind === "voiced";
  const midiFloat = overrides.midiFloat === undefined
    ? voiced ? 60 : null
    : overrides.midiFloat;
  const nearestMidi = overrides.nearestMidi === undefined
    ? midiFloat === null ? null : Math.round(midiFloat)
    : overrides.nearestMidi;
  const sampleRate = overrides.sampleRate ?? SAMPLE_RATE;
  const frequencyHz = overrides.frequencyHz === undefined
    ? midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12)
    : overrides.frequencyHz;
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
    workletProcessCount: overrides.workletProcessCount ?? Math.floor(endSample / 128),
    discontinuity: overrides.discontinuity ?? false,
    frequencyHz,
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

function controller(requiredHoldSeconds = 0.06): RangeDwellState {
  return createRangeDwell({
    targetMidi: 60,
    toleranceCents: 20,
    requiredHoldSeconds,
  });
}

function feed(
  initial: RangeDwellState,
  frames: readonly PitchObservation[],
): RangeDwellState {
  return frames.reduce(updateRangeDwell, initial);
}

describe("sample-authoritative range dwell", () => {
  it("credits only capture samples bounded by consecutive in-tolerance frames", () => {
    const initial = controller(0.04);
    const first = updateRangeDwell(initial, observation(WINDOW_SIZE));
    const second = updateRangeDwell(first, observation(WINDOW_SIZE + HOP_SIZE));
    const achieved = updateRangeDwell(second, observation(WINDOW_SIZE + HOP_SIZE * 2));

    expect(initial).toMatchObject({ achievementReached: false, heldSamples: 0, heldSeconds: 0 });
    expect(first).toMatchObject({ achievementReached: false, heldSamples: 0, heldSeconds: 0 });
    expect(second).toMatchObject({
      achievementReached: false,
      heldSamples: HOP_SIZE,
      heldSeconds: 0.02,
      progress: 0.5,
    });
    expect(achieved).toMatchObject({
      achievementReached: true,
      heldSamples: HOP_SIZE * 2,
      heldSeconds: 0.04,
      peakHeldSamples: HOP_SIZE * 2,
      peakHeldSeconds: 0.04,
      progress: 1,
    });
    expect(Object.isFrozen(achieved)).toBe(true);
    expect(Object.isFrozen(achieved.lastAuthority)).toBe(true);
  });

  it("freezes accumulated dwell across silence and uncertainty without backfilling either gap", () => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    expect(state.heldSamples).toBe(HOP_SIZE);

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 2, {
      kind: "unvoiced",
    }));
    expect(state).toMatchObject({
      heldSamples: HOP_SIZE,
      heldSeconds: 0.02,
      currentObservationKind: "unvoiced",
      currentInTolerance: null,
      previousFrameQualified: false,
    });

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 3, {
      kind: "uncertain",
      midiFloat: 60.02,
      frequencyHz: 262,
      confidence: 0.3,
    }));
    expect(state.heldSamples).toBe(HOP_SIZE);
    expect(state.currentMidiFloat).toBe(60.02);
    expect(state.currentCentsFromTarget).toBeCloseTo(2, 10);

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 4));
    expect(state.heldSamples).toBe(HOP_SIZE);
    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 5));
    expect(state.heldSamples).toBe(HOP_SIZE * 2);
    expect(state.heldSeconds).toBeCloseTo(0.04, 12);
  });

  it("uses every detector-admitted voiced pitch outside tolerance regardless of confidence magnitude", () => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE * 2),
    ]);
    expect(state.heldSamples).toBe(HOP_SIZE * 2);

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 3, {
      midiFloat: 61,
      confidence: 0.01,
    }));
    expect(state).toMatchObject({
      heldSamples: 0,
      currentInTolerance: false,
      previousFrameQualified: false,
    });

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 4));
    expect(state.heldSamples).toBe(0);
    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 5, {
      midiFloat: 60.25,
      confidence: 0.95,
    }));
    expect(state).toMatchObject({
      heldSamples: 0,
      heldSeconds: 0,
      progress: 0,
      currentInTolerance: false,
      previousFrameQualified: false,
    });

    state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 8, {
      captureEpoch: 2,
      midiFloat: 59,
    }));
    expect(state).toMatchObject({ heldSamples: 0, heldSeconds: 0, progress: 0 });
  });

  it("ignores duplicate and reordered frames without replacing newer authority or adding time", () => {
    const first = observation(WINDOW_SIZE);
    const second = observation(WINDOW_SIZE + HOP_SIZE);
    const afterSecond = feed(controller(), [first, second]);
    const duplicate = updateRangeDwell(afterSecond, second);
    const reordered = updateRangeDwell(duplicate, first);

    expect(duplicate).toBe(afterSecond);
    expect(reordered).toBe(afterSecond);
    expect(reordered.heldSamples).toBe(HOP_SIZE);
    expect(reordered.lastAuthority?.endSample).toBe(WINDOW_SIZE + HOP_SIZE);

    const next = updateRangeDwell(reordered, observation(WINDOW_SIZE + HOP_SIZE * 2));
    expect(next.heldSamples).toBe(HOP_SIZE * 2);
  });

  it.each([
    ["capture epoch", { captureEpoch: 2 }],
    ["continuity epoch", { continuityEpoch: 1 }],
    ["graph generation", { continuityEpoch: 1, graphGeneration: 1 }],
    ["explicit discontinuity", { discontinuity: true }],
  ] as const)("establishes %s authority with zero fabricated dwell", (_label, boundary) => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    const heldBefore = state.heldSamples;
    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 4, boundary));

    expect(state.heldSamples).toBe(heldBefore);
    expect(state.previousFrameQualified).toBe(true);

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 5, {
      ...boundary,
      discontinuity: false,
    }));
    expect(state.heldSamples).toBe(heldBefore + HOP_SIZE);
  });

  it("does not credit a missing detector-window gap and resumes from fresh authority", () => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 4));
    expect(state.heldSamples).toBe(HOP_SIZE);

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 5));
    expect(state.heldSamples).toBe(HOP_SIZE * 2);
  });

  it("reports the current raw pitch coordinate separately from qualification", () => {
    const state = updateRangeDwell(controller(), observation(WINDOW_SIZE, {
      midiFloat: 59.875,
      nearestMidi: 60,
      frequencyHz: 259.74,
      confidence: 0.91,
    }));

    expect(state).toMatchObject({
      currentObservationKind: "voiced",
      currentMidiFloat: 59.875,
      currentNearestMidi: 60,
      currentFrequencyHz: 259.74,
      currentCentsFromTarget: -12.5,
      currentConfidence: 0.91,
      currentInTolerance: true,
      observedFrameCount: 1,
    });
  });

  it("latches achievement while wrong pitch resets current dwell and preserves its exact peak", () => {
    let state = feed(controller(0.02), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    expect(state).toMatchObject({
      achievementReached: true,
      heldSamples: HOP_SIZE,
      heldSeconds: 0.02,
      peakHeldSamples: HOP_SIZE,
      peakHeldSeconds: 0.02,
    });

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 2, {
      midiFloat: 57,
    }));
    expect(state).toMatchObject({
      achievementReached: true,
      heldSamples: 0,
      heldSeconds: 0,
      peakHeldSamples: HOP_SIZE,
      peakHeldSeconds: 0.02,
      progress: 0,
      currentMidiFloat: 57,
      currentInTolerance: false,
    });
  });

  it("keeps exact dwell growing for an hour beyond the milestone without becoming terminal", () => {
    const hourFrameCount = Math.round(60 * 60 / (HOP_SIZE / SAMPLE_RATE));
    let state = controller(3);
    for (let index = 0; index <= hourFrameCount; index += 1) {
      state = updateRangeDwell(
        state,
        observation(WINDOW_SIZE + HOP_SIZE * index),
      );
    }

    expect(state.achievementReached).toBe(true);
    expect(state.observedFrameCount).toBe(hourFrameCount + 1);
    expect(state.heldSamples).toBe(HOP_SIZE * hourFrameCount);
    expect(state.heldSeconds).toBeCloseTo(3_600, 7);
    expect(state.peakHeldSamples).toBe(state.heldSamples);
    expect(state.peakHeldSeconds).toBeCloseTo(3_600, 7);
    expect(state.progress).toBe(1);

    state = updateRangeDwell(state, observation(
      WINDOW_SIZE + HOP_SIZE * (hourFrameCount + 1),
      { kind: "unvoiced" },
    ));
    expect(state.heldSeconds).toBeCloseTo(3_600, 7);
    expect(state.observedFrameCount).toBe(hourFrameCount + 2);

    state = updateRangeDwell(state, observation(
      WINDOW_SIZE + HOP_SIZE * (hourFrameCount + 2),
      { midiFloat: 61 },
    ));
    expect(state).toMatchObject({
      achievementReached: true,
      heldSamples: 0,
      heldSeconds: 0,
      peakHeldSamples: HOP_SIZE * hourFrameCount,
      observedFrameCount: hourFrameCount + 3,
    });
    expect(state.peakHeldSeconds).toBeCloseTo(3_600, 7);
  });

  it("uses the canonical hop-derived interval default without a second confidence gate", () => {
    const state = controller();
    expect(state.maximumCreditedIntervalSeconds).toBe(0.03);
    expect(() => createRangeDwell({
      targetMidi: 60,
      toleranceCents: 0,
      requiredHoldSeconds: 1,
    })).toThrow(RangeError);
  });
});
