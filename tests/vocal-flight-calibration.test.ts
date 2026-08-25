import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createVocalCalibrationState,
  reduceVocalCalibration,
  vocalCalibrationReadiness,
  type VocalCalibrationState,
} from "../apps/web/src/features/voice-arcade/vocal-flight/calibration";
import { VocalControlReticle } from "../apps/web/src/features/voice-arcade/vocal-flight/VocalControlReticle";
import type {
  VocalControlCalibration,
  VocalTelemetrySample,
} from "../apps/web/src/features/voice-arcade/vocal-flight/types";

const CENTER_MIDI = 47;
let sampleIndex = 0;

function sample(options: Readonly<{
  cents?: number;
  brightness?: number | null;
  brightnessConfidence?: number;
  confidence?: number;
  continuityEpoch?: number;
  discontinuity?: boolean;
  kind?: VocalTelemetrySample["observationKind"];
  rms?: number;
}> = {}): VocalTelemetrySample {
  const index = sampleIndex;
  sampleIndex += 1;
  const sampleRate = 48_000;
  const endSample = 4_096 + index * 960;
  const kind = options.kind ?? "voiced";
  const voiced = kind === "voiced";
  const midiFloat = voiced ? CENTER_MIDI + (options.cents ?? 0) / 100 : null;
  return Object.freeze({
    observationKind: kind,
    sampleRate,
    startSample: endSample - 4_096,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: options.continuityEpoch ?? 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: options.discontinuity ?? index === 0,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    confidence: options.confidence ?? (voiced ? 0.97 : 0),
    brightness: options.brightness === undefined ? 0.5 : options.brightness,
    brightnessConfidence: options.brightnessConfidence ?? (voiced ? 0.96 : 0),
    rms: options.rms ?? (voiced ? 0.04 : 0),
  });
}

function feed(
  initial: VocalCalibrationState,
  count: number,
  options: Parameters<typeof sample>[0],
): VocalCalibrationState {
  let state = initial;
  for (let index = 0; index < count; index += 1) {
    state = reduceVocalCalibration(state, { type: "observe", sample: sample(options) });
  }
  return state;
}

function advance(state: VocalCalibrationState): VocalCalibrationState {
  const next = reduceVocalCalibration(state, { type: "next" });
  expect(next.validationMessage).toBeNull();
  return next;
}

function throughBrightness(): VocalCalibrationState {
  let state = createVocalCalibrationState();
  state = feed(state, 46, { brightness: 0.5, rms: 0.04 });
  state = advance(state);
  state = feed(state, 46, { cents: 300, brightness: null, brightnessConfidence: 0 });
  state = advance(state);
  state = feed(state, 46, { cents: -200, brightness: null, brightnessConfidence: 0 });
  state = advance(state);
  state = feed(state, 46, { cents: 18, brightness: 0.4 });
  state = advance(state);
  state = feed(state, 46, { cents: -22, brightness: 0.62 });
  return advance(state);
}

function performRecoveries(initial: VocalCalibrationState): VocalCalibrationState {
  let state = initial;
  for (let recovery = 0; recovery < 3; recovery += 1) {
    state = feed(state, 6, { cents: 120, brightness: 0.58 });
    state = feed(state, 20, { cents: 0, brightness: 0.5 });
  }
  return state;
}

describe("Vocal Flight calibration reducer", () => {
  it("produces robust asymmetric held extents and diagnostic neutral amplitude", () => {
    sampleIndex = 0;
    let state = performRecoveries(throughBrightness());
    expect(state.stage).toBe("center-recovery");
    expect(state.recoveryCount).toBe(3);
    state = advance(state);
    expect(state.stage).toBe("complete");
    expect(state.result).toMatchObject({
      centerMidi: CENTER_MIDI,
      centerRms: 0.04,
      pitchUpperCents: 300,
      pitchLowerCents: 200,
      brightnessAvailable: true,
      brightnessIndependent: true,
      completedRecoveryCount: 3,
    });
    expect(state.result!.brightnessDarkerDelta).toBeCloseTo(0.1, 12);
    expect(state.result!.brightnessBrighterDelta).toBeCloseTo(0.12, 12);
    expect(state.result!.brightnessTaskPitchDriftCents).toBeCloseTo(20, 8);
  });

  it("qualifies pitch stages without requiring brightness telemetry", () => {
    sampleIndex = 0;
    let state = createVocalCalibrationState();
    state = feed(state, 46, { brightness: 0.5 });
    state = advance(state);
    state = feed(state, 46, { cents: 220, brightness: null, brightnessConfidence: 0 });
    expect(vocalCalibrationReadiness(state).ready).toBe(true);
    expect(state.stagePitchSeconds).toBeGreaterThanOrEqual(0.8);
    expect(state.stageBrightnessSeconds).toBe(0);
  });

  it("cannot pass a stage with a center plateau and one extreme spike", () => {
    sampleIndex = 0;
    let state = createVocalCalibrationState();
    state = feed(state, 46, { brightness: 0.5 });
    state = advance(state);
    state = feed(state, 46, { cents: 0, brightness: null, brightnessConfidence: 0 });
    state = feed(state, 1, { cents: 700, brightness: null, brightnessConfidence: 0 });
    expect(state.stageQualifiedSeconds).toBe(0);
    const blocked = reduceVocalCalibration(state, { type: "next" });
    expect(blocked.stage).toBe("pitch-upper");
    expect(blocked.validationMessage).toContain("requested region");
  });

  it("never enters a discontinuous seed into calibration evidence", () => {
    sampleIndex = 0;
    let state = createVocalCalibrationState();
    state = reduceVocalCalibration(state, { type: "observe", sample: sample({ brightness: 0.5 }) });
    expect(state.measurements.neutralPitch.count).toBe(0);
    expect(state.measurements.neutralBrightness.count).toBe(0);
    expect(state.measurements.neutralRms.count).toBe(0);
    state = reduceVocalCalibration(state, { type: "observe", sample: sample({ brightness: 0.5 }) });
    expect(state.measurements.neutralPitch.count).toBe(1);
    expect(state.measurements.neutralBrightness.count).toBe(1);
  });

  it("requires stable neutral brightness while never gating on RMS", () => {
    sampleIndex = 0;
    let unstable = createVocalCalibrationState();
    for (let index = 0; index < 50; index += 1) {
      unstable = reduceVocalCalibration(unstable, {
        type: "observe",
        sample: sample({ brightness: index % 2 === 0 ? 0.32 : 0.68, rms: index % 2 === 0 ? 1e-8 : 0.7 }),
      });
    }
    expect(unstable.stageQualifiedSeconds).toBeGreaterThanOrEqual(0.8);
    expect(vocalCalibrationReadiness(unstable)).toMatchObject({
      ready: false,
      message: expect.stringContaining("brightness settle"),
    });

    sampleIndex = 0;
    let stable = createVocalCalibrationState();
    for (let index = 0; index < 50; index += 1) {
      stable = reduceVocalCalibration(stable, {
        type: "observe",
        sample: sample({ brightness: 0.5, rms: index % 2 === 0 ? 1e-8 : 0.7 }),
      });
    }
    expect(vocalCalibrationReadiness(stable).ready).toBe(true);
  });

  it("unlocks pitch-only calibration only after three sample-timed seconds of failed brightness work", () => {
    sampleIndex = 0;
    const ignoredAtNeutral = reduceVocalCalibration(createVocalCalibrationState(), {
      type: "skip-brightness",
    });
    expect(ignoredAtNeutral.brightnessCapability).toBe("unknown");

    let state = createVocalCalibrationState();
    state = feed(state, 46, { brightness: 0.5 });
    state = advance(state);
    state = feed(state, 46, { cents: 250, brightness: null, brightnessConfidence: 0 });
    state = advance(state);
    state = feed(state, 46, { cents: -180, brightness: null, brightnessConfidence: 0 });
    state = advance(state);
    state = feed(state, 100, { kind: "unvoiced", brightness: null });
    expect(state.stageAttemptSeconds).toBeCloseTo(1.98, 8);
    state = reduceVocalCalibration(state, { type: "skip-brightness" });
    expect(state.stage).toBe("brightness-dark");
    state = feed(state, 52, { kind: "unvoiced", brightness: null });
    expect(state.stageAttemptSeconds).toBeCloseTo(3.02, 8);
    state = reduceVocalCalibration(state, { type: "skip-brightness" });
    expect(state.stage).toBe("center-recovery");
    expect(state.brightnessCapability).toBe("limited");
    state = performRecoveries(state);
    state = advance(state);
    expect(state.result).toMatchObject({
      brightnessAvailable: false,
      brightnessIndependent: false,
      brightnessDarkerDelta: 0,
      brightnessBrighterDelta: 0,
      brightnessTaskPitchDriftCents: null,
    });
  });

  it("requires continuous voiced center dwell and never counts silence as recovery", () => {
    sampleIndex = 0;
    let state = throughBrightness();
    state = feed(state, 3, { cents: 140, brightness: 0.58 });
    expect(state.recoveryArmed).toBe(true);
    const before = state.recoveryCount;
    state = feed(state, 8, { kind: "unvoiced", brightness: null });
    expect(state.recoveryCount).toBe(before);
    expect(state.recoveryArmed).toBe(true);
    state = feed(state, 1, { cents: 0, brightness: 0.5 });
    expect(state.recoveryCount).toBe(before);
    state = feed(state, 14, { cents: 0, brightness: 0.5 });
    expect(state.recoveryCount).toBe(before);
    state = feed(state, 1, { cents: 0, brightness: 0.5 });
    expect(state.recoveryCount).toBe(before + 1);
  });

  it("uses hysteresis during center dwell but resets dwell after a meaningful departure", () => {
    sampleIndex = 0;
    let state = throughBrightness();
    state = feed(state, 3, { cents: 140, brightness: 0.58 });
    state = feed(state, 1, { cents: 0, brightness: 0.5 });
    state = feed(state, 5, { cents: 0, brightness: 0.5 });
    state = feed(state, 5, { cents: 15, brightness: 0.5 });
    expect(state.recoveryCenterEngaged).toBe(true);
    expect(state.recoveryCenteredSeconds).toBeCloseTo(0.2, 8);
    state = feed(state, 1, { cents: 20, brightness: 0.5 });
    expect(state.recoveryCenterEngaged).toBe(false);
    expect(state.recoveryCenteredSeconds).toBe(0);
    state = feed(state, 1, { cents: 0, brightness: 0.5 });
    state = feed(state, 14, { cents: 0, brightness: 0.5 });
    expect(state.recoveryCount).toBe(0);
    state = feed(state, 1, { cents: 0, brightness: 0.5 });
    expect(state.recoveryCount).toBe(1);
  });

  it("does not stitch a recovery across changed sample authority", () => {
    sampleIndex = 0;
    let state = throughBrightness();
    state = feed(state, 3, { cents: 140, brightness: 0.58 });
    state = feed(state, 8, { cents: 0, brightness: 0.5 });
    expect(state).toMatchObject({ recoveryArmed: true, recoveryCenterEngaged: true });
    state = reduceVocalCalibration(state, {
      type: "observe",
      sample: sample({ cents: 0, brightness: 0.5, discontinuity: true, continuityEpoch: 1 }),
    });
    expect(state).toMatchObject({
      recoveryArmed: false,
      recoveryCount: 0,
      currentRecoverySeconds: 0,
      recoveryCenterEngaged: false,
      recoveryCenteredSeconds: 0,
    });
    state = feed(state, 30, { cents: 0, brightness: 0.5 });
    expect(state.recoveryCount).toBe(0);
  });

  it("retries only the current stage and preserves completed prior evidence", () => {
    sampleIndex = 0;
    let state = createVocalCalibrationState();
    state = feed(state, 46, { brightness: 0.5 });
    state = advance(state);
    state = feed(state, 46, { cents: 260, brightness: null, brightnessConfidence: 0 });
    state = advance(state);
    const neutral = state.measurements.neutralPitch;
    const upper = state.measurements.upperPitchCents;
    state = feed(state, 12, { cents: -170, brightness: null, brightnessConfidence: 0 });
    state = reduceVocalCalibration(state, { type: "next" });
    expect(state.validationMessage).not.toBeNull();
    state = reduceVocalCalibration(state, { type: "reset-stage" });
    expect(state.stage).toBe("pitch-lower");
    expect(state.measurements.neutralPitch).toBe(neutral);
    expect(state.measurements.upperPitchCents).toBe(upper);
    expect(state.measurements.lowerPitchCents.count).toBe(0);
    expect(state).toMatchObject({
      stageQualifiedSeconds: 0,
      stageAttemptSeconds: 0,
      stageQualifiedSamples: 0,
      lastAuthority: null,
      validationMessage: null,
      recoveryArmed: false,
      recoveryCenterEngaged: false,
      recoveryCenteredSeconds: 0,
    });
  });

  it("clears only center-recovery evidence when that stage is retried", () => {
    sampleIndex = 0;
    let state = throughBrightness();
    const measurements = state.measurements;
    state = feed(state, 6, { cents: 140, brightness: 0.58 });
    state = feed(state, 20, { cents: 0, brightness: 0.5 });
    state = feed(state, 6, { cents: 140, brightness: 0.58 });
    state = feed(state, 5, { cents: 0, brightness: 0.5 });
    expect(state).toMatchObject({ recoveryCount: 1, recoveryArmed: true, recoveryCenterEngaged: true });
    state = reduceVocalCalibration(state, { type: "reset-stage" });
    expect(state.measurements).toBe(measurements);
    expect(state).toMatchObject({
      recoveryCount: 0,
      recoverySecondsTotal: 0,
      currentRecoverySeconds: 0,
      recoveryArmed: false,
      recoveryCenterEngaged: false,
      recoveryCenteredSeconds: 0,
    });
  });
});

describe("Vocal Flight control reticle", () => {
  it("keeps pitch-only calibration geometry finite and collapses the unavailable brightness axis", () => {
    const calibration: VocalControlCalibration = Object.freeze({
      centerFrequencyHz: 123.47,
      centerMidi: CENTER_MIDI,
      centerBrightness: 0.5,
      centerRms: 0.04,
      pitchLowerCents: 180,
      pitchUpperCents: 250,
      brightnessDarkerDelta: 0,
      brightnessBrighterDelta: 0,
      neutralPitchDeviationCents: 2,
      neutralBrightnessDeviation: 0,
      pitchDeadZoneCents: 12,
      brightnessDeadZone: 0,
      brightnessTaskPitchDriftCents: null,
      brightnessAvailable: false,
      brightnessIndependent: false,
      completedRecoveryCount: 3,
    });
    const markup = renderToStaticMarkup(createElement(VocalControlReticle, {
      calibration,
      vector: {
        pitchAxis: 0.5,
        brightnessAxis: 1,
        pitchConfidence: 0.9,
        brightnessConfidence: 0,
        voiced: true,
        active: true,
      },
    }));
    expect(markup).toContain("data-brightness-available=\"false\"");
    expect(markup).not.toMatch(/NaN|Infinity/u);
    expect(markup).toMatch(/class="vocal-control-current" cx="100" cy="[0-9.]+"/u);
  });
});
