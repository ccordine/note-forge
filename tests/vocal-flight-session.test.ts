import { describe, expect, it } from "vitest";

import {
  canLaunchVocalFlight,
  canSelectVocalFlightMode,
  createVocalFlightSession,
  desiredVocalFlightControl,
  reduceVocalFlightSession,
  type VocalFlightSessionState,
} from "../apps/web/src/features/voice-arcade/vocal-flight/vocal-flight-session";
import {
  createVocalFlightCourseState,
  getVocalFlightCourse,
} from "../apps/web/src/features/voice-arcade/vocal-flight/courses";
import { createVocalFlightState } from "../apps/web/src/features/voice-arcade/vocal-flight/flight-runtime";
import type {
  VocalControlCalibration,
  VocalTelemetrySample,
} from "../apps/web/src/features/voice-arcade/vocal-flight/types";

const CENTER_FREQUENCY = 130.81278265;

function calibration(brightnessAvailable = true): VocalControlCalibration {
  return Object.freeze({
    centerFrequencyHz: CENTER_FREQUENCY,
    centerMidi: 48,
    centerBrightness: 0.5,
    centerRms: 0.04,
    pitchLowerCents: 300,
    pitchUpperCents: 600,
    brightnessDarkerDelta: brightnessAvailable ? 0.2 : 0,
    brightnessBrighterDelta: brightnessAvailable ? 0.25 : 0,
    neutralPitchDeviationCents: 4,
    neutralBrightnessDeviation: brightnessAvailable ? 0.004 : 0,
    pitchDeadZoneCents: 16,
    brightnessDeadZone: brightnessAvailable ? 0.012 : 0,
    brightnessTaskPitchDriftCents: brightnessAvailable ? 18 : null,
    brightnessAvailable,
    brightnessIndependent: brightnessAvailable,
    completedRecoveryCount: 3,
  });
}

function calibratedState(
  brightnessAvailable = true,
  unlockedTutorialOrder = 19,
): VocalFlightSessionState {
  const state = createVocalFlightSession("medium");
  return {
    ...state,
    calibration: {
      ...state.calibration,
      stage: "complete",
      brightnessCapability: brightnessAvailable ? "available" : "limited",
      result: calibration(brightnessAvailable),
    },
    unlockedTutorialOrder,
  };
}

function telemetry(
  index: number,
  options: Readonly<{
    cents?: number;
    brightness?: number | null;
    kind?: VocalTelemetrySample["observationKind"];
    discontinuity?: boolean;
    continuityEpoch?: number;
  }> = {},
): VocalTelemetrySample {
  const sampleRate = 48_000;
  const endSample = 4_096 + index * 960;
  const kind = options.kind ?? "voiced";
  const voiced = kind === "voiced";
  const cents = options.cents ?? 0;
  return Object.freeze({
    observationKind: kind,
    sampleRate,
    startSample: endSample - 4_096,
    endSample,
    captureEpoch: 1,
    continuityEpoch: options.continuityEpoch ?? 0,
    graphGeneration: 0,
    discontinuity: options.discontinuity ?? index === 0,
    frequencyHz: voiced ? CENTER_FREQUENCY * 2 ** (cents / 1_200) : null,
    midiFloat: voiced ? 48 + cents / 100 : null,
    confidence: voiced ? 0.97 : 0,
    brightness: voiced ? options.brightness ?? 0.5 : null,
    brightnessConfidence: voiced && options.brightness !== null ? 0.95 : 0,
    rms: voiced ? 0.04 : 0,
  });
}

function observe(
  state: VocalFlightSessionState,
  sample: VocalTelemetrySample,
): VocalFlightSessionState {
  return reduceVocalFlightSession(state, { type: "observation", sample });
}

describe("integrated Vocal Flight session", () => {
  it("uses exact observation time, neutralizes silence, and never catches up on resumed voice", () => {
    let state = calibratedState();
    state = reduceVocalFlightSession(state, {
      type: "select-course",
      courseId: "pitch-hold-altitude",
    });
    state = reduceVocalFlightSession(state, { type: "launch" });
    const initial = state.flight;

    state = observe(state, telemetry(0, { cents: 220 }));
    expect(state.flight).toBe(initial);
    expect(state.vector.active).toBe(false);

    state = observe(state, telemetry(1, { cents: 220 }));
    expect(state.vector.pitchAxis).toBeGreaterThan(0);
    expect(state.vector.brightnessAxis).toBeCloseTo(0, 12);
    expect(state.flight.position.z).toBeGreaterThan(0);
    const beforeSilence = state.flight;

    state = observe(state, telemetry(2, { kind: "unvoiced", brightness: null }));
    expect(state.vector).toMatchObject({ active: false, pitchAxis: 0, brightnessAxis: 0 });
    expect(state.flight.position.z).toBeGreaterThan(beforeSilence.position.z);
    const beforeResume = state.flight;

    state = observe(state, telemetry(3, { cents: 220 }));
    expect(state.vector.active).toBe(false);
    expect(state.flight).toBe(beforeResume);
    state = observe(state, telemetry(4, { cents: 220 }));
    expect(state.vector.active).toBe(true);
    expect(state.flight.position.z).toBeGreaterThan(beforeResume.position.z);

    const beforeGap = state.flight;
    state = observe(state, telemetry(5, { cents: 220, discontinuity: true }));
    expect(state.flight).toBe(beforeGap);
    expect(state.vector.active).toBe(false);
  });

  it("maps same-pitch harmonic shape to roll without inventing elevator input", () => {
    let dark = calibratedState();
    dark = reduceVocalFlightSession(dark, {
      type: "select-course",
      courseId: "brightness-roll",
    });
    dark = reduceVocalFlightSession(dark, { type: "launch" });
    dark = observe(dark, telemetry(0, { brightness: 0.5 }));
    dark = observe(dark, telemetry(1, { brightness: 0.32 }));
    dark = observe(dark, telemetry(2, { brightness: 0.32 }));

    let bright = calibratedState();
    bright = reduceVocalFlightSession(bright, {
      type: "select-course",
      courseId: "brightness-roll",
    });
    bright = reduceVocalFlightSession(bright, { type: "launch" });
    bright = observe(bright, telemetry(0, { brightness: 0.5 }));
    bright = observe(bright, telemetry(1, { brightness: 0.7 }));
    bright = observe(bright, telemetry(2, { brightness: 0.7 }));

    expect(dark.vector.brightnessAxis).toBeLessThan(0);
    expect(bright.vector.brightnessAxis).toBeGreaterThan(0);
    expect(dark.vector.pitchAxis).toBeCloseTo(0, 12);
    expect(bright.vector.pitchAxis).toBeCloseTo(0, 12);
    expect(dark.flight.rollRadians).toBeLessThan(0);
    expect(bright.flight.rollRadians).toBeGreaterThan(0);
    expect(Math.abs(dark.flight.pitchRadians)).toBeLessThan(1e-9);
    expect(Math.abs(bright.flight.pitchRadians)).toBeLessThan(1e-9);
  });

  it("keeps pitch-only flight usable without pretending brightness was calibrated", () => {
    let state = calibratedState(false);
    state = reduceVocalFlightSession(state, {
      type: "select-course",
      courseId: "brightness-roll",
    });
    expect(canLaunchVocalFlight(state)).toBe(false);
    expect(reduceVocalFlightSession(state, { type: "launch" }).phase).toBe("calibration");

    state = reduceVocalFlightSession(state, {
      type: "select-course",
      courseId: "pitch-climb-descend",
    });
    expect(canLaunchVocalFlight(state)).toBe(true);
    state = reduceVocalFlightSession(state, { type: "launch" });
    expect(state.phase).toBe("flying");
    expect(state.control?.calibration.brightnessAvailable).toBe(false);
  });

  it("changes game intent without touching transport or inventing feature persistence", () => {
    let state = calibratedState();
    state = { ...state, unlockedTutorialOrder: 19 };
    state = reduceVocalFlightSession(state, { type: "select-mode", mode: "free-flight" });
    state = reduceVocalFlightSession(state, { type: "launch" });
    expect(state.phase).toBe("flying");
    expect(state.course).toBeNull();
    state = reduceVocalFlightSession(state, { type: "finish" });
    expect(state.phase).toBe("complete");
    expect(state.completedRunId).toBe(state.runId);
    state = reduceVocalFlightSession(state, { type: "return-loadout" });
    expect(state.phase).toBe("calibration");
    expect(state.calibration.result).not.toBeNull();
  });

  it("makes the three dedicated challenges sequential before combined modes", () => {
    let state = calibratedState(true, 1);
    expect(state.unlockedTutorialOrder).toBe(1);
    expect(canSelectVocalFlightMode(state, "pitch-tunnel")).toBe(false);
    expect(canSelectVocalFlightMode(state, "ring-run")).toBe(false);

    const rejectedCourse = reduceVocalFlightSession(state, {
      type: "select-course",
      courseId: "combined-diagonal-rings",
    });
    expect(rejectedCourse.selectedCourseId).toBe("neutral-find-center");
    expect(reduceVocalFlightSession(state, { type: "select-mode", mode: "ring-run" }).mode)
      .toBe("training");

    state = { ...state, unlockedTutorialOrder: 7 };
    expect(canSelectVocalFlightMode(state, "pitch-tunnel")).toBe(true);
    expect(canSelectVocalFlightMode(state, "ring-run")).toBe(false);
    state = { ...state, unlockedTutorialOrder: 19 };
    expect(canSelectVocalFlightMode(state, "ring-run")).toBe(true);
    expect(canSelectVocalFlightMode(state, "free-flight")).toBe(true);
  });

  it("hydrates only the contiguous completed tutorial sequence from Arcade authority", () => {
    const firstThree = createVocalFlightSession("medium", [
      "neutral-find-center",
      "neutral-leave-return",
      "neutral-stabilize",
    ]);
    expect(firstThree.unlockedTutorialOrder).toBe(4);
    expect(firstThree.selectedCourseId).toBe("pitch-climb-descend");
    const gapCannotSkip = createVocalFlightSession("medium", [
      "neutral-find-center",
      "neutral-stabilize",
      "combined-diagonal-rings",
    ]);
    expect(gapCannotSkip.unlockedTutorialOrder).toBe(2);
  });

  it("scores moving and alternate-route targets from the same dynamic course authority", () => {
    const moving = createVocalFlightCourseState(getVocalFlightCourse("precision-moving-line"));
    const origin = createVocalFlightState();
    const atStart = desiredVocalFlightControl(origin, moving);
    const later = desiredVocalFlightControl(origin, { ...moving, sampleSeconds: 4 });
    expect(later).not.toEqual(atStart);

    const navigation = createVocalFlightCourseState(getVocalFlightCourse("automaticity-navigation"));
    const rightOfCenter = {
      ...origin,
      position: { ...origin.position, x: 4 },
    };
    const branchDemand = desiredVocalFlightControl(rightOfCenter, navigation);
    expect(branchDemand.brightnessAxis).toBeGreaterThan(0);
    expect(branchDemand.pitchAxis).toBeLessThan(0);
  });
});
