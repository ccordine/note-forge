import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  RANGE_DWELL_DEFAULTS,
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
    const complete = updateRangeDwell(second, observation(WINDOW_SIZE + HOP_SIZE * 2));

    expect(initial).toMatchObject({ status: "tracking", heldSamples: 0, heldSeconds: 0 });
    expect(first).toMatchObject({ status: "tracking", heldSamples: 0, heldSeconds: 0 });
    expect(second).toMatchObject({
      status: "tracking",
      heldSamples: HOP_SIZE,
      heldSeconds: 0.02,
      progress: 0.5,
    });
    expect(complete).toMatchObject({
      status: "complete",
      heldSamples: HOP_SIZE * 2,
      heldSeconds: 0.04,
      progress: 1,
    });
    expect(Object.isFrozen(complete)).toBe(true);
    expect(Object.isFrozen(complete.lastAuthority)).toBe(true);
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

  it("resets only for a confidently voiced pitch outside tolerance", () => {
    let state = feed(controller(), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE * 2),
    ]);
    expect(state.heldSamples).toBe(HOP_SIZE * 2);

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 3, {
      midiFloat: 61,
      confidence: RANGE_DWELL_DEFAULTS.minimumConfidence - 0.01,
    }));
    expect(state).toMatchObject({
      heldSamples: HOP_SIZE * 2,
      currentInTolerance: null,
      previousFrameQualified: false,
    });

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 4));
    expect(state.heldSamples).toBe(HOP_SIZE * 2);
    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 5, {
      midiFloat: 60.25,
      confidence: 0.95,
    }));
    expect(state).toMatchObject({
      status: "tracking",
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
    ["graph generation", { graphGeneration: 1 }],
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

  it("latches completion while continuing to report later observations", () => {
    let state = feed(controller(0.02), [
      observation(WINDOW_SIZE),
      observation(WINDOW_SIZE + HOP_SIZE),
    ]);
    expect(state.status).toBe("complete");

    state = updateRangeDwell(state, observation(WINDOW_SIZE + HOP_SIZE * 2, {
      midiFloat: 57,
    }));
    expect(state).toMatchObject({
      status: "complete",
      heldSamples: HOP_SIZE,
      heldSeconds: 0.02,
      progress: 1,
      currentMidiFloat: 57,
      currentInTolerance: false,
    });
  });

  it("uses canonical confidence and hop-derived interval defaults", () => {
    const state = controller();
    expect(state.minimumConfidence).toBe(RANGE_DWELL_DEFAULTS.minimumConfidence);
    expect(state.maximumCreditedIntervalSeconds).toBe(0.03);
    expect(() => createRangeDwell({
      targetMidi: 60,
      toleranceCents: 0,
      requiredHoldSeconds: 1,
    })).toThrow(RangeError);
  });
});
