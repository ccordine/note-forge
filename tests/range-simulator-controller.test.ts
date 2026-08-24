import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  canRateRangeProbe,
  createRangeSimulatorController,
  reduceRangeSimulatorController,
} from "../apps/web/src/features/range-simulator/controller";
import { currentRangeSimulatorProbe } from "../apps/web/src/features/range-simulator/model";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;
const STARTED_AT = "2026-08-24T12:00:00.000Z";

function observation(
  index: number,
  options: {
    kind?: PitchObservation["observationKind"];
    midiFloat?: number | null;
    confidence?: number;
    discontinuity?: boolean;
    continuityEpoch?: number;
  } = {},
): PitchObservation {
  const endSample = WINDOW_SIZE + HOP_SIZE * index;
  const kind = options.kind ?? "voiced";
  const voiced = kind === "voiced";
  const midiFloat = options.midiFloat === undefined ? (voiced ? 48 : null) : options.midiFloat;
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
  return {
    observationKind: kind,
    timeSeconds: (endSample - WINDOW_SIZE / 2) / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    startSample: endSample - WINDOW_SIZE,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: options.continuityEpoch ?? 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: options.discontinuity ?? false,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: midiFloat === null || nearestMidi === null ? null : (midiFloat - nearestMidi) * 100,
    rms: voiced ? 0.02 : 0,
    confidence: options.confidence ?? (voiced ? 0.96 : 0),
    voiced,
    detector: "yin",
    periodSamples: voiced ? 367 : null,
    yinValue: voiced ? 0.04 : null,
    reason: voiced ? "detected" : kind === "unvoiced" ? "below-rms-threshold" : "below-confidence-threshold",
    periodicity: voiced ? 0.96 : 0,
  };
}

function controller() {
  return createRangeSimulatorController({
    startedAt: STARTED_AT,
    toleranceCents: 20,
    anchorMidi: 48,
    preparation: "unwarmed",
  });
}

describe("Range Simulator sample-coordinate controller", () => {
  it("uses only idle, tracking, and complete workflow status", () => {
    const initial = controller();
    const tracking = reduceRangeSimulatorController(initial, { type: "begin", toleranceCents: 20 });
    const complete = reduceRangeSimulatorController(tracking, {
      type: "finish",
      stoppedAt: "2026-08-24T12:01:00.000Z",
    });

    expect(initial.status).toBe("idle");
    expect(tracking.status).toBe("tracking");
    expect(complete.status).toBe("complete");
  });

  it("freezes earned samples through silence, uncertainty, and discontinuity", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(0) });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(1) });
    expect(state.dwell.heldSamples).toBe(HOP_SIZE);

    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(2, { kind: "unvoiced" }) });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(3, { kind: "uncertain", midiFloat: 48.02, confidence: 0.2 }) });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(4, { discontinuity: true, continuityEpoch: 1 }) });
    expect(state.dwell.heldSamples).toBe(HOP_SIZE);

    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(5, { continuityEpoch: 1 }) });
    expect(state.dwell.heldSamples).toBe(HOP_SIZE * 2);
  });

  it("resets dwell only when credible voiced evidence leaves the target", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    for (let index = 0; index < 5; index += 1) {
      state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(index) });
    }
    expect(state.dwell.heldSamples).toBe(HOP_SIZE * 4);

    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(5, { midiFloat: 49, confidence: 0.2 }) });
    expect(state.dwell.heldSamples).toBe(HOP_SIZE * 4);
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(6, { midiFloat: 49, confidence: 0.96 }) });
    expect(state.dwell.heldSamples).toBe(0);
  });

  it("advances the adaptive model only after sample-authoritative dwell and a user rating", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    for (let index = 0; index <= 75; index += 1) {
      state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(index) });
    }
    expect(state.dwell.status).toBe("complete");
    expect(state.dwell.heldSamples).toBe(HOP_SIZE * 75);
    expect(canRateRangeProbe(state)).toBe(true);

    state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 1 });
    state = reduceRangeSimulatorController(state, {
      type: "save-rating",
      ratedAt: "2026-08-24T12:00:10.000Z",
      toleranceCents: 20,
    });
    expect(state.session.ratedProbeCount).toBe(1);
    expect(currentRangeSimulatorProbe(state.session)?.midi).toBe(46);
    expect(state.dwell).toMatchObject({ targetMidi: 46, heldSamples: 0, status: "tracking" });
    expect(state.persistenceRevision).toBe(1);
  });

  it("allows honest unstable or unable ratings without fabricating a hold", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 3 });
    expect(state.rating).toBeNull();
    state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 5 });
    expect(state.rating).toBe(5);
    expect(canRateRangeProbe(state)).toBe(true);
  });
});
