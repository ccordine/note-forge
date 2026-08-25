import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  createNoteDwell,
  reconfigureNoteDwellTolerance,
  updateNoteDwell,
} from "../apps/web/src/features/training-session/note-dwell";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;

function observation(index: number, midiFloat = 60.15): PitchObservation {
  const endSample = WINDOW_SIZE + HOP_SIZE * index;
  const nearestMidi = Math.round(midiFloat);
  return Object.freeze({
    observationKind: "voiced",
    timeSeconds: (endSample - WINDOW_SIZE / 2) / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    startSample: endSample - WINDOW_SIZE,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: false,
    frequencyHz: 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: (midiFloat - nearestMidi) * 100,
    rms: 0.02,
    confidence: 0.96,
    voiced: true,
    detector: "yin",
    periodSamples: 184,
    yinValue: 0.04,
    reason: "detected",
    periodicity: 0.96,
  });
}

function dwell(toleranceCents: number) {
  return createNoteDwell({
    targetMidi: 60,
    toleranceCents,
    requiredHoldSeconds: 1,
  });
}

describe("live note-dwell tolerance reconfiguration", () => {
  it("preserves exact retained evidence and applies a narrower lane on the next observation", () => {
    let state = updateNoteDwell(dwell(20), observation(0));
    state = updateNoteDwell(state, observation(1));
    expect(state).toMatchObject({
      heldSamples: HOP_SIZE,
      heldSeconds: 0.02,
      peakHeldSamples: HOP_SIZE,
      currentInTolerance: true,
      previousFrameQualified: true,
    });
    const authority = state.lastAuthority;
    const frameCount = state.observedFrameCount;

    state = reconfigureNoteDwellTolerance(state, 10);
    expect(state).toMatchObject({
      toleranceCents: 10,
      heldSamples: HOP_SIZE,
      heldSeconds: 0.02,
      peakHeldSamples: HOP_SIZE,
      peakHeldSeconds: 0.02,
      currentInTolerance: null,
      previousFrameQualified: false,
      observedFrameCount: frameCount,
    });
    expect(state.lastAuthority).toBe(authority);

    state = updateNoteDwell(state, observation(2));
    expect(state).toMatchObject({
      heldSamples: 0,
      heldSeconds: 0,
      peakHeldSamples: HOP_SIZE,
      peakHeldSeconds: 0.02,
      currentInTolerance: false,
    });
  });

  it("does not credit an interval that crosses from the old lane into a wider lane", () => {
    let state = updateNoteDwell(dwell(10), observation(0));
    expect(state.currentInTolerance).toBe(false);

    state = reconfigureNoteDwellTolerance(state, 20);
    state = updateNoteDwell(state, observation(1));
    expect(state).toMatchObject({
      toleranceCents: 20,
      currentInTolerance: true,
      heldSamples: 0,
      previousFrameQualified: true,
    });

    state = updateNoteDwell(state, observation(2));
    expect(state.heldSamples).toBe(HOP_SIZE);
    expect(reconfigureNoteDwellTolerance(state, 20)).toBe(state);
    expect(() => reconfigureNoteDwellTolerance(state, 0)).toThrow(RangeError);
  });
});
