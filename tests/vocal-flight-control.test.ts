import { describe, expect, it } from "vitest";

import {
  createVocalControlState,
  updateVocalControl,
} from "../apps/web/src/features/voice-arcade/vocal-flight/vocal-control";
import type {
  VocalControlCalibration,
  VocalTelemetrySample,
} from "../apps/web/src/features/voice-arcade/vocal-flight/types";

const CENTER_HZ = 123.470825;
const CALIBRATION = Object.freeze({
  centerFrequencyHz: CENTER_HZ,
  centerMidi: 47,
  centerBrightness: 0.5,
  centerRms: 0.04,
  pitchLowerCents: 350,
  pitchUpperCents: 700,
  brightnessDarkerDelta: 0.2,
  brightnessBrighterDelta: 0.35,
  neutralPitchDeviationCents: 4,
  neutralBrightnessDeviation: 0.004,
  pitchDeadZoneCents: 20,
  brightnessDeadZone: 0.015,
  brightnessTaskPitchDriftCents: 18,
  brightnessAvailable: true,
  brightnessIndependent: true,
  completedRecoveryCount: 3,
}) satisfies VocalControlCalibration;

function observation(
  index: number,
  options: Readonly<{
    cents?: number;
    brightness?: number | null;
    brightnessConfidence?: number;
    confidence?: number;
    kind?: VocalTelemetrySample["observationKind"];
    endSample?: number;
    captureEpoch?: number;
    continuityEpoch?: number;
    graphGeneration?: number;
    discontinuity?: boolean;
    rms?: number;
  }> = {},
): VocalTelemetrySample {
  const sampleRate = 48_000;
  const endSample = options.endSample ?? 4_096 + index * 960;
  const cents = options.cents ?? 0;
  const kind = options.kind ?? "voiced";
  const voiced = kind === "voiced";
  const frequencyHz = voiced ? CENTER_HZ * 2 ** (cents / 1_200) : null;
  return Object.freeze({
    observationKind: kind,
    sampleRate,
    startSample: endSample - 4_096,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: options.captureEpoch ?? 1,
    continuityEpoch: options.continuityEpoch ?? 0,
    graphGeneration: options.graphGeneration ?? 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: options.discontinuity ?? index === 0,
    frequencyHz,
    midiFloat: frequencyHz === null ? null : 69 + 12 * Math.log2(frequencyHz / 440),
    confidence: options.confidence ?? (voiced ? 0.97 : 0),
    brightness: options.brightness === undefined ? 0.5 : options.brightness,
    brightnessConfidence: options.brightnessConfidence ?? (voiced ? 0.96 : 0),
    rms: options.rms ?? (voiced ? 0.04 : 0),
  });
}

function fastControl(calibration: VocalControlCalibration = CALIBRATION) {
  return createVocalControlState(calibration, {
    responsePerSecond: 1_000,
    responseCurve: 1,
  });
}

describe("Vocal Flight personalized control adapter", () => {
  it("normalizes asymmetric pitch and brightness ranges to equivalent full travel", () => {
    let state = fastControl();
    state = updateVocalControl(state, observation(0, { cents: 700, brightness: 0.85 })).state;
    let update = updateVocalControl(state, observation(1, { cents: 700, brightness: 0.85 }));
    expect(update.vector.pitchAxis).toBeCloseTo(1, 6);
    expect(update.vector.brightnessAxis).toBeCloseTo(1, 6);

    state = update.state;
    update = updateVocalControl(state, observation(2, { cents: -350, brightness: 0.3 }));
    expect(update.vector.pitchAxis).toBeCloseTo(-1, 6);
    expect(update.vector.brightnessAxis).toBeCloseTo(-1, 6);
  });

  it("uses a dead zone and hysteresis without turning center noise into control", () => {
    let state = fastControl();
    state = updateVocalControl(state, observation(0)).state;
    let update = updateVocalControl(state, observation(1, { cents: 15, brightness: 0.51 }));
    expect(update.vector).toMatchObject({ pitchAxis: 0, brightnessAxis: 0, active: true });

    state = update.state;
    update = updateVocalControl(state, observation(2, { cents: 80, brightness: 0.54 }));
    expect(update.vector.pitchAxis).toBeGreaterThan(0);
    expect(update.vector.brightnessAxis).toBeGreaterThan(0);
    state = update.state;
    update = updateVocalControl(state, observation(3, { cents: 10, brightness: 0.505 }));
    expect(update.vector.pitchAxis).toBe(0);
    expect(update.vector.brightnessAxis).toBe(0);
  });

  it("zeros stale roll immediately when brightness loses confidence while pitch remains live", () => {
    let state = fastControl();
    state = updateVocalControl(state, observation(0, { cents: 200, brightness: 0.7 })).state;
    state = updateVocalControl(state, observation(1, { cents: 200, brightness: 0.7 })).state;
    expect(state.vector.brightnessAxis).toBeGreaterThan(0.4);

    const update = updateVocalControl(state, observation(2, {
      cents: 200,
      brightness: null,
      brightnessConfidence: 0,
    }));
    expect(update.vector.pitchAxis).toBeGreaterThan(0);
    expect(update.vector.brightnessAxis).toBe(0);
    expect(update.vector.active).toBe(true);
  });

  it("keeps pitch control live while the shared brightness policy neutralizes only unqualified roll", () => {
    let state = fastControl();
    state = updateVocalControl(state, observation(0, {
      cents: 200,
      brightness: 0.8,
      brightnessConfidence: 0.54,
      confidence: 0.01,
    })).state;
    const update = updateVocalControl(state, observation(1, {
      cents: 200,
      brightness: 0.8,
      brightnessConfidence: 0.54,
      confidence: 0.01,
    }));
    expect(update.vector.pitchAxis).toBeGreaterThan(0);
    expect(update.vector.brightnessAxis).toBe(0);
    expect(update.vector.active).toBe(true);
  });

  it("makes contiguous silence neutral yet preserves autonomous sample time", () => {
    let state = fastControl();
    state = updateVocalControl(state, observation(0, { cents: 300, brightness: 0.7 })).state;
    state = updateVocalControl(state, observation(1, { cents: 300, brightness: 0.7 })).state;
    const silence = updateVocalControl(state, observation(2, { kind: "unvoiced", brightness: null }));
    expect(silence.deltaSeconds).toBeCloseTo(0.02, 12);
    expect(silence.vector).toMatchObject({
      pitchAxis: 0,
      brightnessAxis: 0,
      voiced: false,
      active: false,
    });

    const firstVoice = updateVocalControl(
      silence.state,
      observation(3, { cents: 300, brightness: 0.7 }),
    );
    expect(firstVoice.deltaSeconds).toBe(0);
    expect(firstVoice.vector).toMatchObject({ pitchAxis: 0, brightnessAxis: 0, active: false });
    const resumed = updateVocalControl(
      firstVoice.state,
      observation(4, { cents: 300, brightness: 0.7 }),
    );
    expect(resumed.deltaSeconds).toBeCloseTo(0.02, 12);
    expect(resumed.vector.active).toBe(true);
  });

  it.each([
    ["discontinuity", { discontinuity: true }],
    ["capture epoch", { captureEpoch: 2 }],
    ["continuity epoch", { continuityEpoch: 2 }],
    ["graph generation", { graphGeneration: 2 }],
    ["gap", { endSample: 4_096 + 2 * 960 + 9_600 }],
    ["duplicate", { endSample: 4_096 + 960 }],
    ["reordered", { endSample: 4_096 }],
  ])("zeros axes and sample time at a %s boundary", (_name, change) => {
    let state = fastControl();
    state = updateVocalControl(state, observation(0, { cents: 300, brightness: 0.7 })).state;
    state = updateVocalControl(state, observation(1, { cents: 300, brightness: 0.7 })).state;
    expect(state.vector.pitchAxis).toBeGreaterThan(0);
    const boundary = updateVocalControl(
      state,
      observation(2, { cents: 300, brightness: 0.7, ...change }),
    );
    expect(boundary.deltaSeconds).toBe(0);
    expect(boundary.vector).toMatchObject({ pitchAxis: 0, brightnessAxis: 0, active: false });
  });

  it("never uses diagnostic RMS to admit or scale either control axis", () => {
    let quiet = fastControl();
    let loud = fastControl();
    quiet = updateVocalControl(quiet, observation(0, { cents: 200, brightness: 0.65, rms: 1e-6 })).state;
    loud = updateVocalControl(loud, observation(0, { cents: 200, brightness: 0.65, rms: 0.8 })).state;
    const quietUpdate = updateVocalControl(
      quiet,
      observation(1, { cents: 200, brightness: 0.65, rms: 1e-6 }),
    );
    const loudUpdate = updateVocalControl(
      loud,
      observation(1, { cents: 200, brightness: 0.65, rms: 0.8 }),
    );
    expect(quietUpdate.vector).toEqual(loudUpdate.vector);
  });

  it("supports a valid pitch-only profile without fabricating brightness control", () => {
    const pitchOnly: VocalControlCalibration = {
      ...CALIBRATION,
      brightnessDarkerDelta: 0,
      brightnessBrighterDelta: 0,
      brightnessDeadZone: 0,
      brightnessTaskPitchDriftCents: null,
      brightnessAvailable: false,
      brightnessIndependent: false,
    };
    let state = fastControl(pitchOnly);
    state = updateVocalControl(state, observation(0, { cents: 300, brightness: 0.9 })).state;
    const update = updateVocalControl(state, observation(1, { cents: 300, brightness: 0.9 }));
    expect(update.vector.pitchAxis).toBeGreaterThan(0);
    expect(update.vector.brightnessAxis).toBe(0);
  });
});
