import { hasQualifiedBrightnessEvidence } from "@/audio/vocal-brightness";
import { clamp } from "@/lib/numeric";
import { observationContinuity } from "@/realtime/observation-continuity";
import type {
  SampleAuthority,
  VocalControlCalibration,
  VocalTelemetrySample,
} from "./types";

export type VocalCalibrationStage =
  | "neutral"
  | "pitch-upper"
  | "pitch-lower"
  | "brightness-dark"
  | "brightness-bright"
  | "center-recovery"
  | "complete";
export type BrightnessCapability = "unknown" | "available" | "limited";

interface RunningMoment {
  readonly count: number;
  readonly mean: number;
  readonly sumSquaredDeviation: number;
  readonly minimum: number;
  readonly maximum: number;
}
export interface VocalCalibrationMeasurements {
  readonly neutralPitch: RunningMoment;
  readonly neutralBrightness: RunningMoment;
  readonly neutralRms: RunningMoment;
  readonly upperPitchCents: RunningMoment;
  readonly lowerPitchCents: RunningMoment;
  readonly darkerBrightnessDelta: RunningMoment;
  readonly brighterBrightnessDelta: RunningMoment;
  readonly darkTaskPitchDriftCents: RunningMoment;
  readonly brightTaskPitchDriftCents: RunningMoment;
}
export interface VocalCalibrationState {
  readonly stage: VocalCalibrationStage;
  readonly brightnessCapability: BrightnessCapability;
  readonly measurements: VocalCalibrationMeasurements;
  readonly stageQualifiedSeconds: number;
  readonly stagePitchSeconds: number;
  readonly stageBrightnessSeconds: number;
  readonly stageAttemptSeconds: number;
  readonly stageQualifiedSamples: number;
  readonly lastPitchQualified: boolean;
  readonly lastBrightnessQualified: boolean;
  readonly lastAuthority: SampleAuthority | null;
  readonly recoveryArmed: boolean;
  readonly recoveryCount: number;
  readonly recoverySecondsTotal: number;
  readonly currentRecoverySeconds: number;
  readonly recoveryCenterEngaged: boolean;
  readonly recoveryCenteredSeconds: number;
  readonly validationMessage: string | null;
  readonly result: VocalControlCalibration | null;
}
export type VocalCalibrationAction =
  | { readonly type: "observe"; readonly sample: VocalTelemetrySample }
  | { readonly type: "next" }
  | { readonly type: "back" }
  | { readonly type: "skip-brightness" }
  | { readonly type: "reset-stage" }
  | { readonly type: "reset" };

const STAGES: readonly VocalCalibrationStage[] = Object.freeze([
  "neutral", "pitch-upper", "pitch-lower", "brightness-dark",
  "brightness-bright", "center-recovery", "complete",
]);
const MINIMUM_STAGE_SECONDS = 0.8;
const MINIMUM_PITCH_EXTENT_CENTS = 80;
const MINIMUM_BRIGHTNESS_EXTENT = 0.025;
const MINIMUM_RECOVERIES = 3;
const MINIMUM_BRIGHTNESS_FALLBACK_SECONDS = 3;
const MAXIMUM_NEUTRAL_BRIGHTNESS_DEVIATION = 0.025;
const CENTER_RECOVERY_HOLD_SECONDS = 0.3;
const CENTER_RECOVERY_HYSTERESIS_RATIO = 1.5;
const RESET_STAGE_PROGRESS = Object.freeze({
  stageQualifiedSeconds: 0, stagePitchSeconds: 0, stageBrightnessSeconds: 0,
  stageAttemptSeconds: 0, stageQualifiedSamples: 0,
  lastPitchQualified: false, lastBrightnessQualified: false, lastAuthority: null,
  recoveryArmed: false, currentRecoverySeconds: 0,
  recoveryCenterEngaged: false, recoveryCenteredSeconds: 0,
  validationMessage: null,
});
function emptyMoment(): RunningMoment {
  return Object.freeze({
    count: 0,
    mean: 0,
    sumSquaredDeviation: 0,
    minimum: Number.POSITIVE_INFINITY,
    maximum: Number.NEGATIVE_INFINITY,
  });
}
function addMoment(moment: Readonly<RunningMoment>, value: number): RunningMoment {
  const count = moment.count + 1;
  const difference = value - moment.mean;
  const mean = moment.mean + difference / count;
  return Object.freeze({
    count,
    mean,
    sumSquaredDeviation: moment.sumSquaredDeviation + difference * (value - mean),
    minimum: Math.min(moment.minimum, value),
    maximum: Math.max(moment.maximum, value),
  });
}

function deviation(moment: Readonly<RunningMoment>): number {
  return moment.count < 2 ? 0 : Math.sqrt(
    moment.sumSquaredDeviation / (moment.count - 1),
  );
}

function emptyMeasurements(): VocalCalibrationMeasurements {
  return Object.freeze({
    neutralPitch: emptyMoment(), neutralBrightness: emptyMoment(), neutralRms: emptyMoment(),
    upperPitchCents: emptyMoment(), lowerPitchCents: emptyMoment(),
    darkerBrightnessDelta: emptyMoment(), brighterBrightnessDelta: emptyMoment(),
    darkTaskPitchDriftCents: emptyMoment(), brightTaskPitchDriftCents: emptyMoment(),
  });
}

export function createVocalCalibrationState(): VocalCalibrationState {
  return Object.freeze({
    stage: "neutral",
    brightnessCapability: "unknown",
    measurements: emptyMeasurements(),
    ...RESET_STAGE_PROGRESS,
    recoveryCount: 0,
    recoverySecondsTotal: 0,
    result: null,
  });
}

function reliablePitch(sample: Readonly<VocalTelemetrySample>): boolean {
  return sample.observationKind === "voiced"
    && sample.frequencyHz !== null
    && Number.isFinite(sample.frequencyHz)
    && sample.frequencyHz > 0
    && sample.midiFloat !== null
    && Number.isFinite(sample.midiFloat);
}

function reliableBrightness(sample: Readonly<VocalTelemetrySample>): boolean {
  return sample.observationKind === "voiced"
    && hasQualifiedBrightnessEvidence(sample);
}

function centerValues(measurements: Readonly<VocalCalibrationMeasurements>): {
  readonly midi: number;
  readonly frequencyHz: number;
  readonly brightness: number | null;
} | null {
  if (measurements.neutralPitch.count === 0) return null;
  const midi = measurements.neutralPitch.mean;
  return {
    midi,
    frequencyHz: 440 * 2 ** ((midi - 69) / 12),
    brightness: measurements.neutralBrightness.count > 0
      ? measurements.neutralBrightness.mean
      : null,
  };
}

interface ObservationResult {
  readonly measurements: VocalCalibrationMeasurements;
  readonly pitchQualified: boolean;
  readonly brightnessQualified: boolean;
}

function observeMeasurements(
  state: Readonly<VocalCalibrationState>,
  sample: Readonly<VocalTelemetrySample>,
): ObservationResult {
  const current = state.measurements;
  const pitchReliable = reliablePitch(sample);
  const brightnessReliable = reliableBrightness(sample);
  if (state.stage === "neutral") {
    return {
      measurements: Object.freeze({
        ...current,
        neutralPitch: pitchReliable ? addMoment(current.neutralPitch, sample.midiFloat!) : current.neutralPitch,
        // Comfortable amplitude is diagnostic evidence only; it never admits either axis.
        neutralRms: pitchReliable ? addMoment(current.neutralRms, Math.max(0, sample.rms)) : current.neutralRms,
        neutralBrightness: brightnessReliable
          ? addMoment(current.neutralBrightness, sample.brightness!)
          : current.neutralBrightness,
      }),
      pitchQualified: pitchReliable,
      brightnessQualified: brightnessReliable,
    };
  }
  const center = centerValues(current);
  if (center === null) return { measurements: current, pitchQualified: false, brightnessQualified: false };
  const pitchCents = pitchReliable ? (sample.midiFloat! - center.midi) * 100 : null;
  const brightnessDelta = brightnessReliable && center.brightness !== null
    ? sample.brightness! - center.brightness
    : null;
  if (state.stage === "pitch-upper") {
    const qualified = pitchCents !== null && pitchCents >= 40;
    return {
      measurements: qualified
        ? Object.freeze({ ...current, upperPitchCents: addMoment(current.upperPitchCents, pitchCents) })
        : current,
      pitchQualified: qualified,
      brightnessQualified: false,
    };
  }
  if (state.stage === "pitch-lower") {
    const qualified = pitchCents !== null && pitchCents <= -40;
    return {
      measurements: qualified
        ? Object.freeze({ ...current, lowerPitchCents: addMoment(current.lowerPitchCents, -pitchCents) })
        : current,
      pitchQualified: qualified,
      brightnessQualified: false,
    };
  }
  if (state.stage === "brightness-dark") {
    const qualified = brightnessDelta !== null && brightnessDelta <= -0.005;
    return {
      measurements: qualified
        ? Object.freeze({
          ...current,
          darkerBrightnessDelta: addMoment(current.darkerBrightnessDelta, -brightnessDelta),
          darkTaskPitchDriftCents: pitchCents === null
            ? current.darkTaskPitchDriftCents
            : addMoment(current.darkTaskPitchDriftCents, Math.abs(pitchCents)),
        })
        : current,
      pitchQualified: false,
      brightnessQualified: qualified,
    };
  }
  if (state.stage === "brightness-bright") {
    const qualified = brightnessDelta !== null && brightnessDelta >= 0.005;
    return {
      measurements: qualified
        ? Object.freeze({
          ...current,
          brighterBrightnessDelta: addMoment(current.brighterBrightnessDelta, brightnessDelta),
          brightTaskPitchDriftCents: pitchCents === null
            ? current.brightTaskPitchDriftCents
            : addMoment(current.brightTaskPitchDriftCents, Math.abs(pitchCents)),
        })
        : current,
      pitchQualified: false,
      brightnessQualified: qualified,
    };
  }
  return {
    measurements: current,
    pitchQualified: state.stage === "center-recovery" && pitchReliable,
    brightnessQualified: false,
  };
}

function preliminaryDeadZones(measurements: Readonly<VocalCalibrationMeasurements>): {
  readonly pitch: number;
  readonly brightness: number;
} {
  return {
    pitch: Math.max(12, deviation(measurements.neutralPitch) * 200),
    brightness: Math.max(0.008, deviation(measurements.neutralBrightness) * 2),
  };
}

function measuredBrightnessAvailable(measures: Readonly<VocalCalibrationMeasurements>): boolean {
  return measures.neutralBrightness.count > 0
    && measures.darkerBrightnessDelta.mean >= MINIMUM_BRIGHTNESS_EXTENT
    && measures.brighterBrightnessDelta.mean >= MINIMUM_BRIGHTNESS_EXTENT;
}

function observeRecovery(
  state: Readonly<VocalCalibrationState>,
  sample: Readonly<VocalTelemetrySample>,
  deltaSeconds: number,
): Pick<VocalCalibrationState,
  "recoveryArmed" | "recoveryCount" | "recoverySecondsTotal" | "currentRecoverySeconds"
  | "recoveryCenterEngaged" | "recoveryCenteredSeconds"> {
  if (state.stage !== "center-recovery") return state;
  const center = centerValues(state.measurements);
  const brightnessRequired = state.brightnessCapability === "available"
    && center !== null
    && center.brightness !== null;
  if (!reliablePitch(sample) || (brightnessRequired && !reliableBrightness(sample))) {
    return {
      ...state,
      recoveryCenterEngaged: false,
      recoveryCenteredSeconds: 0,
    };
  }
  if (center === null) return state;
  const zones = preliminaryDeadZones(state.measurements);
  const pitchCents = Math.abs((sample.midiFloat! - center.midi) * 100);
  const brightnessDelta = brightnessRequired
    ? Math.abs(sample.brightness! - center.brightness!)
    : 0;
  const away = pitchCents >= Math.max(55, zones.pitch * 2)
    || (brightnessRequired && brightnessDelta >= Math.max(0.04, zones.brightness * 2));
  const centered = pitchCents <= zones.pitch
    && (!brightnessRequired || brightnessDelta <= zones.brightness);
  const insideHysteresis = pitchCents <= zones.pitch * CENTER_RECOVERY_HYSTERESIS_RATIO
    && (!brightnessRequired
      || brightnessDelta <= zones.brightness * CENTER_RECOVERY_HYSTERESIS_RATIO);
  if (!state.recoveryArmed && away) {
    return {
      ...state,
      recoveryArmed: true,
      currentRecoverySeconds: 0,
      recoveryCenterEngaged: false,
      recoveryCenteredSeconds: 0,
    };
  }
  if (!state.recoveryArmed) return state;
  const currentRecoverySeconds = state.currentRecoverySeconds + deltaSeconds;
  if (!state.recoveryCenterEngaged) {
    return centered
      ? { ...state, currentRecoverySeconds, recoveryCenterEngaged: true, recoveryCenteredSeconds: 0 }
      : { ...state, currentRecoverySeconds };
  }
  if (!insideHysteresis) {
    return {
      ...state,
      currentRecoverySeconds,
      recoveryCenterEngaged: false,
      recoveryCenteredSeconds: 0,
    };
  }
  const recoveryCenteredSeconds = state.recoveryCenteredSeconds + deltaSeconds;
  if (recoveryCenteredSeconds + 1e-9 < CENTER_RECOVERY_HOLD_SECONDS) {
    return { ...state, currentRecoverySeconds, recoveryCenteredSeconds };
  }
  return {
    ...state,
    recoveryArmed: false,
    recoveryCount: state.recoveryCount + 1,
    recoverySecondsTotal: state.recoverySecondsTotal + currentRecoverySeconds,
    currentRecoverySeconds: 0,
    recoveryCenterEngaged: false,
    recoveryCenteredSeconds: 0,
  };
}

function stageQualifiedSeconds(
  stage: VocalCalibrationStage,
  pitchSeconds: number,
  brightnessSeconds: number,
  brightnessCapability: BrightnessCapability,
): number {
  if (stage === "neutral") return brightnessCapability === "limited"
    ? pitchSeconds
    : Math.min(pitchSeconds, brightnessSeconds);
  if (stage === "pitch-upper" || stage === "pitch-lower" || stage === "center-recovery") {
    return pitchSeconds;
  }
  return brightnessSeconds;
}

function observe(
  state: Readonly<VocalCalibrationState>,
  sample: Readonly<VocalTelemetrySample>,
): VocalCalibrationState {
  if (state.stage === "complete") return state as VocalCalibrationState;
  const continuity = observationContinuity(state.lastAuthority, sample);
  const deltaSeconds = continuity.deltaSeconds;
  const lastAuthority = continuity.authority;
  // Authority boundaries seed only. They are never calibration evidence.
  if (!continuity.accepted || deltaSeconds <= 0) return Object.freeze({
    ...state,
    lastAuthority: continuity.accepted ? lastAuthority : state.lastAuthority,
    lastPitchQualified: false,
    lastBrightnessQualified: false,
    recoveryArmed: false, currentRecoverySeconds: 0, recoveryCenterEngaged: false,
    recoveryCenteredSeconds: 0,
    validationMessage: null,
  });
  const observed = observeMeasurements(state, sample);
  const stagePitchSeconds = state.stagePitchSeconds
    + (observed.pitchQualified && state.lastPitchQualified ? deltaSeconds : 0);
  const stageBrightnessSeconds = state.stageBrightnessSeconds
    + (observed.brightnessQualified && state.lastBrightnessQualified ? deltaSeconds : 0);
  const capability = state.brightnessCapability === "limited"
    ? "limited"
    : measuredBrightnessAvailable(observed.measurements) ? "available" : "unknown";
  const recovery = observeRecovery(
    { ...state, measurements: observed.measurements, brightnessCapability: capability },
    sample,
    deltaSeconds,
  );
  return Object.freeze({
    ...state,
    ...recovery,
    brightnessCapability: capability,
    measurements: observed.measurements,
    stagePitchSeconds,
    stageBrightnessSeconds,
    stageAttemptSeconds: state.stageAttemptSeconds + deltaSeconds,
    stageQualifiedSeconds: stageQualifiedSeconds(
      state.stage,
      stagePitchSeconds,
      stageBrightnessSeconds,
      capability,
    ),
    stageQualifiedSamples: state.stageQualifiedSamples
      + Number(observed.pitchQualified || observed.brightnessQualified),
    lastPitchQualified: observed.pitchQualified,
    lastBrightnessQualified: observed.brightnessQualified,
    lastAuthority,
    validationMessage: null,
  });
}

function readinessMessage(state: Readonly<VocalCalibrationState>): string | null {
  if (state.stage === "complete") return null;
  if (state.stageQualifiedSeconds < MINIMUM_STAGE_SECONDS) {
    const brightnessStage = state.stage === "brightness-dark"
      || state.stage === "brightness-bright";
    return brightnessStage
      && state.stageAttemptSeconds + 1e-9 >= MINIMUM_BRIGHTNESS_FALLBACK_SECONDS
      ? "Brightness control is still unresolved. Retry this step or continue with pitch-only control."
      : "Keep exploring the requested region with continuous live evidence.";
  }
  const measures = state.measurements;
  if (state.stage === "neutral" && deviation(measures.neutralPitch) * 100 > 45) {
    return "Let the neutral pitch settle before continuing.";
  }
  if (state.stage === "neutral"
    && state.brightnessCapability !== "limited"
    && deviation(measures.neutralBrightness) > MAXIMUM_NEUTRAL_BRIGHTNESS_DEVIATION) {
    return "Let the neutral brightness settle before continuing.";
  }
  if (state.stage === "pitch-upper" && measures.upperPitchCents.mean < MINIMUM_PITCH_EXTENT_CENTS) {
    return "Sustain a comfortable position a little farther above center.";
  }
  if (state.stage === "pitch-lower" && measures.lowerPitchCents.mean < MINIMUM_PITCH_EXTENT_CENTS) {
    return "Sustain a comfortable position a little farther below center.";
  }
  if (state.stage === "brightness-dark" && measures.darkerBrightnessDelta.mean < MINIMUM_BRIGHTNESS_EXTENT) {
    return "Explore a more distinct darker position before continuing.";
  }
  if (state.stage === "brightness-bright" && measures.brighterBrightnessDelta.mean < MINIMUM_BRIGHTNESS_EXTENT) {
    return "Explore a more distinct brighter position before continuing.";
  }
  if (state.stage === "center-recovery" && state.recoveryCount < MINIMUM_RECOVERIES) {
    return `Return vocally to center ${MINIMUM_RECOVERIES - state.recoveryCount} more time(s).`;
  }
  return null;
}

function createResult(state: Readonly<VocalCalibrationState>): VocalControlCalibration {
  const measures = state.measurements;
  const center = centerValues(measures)!;
  const pitchLowerCents = measures.lowerPitchCents.mean;
  const pitchUpperCents = measures.upperPitchCents.mean;
  const brightnessAvailable = state.brightnessCapability === "available"
    && center.brightness !== null;
  const brightnessDarkerDelta = brightnessAvailable ? measures.darkerBrightnessDelta.mean : 0;
  const brightnessBrighterDelta = brightnessAvailable ? measures.brighterBrightnessDelta.mean : 0;
  const darkHasDrift = measures.darkTaskPitchDriftCents.count > 0;
  const brightHasDrift = measures.brightTaskPitchDriftCents.count > 0;
  const brightnessTaskPitchDriftCents = darkHasDrift && brightHasDrift
    ? (measures.darkTaskPitchDriftCents.mean + measures.brightTaskPitchDriftCents.mean) / 2
    : null;
  const rawPitchDeadZone = Math.max(12, deviation(measures.neutralPitch) * 200);
  const rawBrightnessDeadZone = Math.max(0.008, deviation(measures.neutralBrightness) * 2);
  return Object.freeze({
    centerFrequencyHz: center.frequencyHz,
    centerMidi: center.midi,
    centerBrightness: center.brightness ?? 0.5,
    centerRms: measures.neutralRms.mean,
    pitchLowerCents,
    pitchUpperCents,
    brightnessDarkerDelta,
    brightnessBrighterDelta,
    neutralPitchDeviationCents: deviation(measures.neutralPitch) * 100,
    neutralBrightnessDeviation: deviation(measures.neutralBrightness),
    pitchDeadZoneCents: Math.min(rawPitchDeadZone, Math.min(pitchLowerCents, pitchUpperCents) * 0.35),
    brightnessDeadZone: brightnessAvailable
      ? Math.min(rawBrightnessDeadZone, Math.min(brightnessDarkerDelta, brightnessBrighterDelta) * 0.35)
      : 0,
    brightnessTaskPitchDriftCents,
    brightnessAvailable,
    brightnessIndependent: brightnessAvailable
      && brightnessTaskPitchDriftCents !== null
      && brightnessTaskPitchDriftCents <= 100,
    completedRecoveryCount: state.recoveryCount,
  });
}

function moveStage(state: Readonly<VocalCalibrationState>, direction: 1 | -1): VocalCalibrationState {
  if (direction === 1) {
    const message = readinessMessage(state);
    if (message !== null) return Object.freeze({ ...state, validationMessage: message });
  }
  const currentIndex = STAGES.indexOf(state.stage);
  const ordinaryStage = STAGES[clamp(currentIndex + direction, 0, STAGES.length - 1)]!;
  const stage = direction === 1
    && state.brightnessCapability === "limited"
    && state.stage === "pitch-lower"
    ? "center-recovery"
    : ordinaryStage;
  const brightnessCapability = direction === -1
    && state.stage === "center-recovery"
    && stage === "brightness-bright"
    ? "unknown"
    : stage === "center-recovery" && state.brightnessCapability === "unknown"
      ? measuredBrightnessAvailable(state.measurements) ? "available" : "limited"
      : state.brightnessCapability;
  return Object.freeze({
    ...state,
    stage,
    brightnessCapability,
    ...RESET_STAGE_PROGRESS,
    result: stage === "complete" ? createResult({ ...state, brightnessCapability }) : null,
  });
}

function measurementsWithoutCurrentStage(
  stage: VocalCalibrationStage,
  measurements: Readonly<VocalCalibrationMeasurements>,
): VocalCalibrationMeasurements {
  if (stage === "neutral") return Object.freeze({
    ...measurements,
    neutralPitch: emptyMoment(),
    neutralBrightness: emptyMoment(),
    neutralRms: emptyMoment(),
  });
  if (stage === "pitch-upper") {
    return Object.freeze({ ...measurements, upperPitchCents: emptyMoment() });
  }
  if (stage === "pitch-lower") {
    return Object.freeze({ ...measurements, lowerPitchCents: emptyMoment() });
  }
  if (stage === "brightness-dark") return Object.freeze({
    ...measurements,
    darkerBrightnessDelta: emptyMoment(),
    darkTaskPitchDriftCents: emptyMoment(),
  });
  if (stage === "brightness-bright") return Object.freeze({
    ...measurements,
    brighterBrightnessDelta: emptyMoment(),
    brightTaskPitchDriftCents: emptyMoment(),
  });
  return measurements as VocalCalibrationMeasurements;
}

function resetStage(state: Readonly<VocalCalibrationState>): VocalCalibrationState {
  if (state.stage === "complete") return state as VocalCalibrationState;
  const measurements = measurementsWithoutCurrentStage(state.stage, state.measurements);
  const centerRecovery = state.stage === "center-recovery";
  return Object.freeze({
    ...state,
    measurements,
    brightnessCapability: state.brightnessCapability === "limited"
      ? "limited"
      : measuredBrightnessAvailable(measurements) ? "available" : "unknown",
    ...RESET_STAGE_PROGRESS,
    recoveryCount: centerRecovery ? 0 : state.recoveryCount,
    recoverySecondsTotal: centerRecovery ? 0 : state.recoverySecondsTotal,
    result: null,
  });
}

export function reduceVocalCalibration(
  state: Readonly<VocalCalibrationState>,
  action: Readonly<VocalCalibrationAction>,
): VocalCalibrationState {
  if (action.type === "reset") return createVocalCalibrationState();
  if (action.type === "reset-stage") return resetStage(state);
  if (action.type === "observe") return observe(state, action.sample);
  if (action.type === "skip-brightness") {
    if (state.stage !== "brightness-dark" && state.stage !== "brightness-bright") {
      return state as VocalCalibrationState;
    }
    if (state.stageAttemptSeconds + 1e-9 < MINIMUM_BRIGHTNESS_FALLBACK_SECONDS
      || readinessMessage(state) === null) return state as VocalCalibrationState;
    return Object.freeze({
      ...state,
      stage: "center-recovery",
      brightnessCapability: "limited",
      ...RESET_STAGE_PROGRESS,
    });
  }
  if (action.type === "next") return moveStage(state, 1);
  if (action.type === "back") return moveStage(state, -1);
  return state as VocalCalibrationState;
}

export function vocalCalibrationReadiness(
  state: Readonly<VocalCalibrationState>,
): Readonly<{ ready: boolean; message: string | null }> {
  const message = readinessMessage(state);
  return Object.freeze({ ready: message === null, message });
}
