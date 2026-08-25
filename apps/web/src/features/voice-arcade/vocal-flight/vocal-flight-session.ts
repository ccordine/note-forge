import type { ArcadeDifficultyId } from "../types";
import {
  createVocalCalibrationState,
  reduceVocalCalibration,
  type VocalCalibrationAction,
  type VocalCalibrationState,
} from "./calibration";
import {
  advanceVocalFlightCourse,
  createVocalFlightCourseState,
  disturbanceAtPosition,
  getVocalFlightCourse,
  vocalFlightDesiredPoint,
  VOCAL_FLIGHT_TUTORIALS,
} from "./courses";
import {
  advanceVocalFlight,
  createVocalFlightState,
} from "./flight-runtime";
import {
  advanceVocalFlightScore,
  createVocalFlightScoreState,
  summarizeVocalFlightScore,
  type VocalFlightScoreState,
} from "./scoring";
import {
  createVocalControlState,
  updateVocalControl,
  type VocalControlState,
} from "./vocal-control";
import {
  getVocalFlightMode,
  type VocalFlightGameMode,
} from "./vocal-flight-modes";
import type {
  VocalControlCalibration,
  VocalControlVector,
  VocalFlightControlMode,
  VocalFlightCourseDefinition,
  VocalFlightCourseState,
  VocalFlightScoreResult,
  VocalFlightState,
  VocalTelemetrySample,
} from "./types";

export type VocalFlightPhase = "calibration" | "flying" | "complete";

export interface VocalFlightTelemetryView {
  readonly observationKind: VocalTelemetrySample["observationKind"];
  readonly frequencyHz: number | null;
  readonly midiFloat: number | null;
  readonly brightness: number | null;
  readonly confidence: number;
  readonly brightnessConfidence: number;
  readonly rms: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly sampleRate: number;
  readonly processedSampleCount: number;
  readonly workletProcessCount: number | null;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly discontinuity: boolean;
}

export interface VocalFlightSessionState {
  readonly phase: VocalFlightPhase;
  readonly difficulty: ArcadeDifficultyId;
  readonly calibration: VocalCalibrationState;
  readonly calibrationRecording: boolean;
  readonly mode: VocalFlightGameMode;
  readonly selectedCourseId: string;
  /** Highest tutorial order currently selectable in this calibrated session. */
  readonly unlockedTutorialOrder: number;
  readonly control: VocalControlState | null;
  readonly vector: VocalControlVector;
  readonly telemetry: VocalFlightTelemetryView | null;
  readonly flight: VocalFlightState;
  readonly course: VocalFlightCourseState | null;
  readonly scoring: VocalFlightScoreState;
  /** Exact score snapshot at the authored course milestone; never terminal. */
  readonly achievementResult: VocalFlightScoreResult | null;
  /** Whole-session score, created only by the user's explicit Finish action. */
  readonly result: VocalFlightScoreResult | null;
  readonly runId: number;
  readonly completedRunId: number | null;
  readonly observedFrameCount: number;
  readonly simulatedFrameCount: number;
}

export type VocalFlightSessionAction =
  | Readonly<{ type: "observation"; sample: VocalTelemetrySample }>
  | Readonly<{ type: "record-calibration" }>
  | Readonly<{ type: "calibration-next" }>
  | Readonly<{ type: "calibration-back" }>
  | Readonly<{ type: "calibration-reset-stage" }>
  | Readonly<{ type: "skip-brightness" }>
  | Readonly<{ type: "select-mode"; mode: VocalFlightGameMode }>
  | Readonly<{ type: "select-course"; courseId: string }>
  | Readonly<{ type: "launch" }>
  | Readonly<{ type: "finish" }>
  | Readonly<{ type: "return-loadout" }>
  | Readonly<{ type: "recalibrate" }>;

const EMPTY_VECTOR: VocalControlVector = Object.freeze({
  pitchAxis: 0,
  brightnessAxis: 0,
  pitchConfidence: 0,
  brightnessConfidence: 0,
  voiced: false,
  active: false,
});

function telemetryView(sample: Readonly<VocalTelemetrySample>): VocalFlightTelemetryView {
  const extended = sample as VocalTelemetrySample & {
    readonly processedSampleCount?: number;
    readonly workletProcessCount?: number;
  };
  return Object.freeze({
    observationKind: sample.observationKind,
    frequencyHz: sample.frequencyHz,
    midiFloat: sample.midiFloat,
    brightness: sample.brightness,
    confidence: sample.confidence,
    brightnessConfidence: sample.brightnessConfidence,
    rms: sample.rms,
    startSample: sample.startSample,
    endSample: sample.endSample,
    sampleRate: sample.sampleRate,
    processedSampleCount: extended.processedSampleCount ?? sample.endSample,
    workletProcessCount: extended.workletProcessCount ?? null,
    captureEpoch: sample.captureEpoch,
    continuityEpoch: sample.continuityEpoch,
    graphGeneration: sample.graphGeneration,
    discontinuity: sample.discontinuity,
  });
}

function finiteExtent(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function calibrationVector(
  calibration: Readonly<VocalCalibrationState>,
  sample: Readonly<VocalTelemetrySample>,
): VocalControlVector {
  const voiced = sample.observationKind === "voiced"
    && sample.midiFloat !== null
    && Number.isFinite(sample.midiFloat)
    && sample.confidence >= .55;
  if (!voiced || calibration.measurements.neutralPitch.count === 0) return EMPTY_VECTOR;
  const pitchDelta = (sample.midiFloat! - calibration.measurements.neutralPitch.mean) * 100;
  const upper = finiteExtent(calibration.measurements.upperPitchCents.maximum, 180);
  const lower = finiteExtent(calibration.measurements.lowerPitchCents.maximum, 180);
  const pitchAxis = Math.min(1, Math.max(-1, pitchDelta / (pitchDelta < 0 ? lower : upper)));
  const brightnessReliable = sample.brightness !== null
    && Number.isFinite(sample.brightness)
    && sample.brightnessConfidence >= .55
    && calibration.measurements.neutralBrightness.count > 0;
  const brightnessDelta = brightnessReliable
    ? sample.brightness! - calibration.measurements.neutralBrightness.mean
    : 0;
  const brighter = finiteExtent(calibration.measurements.brighterBrightnessDelta.maximum, .08);
  const darker = finiteExtent(calibration.measurements.darkerBrightnessDelta.maximum, .08);
  return Object.freeze({
    pitchAxis,
    brightnessAxis: brightnessReliable
      ? Math.min(1, Math.max(-1, brightnessDelta / (brightnessDelta < 0 ? darker : brighter)))
      : 0,
    pitchConfidence: sample.confidence,
    brightnessConfidence: sample.brightnessConfidence,
    voiced: true,
    active: true,
  });
}

function flightConfig(difficulty: ArcadeDifficultyId) {
  if (difficulty === "easy") {
    return { pitchTorque: 2.35, rollTorque: 3.45, pitchSelfLevel: 2.55, rollSelfLevel: 3.2 };
  }
  if (difficulty === "hard") {
    return { pitchTorque: 3.2, rollTorque: 4.9, pitchSelfLevel: 1.9, rollSelfLevel: 2.4 };
  }
  return {};
}

function controlResponse(difficulty: ArcadeDifficultyId): number {
  if (difficulty === "easy") return 15;
  if (difficulty === "hard") return 23;
  return 19;
}

export function createVocalFlightSession(
  difficulty: ArcadeDifficultyId,
  completedVariants: readonly string[] = [],
): VocalFlightSessionState {
  const completed = new Set(completedVariants);
  let unlockedTutorialOrder = 1;
  for (const tutorial of VOCAL_FLIGHT_TUTORIALS) {
    if (!completed.has(tutorial.id)) break;
    unlockedTutorialOrder = tutorial.order + 1;
  }
  const selectedTutorial = VOCAL_FLIGHT_TUTORIALS.find(
    (tutorial) => tutorial.order === Math.min(unlockedTutorialOrder, VOCAL_FLIGHT_TUTORIALS.length),
  ) ?? VOCAL_FLIGHT_TUTORIALS[0]!;
  return Object.freeze({
    phase: "calibration",
    difficulty,
    calibration: createVocalCalibrationState(),
    calibrationRecording: false,
    mode: "training",
    selectedCourseId: selectedTutorial.id,
    unlockedTutorialOrder,
    control: null,
    vector: EMPTY_VECTOR,
    telemetry: null,
    flight: createVocalFlightState({ config: flightConfig(difficulty) }),
    course: null,
    scoring: createVocalFlightScoreState(),
    achievementResult: null,
    result: null,
    runId: 0,
    completedRunId: null,
    observedFrameCount: 0,
    simulatedFrameCount: 0,
  });
}

function calibrationAction(
  state: Readonly<VocalFlightSessionState>,
  action: Readonly<VocalCalibrationAction>,
): VocalFlightSessionState {
  const calibration = reduceVocalCalibration(state.calibration, action);
  return Object.freeze({
    ...state,
    calibration,
    calibrationRecording: false,
  });
}

function selectedCourse(state: Readonly<VocalFlightSessionState>): VocalFlightCourseDefinition | null {
  if (state.mode === "training") return getVocalFlightCourse(state.selectedCourseId);
  return getVocalFlightMode(state.mode).course;
}

export function courseRequiresBrightness(
  definition: Readonly<VocalFlightCourseDefinition> | null,
): boolean {
  return definition?.controlMode === "brightness" || definition?.controlMode === "combined";
}

export function canLaunchVocalFlight(state: Readonly<VocalFlightSessionState>): boolean {
  const calibration = state.calibration.result;
  if (calibration === null) return false;
  return calibration.brightnessAvailable || !courseRequiresBrightness(selectedCourse(state));
}

export function canSelectVocalFlightMode(
  state: Readonly<VocalFlightSessionState>,
  mode: VocalFlightGameMode,
): boolean {
  if (mode === "training") return true;
  if (mode === "pitch-tunnel") return state.unlockedTutorialOrder > 6;
  return state.unlockedTutorialOrder > VOCAL_FLIGHT_TUTORIALS.length;
}

function effectiveControlMode(
  definition: Readonly<VocalFlightCourseDefinition> | null,
  calibration: Readonly<VocalControlCalibration>,
): VocalFlightControlMode {
  if (definition !== null) return definition.controlMode;
  return calibration.brightnessAvailable ? "combined" : "pitch";
}

function launch(state: Readonly<VocalFlightSessionState>): VocalFlightSessionState {
  const calibration = state.calibration.result;
  if (calibration === null || !canLaunchVocalFlight(state)) return state as VocalFlightSessionState;
  const definition = selectedCourse(state);
  return Object.freeze({
    ...state,
    phase: "flying",
    calibrationRecording: false,
    control: createVocalControlState(calibration, {
      responsePerSecond: controlResponse(state.difficulty),
    }),
    vector: EMPTY_VECTOR,
    flight: createVocalFlightState({ config: flightConfig(state.difficulty) }),
    course: definition === null ? null : createVocalFlightCourseState(definition),
    scoring: createVocalFlightScoreState(definition?.parSeconds ?? null),
    achievementResult: null,
    result: null,
    runId: state.runId + 1,
    completedRunId: null,
    simulatedFrameCount: 0,
  });
}

export function desiredVocalFlightControl(
  flight: Readonly<VocalFlightState>,
  course: Readonly<VocalFlightCourseState> | null,
): Readonly<{
  pitchAxis: number;
  brightnessAxis: number;
  pathError: number;
  tolerance: number;
}> {
  const gate = course?.definition.gates[course.nextGateIndex];
  if (!gate) {
    // Once the authored gates are crossed, continue the final flight lane until
    // the user presses Finish. Returning to the world origin here would invent
    // a different target and corrupt every post-achievement scoring interval.
    const continuation = course?.lastPassedCenter;
    const targetX = continuation?.x ?? 0;
    const targetY = continuation?.y ?? 0;
    const xError = targetX - flight.position.x;
    const yError = targetY - flight.position.y;
    const finalGate = course?.definition.gates[course.definition.gates.length - 1];
    return {
      pitchAxis: Math.min(1, Math.max(-1, yError / 8)),
      brightnessAxis: Math.min(1, Math.max(-1, xError / 8)),
      pathError: Math.hypot(xError, yError),
      tolerance: finalGate?.radius ?? 8,
    };
  }
  const desired = vocalFlightDesiredPoint(course!, flight.position);
  const xError = desired.x - flight.position.x;
  const yError = desired.y - flight.position.y;
  return {
    pitchAxis: Math.min(1, Math.max(-1, yError / 8)),
    brightnessAxis: Math.min(1, Math.max(-1, xError / 8)),
    pathError: Math.hypot(xError, yError),
    tolerance: gate.radius,
  };
}

function finish(
  state: Readonly<VocalFlightSessionState>,
  scoring = state.scoring,
): VocalFlightSessionState {
  if (state.phase !== "flying") return state as VocalFlightSessionState;
  return Object.freeze({
    ...state,
    phase: "complete",
    scoring,
    result: summarizeVocalFlightScore(scoring),
    completedRunId: state.runId,
  });
}

function observeCalibration(
  state: Readonly<VocalFlightSessionState>,
  sample: Readonly<VocalTelemetrySample>,
): VocalFlightSessionState {
  const base = {
    ...state,
    vector: calibrationVector(state.calibration, sample),
    telemetry: telemetryView(sample),
    observedFrameCount: state.observedFrameCount + 1,
  };
  if (!state.calibrationRecording || state.calibration.stage === "complete") {
    return Object.freeze(base);
  }
  return Object.freeze({
    ...base,
    calibration: reduceVocalCalibration(state.calibration, { type: "observe", sample }),
  });
}

function observeFlight(
  state: Readonly<VocalFlightSessionState>,
  sample: Readonly<VocalTelemetrySample>,
): VocalFlightSessionState {
  if (state.control === null || state.calibration.result === null) return state as VocalFlightSessionState;
  const update = updateVocalControl(state.control, sample);
  const sampleDelta = update.deltaSeconds;
  const definition = state.course?.definition ?? null;
  const mode = effectiveControlMode(definition, state.calibration.result);
  const disturbance = definition === null
    ? { pitchTorque: 0, rollTorque: 0 }
    : disturbanceAtPosition(definition, state.flight.position.z);
  const nextFlight = advanceVocalFlight(state.flight, {
    control: update.vector,
    controlMode: mode,
    selfLevelStrength: definition?.selfLevelStrength ?? .45,
    disturbancePitchTorque: disturbance.pitchTorque,
    disturbanceRollTorque: disturbance.rollTorque,
  }, sampleDelta);
  // This sample interval was flown toward the gate that was active at its
  // start. Score that demand before the course reducer advances to the next
  // gate (or removes the final gate after an achievement).
  const demand = desiredVocalFlightControl(nextFlight, state.course);
  const nextCourse = state.course === null
    ? null
    : advanceVocalFlightCourse(state.course, state.flight, nextFlight, update.vector, sampleDelta);
  const scoring = advanceVocalFlightScore(state.scoring, {
    deltaSeconds: sampleDelta,
    control: update.vector,
    controlMode: mode,
    pathError: demand.pathError,
    pathTolerance: demand.tolerance,
    desiredPitchAxis: demand.pitchAxis,
    desiredBrightnessAxis: demand.brightnessAxis,
    pitchDeltaCents: update.pitchDeltaCents,
  });
  const courseCompletedNow = state.achievementResult === null && nextCourse?.status === "complete";
  const achievementResult = courseCompletedNow
    ? summarizeVocalFlightScore(scoring)
    : state.achievementResult;
  const next = Object.freeze({
    ...state,
    control: update.state,
    vector: update.vector,
    telemetry: telemetryView(sample),
    flight: nextFlight,
    course: nextCourse,
    scoring,
    achievementResult,
    observedFrameCount: state.observedFrameCount + 1,
    simulatedFrameCount: state.simulatedFrameCount + Number(sampleDelta > 0),
  });
  // Course completion is an achievement, never authority to end the user's
  // live flight. Keep simulating and consuming telemetry until Finish.
  return next;
}

function selectMode(
  state: Readonly<VocalFlightSessionState>,
  mode: VocalFlightGameMode,
): VocalFlightSessionState {
  if (!canSelectVocalFlightMode(state, mode)) return state as VocalFlightSessionState;
  return Object.freeze({
    ...state,
    mode,
    achievementResult: null,
    result: null,
    completedRunId: null,
  });
}

function nextTutorialCourseId(state: Readonly<VocalFlightSessionState>): string {
  if (state.mode !== "training" || state.course?.status !== "complete") {
    return state.selectedCourseId;
  }
  const currentIndex = VOCAL_FLIGHT_TUTORIALS.findIndex((course) => (
    course.id === state.selectedCourseId
  ));
  return VOCAL_FLIGHT_TUTORIALS[Math.min(
    VOCAL_FLIGHT_TUTORIALS.length - 1,
    currentIndex + 1,
  )]!.id;
}

function nextUnlockedTutorialOrder(state: Readonly<VocalFlightSessionState>): number {
  if (state.mode !== "training" || state.course?.status !== "complete") {
    return state.unlockedTutorialOrder;
  }
  return Math.min(
    VOCAL_FLIGHT_TUTORIALS.length + 1,
    Math.max(state.unlockedTutorialOrder, state.course.definition.order + 1),
  );
}

export function reduceVocalFlightSession(
  state: Readonly<VocalFlightSessionState>,
  action: Readonly<VocalFlightSessionAction>,
): VocalFlightSessionState {
  if (action.type === "observation") {
    if (state.phase === "calibration") return observeCalibration(state, action.sample);
    if (state.phase === "flying") return observeFlight(state, action.sample);
    return Object.freeze({
      ...state,
      telemetry: telemetryView(action.sample),
      observedFrameCount: state.observedFrameCount + 1,
    });
  }
  if (action.type === "record-calibration") {
    return Object.freeze({ ...state, calibrationRecording: true });
  }
  if (action.type === "calibration-next") {
    return calibrationAction(state, { type: "next" });
  }
  if (action.type === "calibration-back") {
    return calibrationAction(state, { type: "back" });
  }
  if (action.type === "calibration-reset-stage") {
    return calibrationAction(state, { type: "reset-stage" });
  }
  if (action.type === "skip-brightness") {
    return calibrationAction(state, { type: "skip-brightness" });
  }
  if (action.type === "select-mode") return selectMode(state, action.mode);
  if (action.type === "select-course") {
    const requested = getVocalFlightCourse(action.courseId);
    if (requested.order > state.unlockedTutorialOrder) return state as VocalFlightSessionState;
    return Object.freeze({ ...state, selectedCourseId: action.courseId });
  }
  if (action.type === "launch") return launch(state);
  if (action.type === "finish") return finish(state);
  if (action.type === "return-loadout") {
    return Object.freeze({
      ...state,
      phase: "calibration",
      selectedCourseId: nextTutorialCourseId(state),
      unlockedTutorialOrder: nextUnlockedTutorialOrder(state),
      achievementResult: null,
      result: null,
      completedRunId: null,
    });
  }
  if (action.type === "recalibrate") {
    return Object.freeze({
      ...createVocalFlightSession(state.difficulty),
      selectedCourseId: state.selectedCourseId,
      unlockedTutorialOrder: state.unlockedTutorialOrder,
    });
  }
  return state as VocalFlightSessionState;
}
