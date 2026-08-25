import { describe, expect, it } from "vitest";
import type { PitchObservation, PitchObservationKind } from "../apps/web/src/audio/note-input";
import {
  createResonanceController,
  resetResonanceController,
  toResonanceVoiceInput,
  updateResonanceControllerFromFrame,
} from "../apps/web/src/features/voice-arcade/resonance-controller";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;

function observation(
  index: number,
  midiFloat: number | null = 48,
  kind: PitchObservationKind = midiFloat === null ? "unvoiced" : "voiced",
  overrides: Partial<PitchObservation> = {},
): PitchObservation {
  const startSample = index * HOP_SIZE;
  const endSample = startSample + WINDOW_SIZE;
  const voiced = kind === "voiced" && midiFloat !== null;
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
  const confidence = voiced ? 0.96 : kind === "unvoiced" ? 0.08 : 0.42;
  return {
    observationKind: kind,
    timeSeconds: (startSample + endSample) / (2 * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
    startSample,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: index + 1,
    discontinuity: false,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: midiFloat === null ? null : (midiFloat - nearestMidi!) * 100,
    confidence,
    periodicity: confidence,
    rms: voiced ? 10 ** (-70 / 20) : 0,
    voiced,
    detector: "yin",
    reason: voiced ? "detected" : kind === "unvoiced" ? "no-periodic-candidate" : "below-confidence-threshold",
    periodSamples: voiced ? SAMPLE_RATE / (440 * 2 ** ((midiFloat! - 69) / 12)) : null,
    yinValue: voiced ? 1 - confidence : null,
    ...overrides,
  };
}

describe("sample-authoritative Resonance controller", () => {
  it("accepts the first quiet voiced observation immediately without calibration", () => {
    const update = updateResonanceControllerFromFrame(
      createResonanceController(),
      observation(0, 48, "voiced", { rms: 10 ** (-90 / 20), confidence: 0.56, periodicity: 0.56 }),
    );

    expect(update).toMatchObject({ accepted: true, duplicate: false, authorityChanged: true });
    expect(update.state).toMatchObject({
      status: "driving",
      evidenceReliable: true,
      midiFloat: 48,
      observedFrameCount: 1,
      reliableFrameCount: 1,
    });
    expect(update.state.drive).toBeGreaterThan(0);
    expect(toResonanceVoiceInput(update.state)).toMatchObject({ voiced: true, midiFloat: 48 });
  });

  it("turns unvoiced and uncertain windows into zero force without a release tail", () => {
    let state = updateResonanceControllerFromFrame(
      createResonanceController(),
      observation(0),
    ).state;
    expect(toResonanceVoiceInput(state).coherentDrive).toBeGreaterThan(0);

    state = updateResonanceControllerFromFrame(state, observation(1, null, "unvoiced")).state;
    expect(state).toMatchObject({ status: "unvoiced", evidenceReliable: false, drive: 0 });
    expect(toResonanceVoiceInput(state)).toMatchObject({
      voiced: false,
      midiFloat: null,
      coherentDrive: 0,
    });

    state = updateResonanceControllerFromFrame(state, observation(2, null, "uncertain")).state;
    expect(state).toMatchObject({ status: "uncertain", evidenceReliable: false, drive: 0 });
  });

  it("ignores duplicate and reordered coordinates instead of inventing elapsed time", () => {
    const first = updateResonanceControllerFromFrame(
      createResonanceController(),
      observation(4),
    ).state;
    const duplicate = updateResonanceControllerFromFrame(first, observation(4, 52));
    const reordered = updateResonanceControllerFromFrame(first, observation(3, 55));

    expect(duplicate).toMatchObject({ accepted: false, duplicate: true });
    expect(reordered).toMatchObject({ accepted: false, duplicate: true });
    expect(duplicate.state).toBe(first);
    expect(reordered.state).toBe(first);
  });

  it("clears pitch history on explicit continuity authority without rejecting the new note", () => {
    let state = createResonanceController();
    for (let index = 0; index < 6; index += 1) {
      state = updateResonanceControllerFromFrame(state, observation(index, 48 + index * 0.001)).state;
    }
    expect(state.pitchHistory.length).toBeGreaterThan(1);

    const boundary = updateResonanceControllerFromFrame(state, observation(6, 55, "voiced", {
      continuityEpoch: 1,
      graphGeneration: 1,
      discontinuity: true,
    }));
    expect(boundary).toMatchObject({ accepted: true, authorityChanged: true });
    expect(boundary.state.pitchHistory).toHaveLength(1);
    expect(boundary.state.midiFloat).toBe(55);
  });

  it("derives stability from sample coordinates and never from callback arrival time", () => {
    let stable = createResonanceController();
    let unstable = createResonanceController();
    for (let index = 0; index < 12; index += 1) {
      stable = updateResonanceControllerFromFrame(stable, observation(index, 48)).state;
      unstable = updateResonanceControllerFromFrame(
        unstable,
        observation(index, index % 2 === 0 ? 47.7 : 48.3),
      ).state;
    }
    expect(stable.stability).toBeCloseTo(1, 12);
    expect(unstable.stability).toBe(0);
    expect(stable.drive).toBeGreaterThan(unstable.drive);
  });

  it("resets only derived game evidence and validates controller options", () => {
    const driven = updateResonanceControllerFromFrame(
      createResonanceController(),
      observation(0),
    ).state;
    expect(resetResonanceController(driven)).toEqual(createResonanceController(driven.options));
    expect(() => createResonanceController({ stabilityWindowSeconds: 0 })).toThrow(RangeError);
    expect(() => createResonanceController({ stableSpreadCents: 50, unstableSpreadCents: 50 }))
      .toThrow(RangeError);
  });

  it("rejects invalid sample authority without changing state", () => {
    const state = createResonanceController();
    const invalid = updateResonanceControllerFromFrame(state, observation(0, 48, "voiced", {
      endSample: -1,
    }));
    expect(invalid.state).toBe(state);
    expect(invalid).toMatchObject({ accepted: false, duplicate: false });
  });
});
