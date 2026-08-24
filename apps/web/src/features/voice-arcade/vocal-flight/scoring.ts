import type {
  VocalControlVector,
  VocalFlightControlMode,
  VocalFlightScoreResult,
} from "./types";

export interface VocalFlightScoreState {
  readonly parSeconds: number | null;
  readonly scoredSeconds: number;
  readonly activeControlSeconds: number;
  readonly pathErrorIntegral: number;
  readonly controlVariation: number;
  readonly previousControl: VocalControlVector | null;
  readonly previousPitchError: number | null;
  readonly previousBrightnessError: number | null;
  readonly overshootCount: number;
  readonly recoveryPending: boolean;
  readonly recoveryCurrentSeconds: number;
  readonly recoveryTotalSeconds: number;
  readonly recoveryStarted: number;
  readonly recoveryCompleted: number;
  readonly previousDemandMagnitude: number;
  readonly pitchOnlySeconds: number;
  readonly pitchTaskBrightnessLeakIntegral: number;
  readonly brightnessOnlySeconds: number;
  readonly brightnessTaskPitchLeakIntegral: number;
  readonly brightnessTaskPitchDriftIntegral: number;
  readonly efficiencyIntegral: number;
}

export interface VocalFlightScoringSample {
  readonly deltaSeconds: number;
  readonly control: VocalControlVector;
  readonly controlMode: VocalFlightControlMode;
  readonly pathError: number;
  readonly pathTolerance: number;
  readonly desiredPitchAxis: number;
  readonly desiredBrightnessAxis: number;
  readonly pitchDeltaCents: number | null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function createVocalFlightScoreState(parSeconds: number | null = null): VocalFlightScoreState {
  if (parSeconds !== null && (!Number.isFinite(parSeconds) || parSeconds <= 0)) {
    throw new RangeError("Flight scoring par time must be positive when provided.");
  }
  return Object.freeze({
    parSeconds,
    scoredSeconds: 0,
    activeControlSeconds: 0,
    pathErrorIntegral: 0,
    controlVariation: 0,
    previousControl: null,
    previousPitchError: null,
    previousBrightnessError: null,
    overshootCount: 0,
    recoveryPending: false,
    recoveryCurrentSeconds: 0,
    recoveryTotalSeconds: 0,
    recoveryStarted: 0,
    recoveryCompleted: 0,
    previousDemandMagnitude: 0,
    pitchOnlySeconds: 0,
    pitchTaskBrightnessLeakIntegral: 0,
    brightnessOnlySeconds: 0,
    brightnessTaskPitchLeakIntegral: 0,
    brightnessTaskPitchDriftIntegral: 0,
    efficiencyIntegral: 0,
  });
}

function crossedPast(previousError: number | null, nextError: number): boolean {
  return previousError !== null
    && Math.abs(previousError) >= 0.1
    && Math.abs(nextError) >= 0.1
    && Math.sign(previousError) !== Math.sign(nextError);
}

function efficiencyFor(actual: number, desired: number): number {
  if (desired <= 0.08) return 1 - clamp(actual / 0.4, 0, 1);
  return Math.min(actual, desired) / Math.max(actual, desired, 1e-9);
}

/** Accumulate only flight-relevant behavior; RMS/loudness is deliberately absent. */
export function advanceVocalFlightScore(
  state: Readonly<VocalFlightScoreState>,
  sample: Readonly<VocalFlightScoringSample>,
): VocalFlightScoreState {
  const deltaSeconds = finite(sample.deltaSeconds, -1);
  if (deltaSeconds <= 0) {
    return Object.freeze({
      ...state,
      previousControl: null,
      previousPitchError: null,
      previousBrightnessError: null,
    });
  }
  if (sample.pathTolerance <= 0 || !Number.isFinite(sample.pathTolerance)) {
    throw new RangeError("Flight scoring path tolerance must be positive.");
  }
  const pitchAxis = clamp(finite(sample.control.pitchAxis), -1, 1);
  const brightnessAxis = clamp(finite(sample.control.brightnessAxis), -1, 1);
  const desiredPitch = clamp(finite(sample.desiredPitchAxis), -1, 1);
  const desiredBrightness = clamp(finite(sample.desiredBrightnessAxis), -1, 1);
  const pitchError = pitchAxis - desiredPitch;
  const brightnessError = brightnessAxis - desiredBrightness;
  const demandMagnitude = Math.hypot(desiredPitch, desiredBrightness);
  const actualMagnitude = Math.hypot(pitchAxis, brightnessAxis);
  const releaseBegan = state.previousDemandMagnitude > 0.2 && demandMagnitude <= 0.08;
  let recoveryPending = state.recoveryPending || releaseBegan;
  const recoveryStarted = state.recoveryStarted + Number(releaseBegan);
  let recoveryCurrentSeconds = recoveryPending
    ? state.recoveryCurrentSeconds + deltaSeconds
    : 0;
  let recoveryCompleted = state.recoveryCompleted;
  let recoveryTotalSeconds = state.recoveryTotalSeconds;
  if (recoveryPending && sample.control.active && actualMagnitude <= 0.1) {
    recoveryCompleted += 1;
    recoveryTotalSeconds += recoveryCurrentSeconds;
    recoveryCurrentSeconds = 0;
    recoveryPending = false;
  }
  const pathState = {
    ...state,
    scoredSeconds: state.scoredSeconds + deltaSeconds,
    pathErrorIntegral: state.pathErrorIntegral
      + clamp(Math.abs(finite(sample.pathError)) / sample.pathTolerance, 0, 2) * deltaSeconds,
    recoveryPending,
    recoveryCurrentSeconds,
    recoveryTotalSeconds,
    recoveryStarted,
    recoveryCompleted,
    previousDemandMagnitude: demandMagnitude,
  };
  if (!sample.control.active) {
    return Object.freeze({
      ...pathState,
      previousControl: null,
      previousPitchError: null,
      previousBrightnessError: null,
    });
  }
  const overshootCount = state.overshootCount
    + Number(crossedPast(state.previousPitchError, pitchError))
    + Number(crossedPast(state.previousBrightnessError, brightnessError));
  const controlVariation = state.previousControl === null
    ? state.controlVariation
    : state.controlVariation + Math.hypot(
      pitchAxis - state.previousControl.pitchAxis,
      brightnessAxis - state.previousControl.brightnessAxis,
    );
  const pitchOnly = sample.controlMode === "pitch";
  const brightnessOnly = sample.controlMode === "brightness";
  const pitchDrift = sample.pitchDeltaCents === null
    ? 0
    : Math.abs(finite(sample.pitchDeltaCents));
  return Object.freeze({
    ...pathState,
    activeControlSeconds: state.activeControlSeconds + deltaSeconds,
    controlVariation,
    previousControl: Object.freeze({ ...sample.control, pitchAxis, brightnessAxis }),
    previousPitchError: Math.abs(pitchError) >= 0.1 ? pitchError : state.previousPitchError,
    previousBrightnessError: Math.abs(brightnessError) >= 0.1
      ? brightnessError
      : state.previousBrightnessError,
    overshootCount,
    pitchOnlySeconds: state.pitchOnlySeconds + (pitchOnly ? deltaSeconds : 0),
    pitchTaskBrightnessLeakIntegral: state.pitchTaskBrightnessLeakIntegral
      + (pitchOnly ? Math.abs(brightnessAxis) * deltaSeconds : 0),
    brightnessOnlySeconds: state.brightnessOnlySeconds + (brightnessOnly ? deltaSeconds : 0),
    brightnessTaskPitchLeakIntegral: state.brightnessTaskPitchLeakIntegral
      + (brightnessOnly ? Math.abs(pitchAxis) * deltaSeconds : 0),
    brightnessTaskPitchDriftIntegral: state.brightnessTaskPitchDriftIntegral
      + (brightnessOnly ? pitchDrift * deltaSeconds : 0),
    efficiencyIntegral: state.efficiencyIntegral
      + efficiencyFor(actualMagnitude, demandMagnitude) * deltaSeconds,
  });
}

function grade(score: number): VocalFlightScoreResult["grade"] {
  if (score >= 93) return "S";
  if (score >= 84) return "A";
  if (score >= 73) return "B";
  if (score >= 60) return "C";
  return "D";
}

export function summarizeVocalFlightScore(
  state: Readonly<VocalFlightScoreState>,
): VocalFlightScoreResult {
  if (state.scoredSeconds <= 0) {
    return Object.freeze({
      score: 0,
      grade: "D",
      courseAccuracyPercent: 0,
      smoothnessPercent: 0,
      overshootCount: 0,
      centerRecoveryPercent: null,
      averageCenterRecoverySeconds: null,
      axisIndependencePercent: null,
      pitchTaskBrightnessLeak: null,
      brightnessTaskPitchDriftCents: null,
      controlEfficiencyPercent: 0,
      timeEfficiencyPercent: null,
      scoredSeconds: 0,
    });
  }
  const seconds = Math.max(1e-9, state.scoredSeconds);
  const activeSeconds = state.activeControlSeconds;
  const normalizedPathError = state.pathErrorIntegral / seconds;
  const courseAccuracyPercent = clamp((1 - normalizedPathError) * 100, 0, 100);
  const variationPerSecond = activeSeconds <= 0 ? Number.POSITIVE_INFINITY : state.controlVariation / activeSeconds;
  const smoothnessPercent = activeSeconds <= 0
    ? 0
    : clamp(Math.exp(-variationPerSecond * 0.38) * 100, 0, 100);
  const averageCenterRecoverySeconds = state.recoveryCompleted === 0
    ? null
    : state.recoveryTotalSeconds / state.recoveryCompleted;
  const completionShare = state.recoveryStarted === 0
    ? null
    : state.recoveryCompleted / state.recoveryStarted;
  const recoverySpeed = averageCenterRecoverySeconds === null
    ? 1
    : Math.exp(-averageCenterRecoverySeconds / 1.2);
  const centerRecoveryPercent = completionShare === null
    ? null
    : clamp(completionShare * recoverySpeed * 100, 0, 100);
  const pitchTaskBrightnessLeak = state.pitchOnlySeconds <= 0
    ? null
    : state.pitchTaskBrightnessLeakIntegral / state.pitchOnlySeconds;
  const brightnessTaskPitchDriftCents = state.brightnessOnlySeconds <= 0
    ? null
    : state.brightnessTaskPitchDriftIntegral / state.brightnessOnlySeconds;
  const pitchIndependence = state.pitchOnlySeconds <= 0
    ? null
    : clamp(1 - pitchTaskBrightnessLeak! / 0.35, 0, 1);
  const brightnessIndependence = state.brightnessOnlySeconds <= 0
    ? null
    : clamp(
      1 - state.brightnessTaskPitchLeakIntegral / state.brightnessOnlySeconds / 0.35,
      0,
      1,
    );
  const independenceScores = [pitchIndependence, brightnessIndependence]
    .filter((value): value is number => value !== null);
  const axisIndependencePercent = independenceScores.length === 0
    ? null
    : independenceScores.reduce((total, value) => total + value, 0)
      / independenceScores.length * 100;
  const controlEfficiencyPercent = activeSeconds <= 0
    ? 0
    : clamp(state.efficiencyIntegral / activeSeconds * 100, 0, 100);
  const timeEfficiencyPercent = state.parSeconds === null
    ? null
    : clamp(state.parSeconds / seconds * 100, 0, 100);
  const weighted = [
    { value: courseAccuracyPercent, weight: 0.35 },
    { value: smoothnessPercent, weight: 0.15 },
    { value: centerRecoveryPercent, weight: 0.15 },
    { value: axisIndependencePercent, weight: 0.2 },
    { value: controlEfficiencyPercent, weight: 0.15 },
    { value: timeEfficiencyPercent, weight: 0.15 },
  ].filter((item): item is { value: number; weight: number } => item.value !== null);
  const weight = weighted.reduce((total, item) => total + item.weight, 0);
  const rawScore = weighted.reduce((total, item) => total + item.value * item.weight, 0)
    / weight
    - Math.min(20, state.overshootCount * 2);
  const score = Math.round(clamp(rawScore, 0, 100));
  return Object.freeze({
    score,
    grade: grade(score),
    courseAccuracyPercent,
    smoothnessPercent,
    overshootCount: state.overshootCount,
    centerRecoveryPercent,
    averageCenterRecoverySeconds,
    axisIndependencePercent,
    pitchTaskBrightnessLeak,
    brightnessTaskPitchDriftCents,
    controlEfficiencyPercent,
    timeEfficiencyPercent,
    scoredSeconds: state.scoredSeconds,
  });
}
