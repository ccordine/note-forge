import type { YinPitchFrame } from "@noteforge/pitch-engine";
import {
  createSustainTracker,
  updateSustainTracker,
  type SustainTrackerState,
} from "../range-loop/model";
import {
  CARDINAL_DIRECTIONS,
  type CardinalDirection,
  type PitchMazeDirectionNotes,
} from "./pitch-maze-model";

export type PitchMazeControllerPhase = "armed" | "tracking" | "awaiting-release";

/** The controller intentionally consumes the interpreted frame, not raw detector evidence. */
export type PitchMazeVoiceFrame = Pick<
  YinPitchFrame,
  "timeSeconds" | "midiFloat" | "confidence" | "voiced" | "detector" | "reason"
>;

export interface PitchMazeControllerOptions {
  readonly directionNotes: PitchMazeDirectionNotes;
  readonly requiredHoldSeconds: number;
  readonly toleranceCents: number;
  readonly listeningStartedAtSeconds?: number;
  readonly minimumConfidence?: number;
  /** A pitch farther than this from every mapped note cannot become an intent. */
  readonly acquisitionCorridorCents?: number;
  /** A new direction must be this much closer before it can replace the current lock. */
  readonly directionSwitchHysteresisCents?: number;
  /** Continuous silence required after a command before another command is accepted. */
  readonly releaseDurationSeconds?: number;
  /** Tighter lane used to measure settling quality; it does not gate movement. */
  readonly settleToleranceCents?: number;
  /** Ignore tiny sign changes inside this lane when counting overshoots. */
  readonly overshootDeadbandCents?: number;
}

export interface ResolvedPitchMazeControllerOptions {
  readonly directionNotes: PitchMazeDirectionNotes;
  readonly requiredHoldSeconds: number;
  readonly toleranceCents: number;
  readonly listeningStartedAtSeconds: number;
  readonly minimumConfidence: number;
  readonly acquisitionCorridorCents: number;
  readonly directionSwitchHysteresisCents: number;
  readonly releaseDurationSeconds: number;
  readonly settleToleranceCents: number;
  readonly overshootDeadbandCents: number;
}

export interface PitchMazeDirectionSelection {
  readonly direction: CardinalDirection;
  readonly targetMidi: number;
  readonly errorCents: number;
  readonly absoluteErrorCents: number;
}

export interface PitchMazeCommandCapture {
  readonly direction: CardinalDirection;
  readonly targetMidi: number;
  readonly startedAtSeconds: number;
  readonly attackErrorCents: number;
  readonly settledAtSeconds: number | null;
  readonly sampleCount: number;
  readonly inBandSampleCount: number;
  readonly absoluteErrorTotalCents: number;
  readonly signedErrorTotalCents: number;
  readonly squaredErrorTotalCents: number;
  readonly overshootCount: number;
  readonly lastErrorSide: -1 | 0 | 1;
}

export interface PitchMazeCommandQuality {
  readonly direction: CardinalDirection;
  readonly targetMidi: number;
  readonly startedAtSeconds: number;
  readonly endedAtSeconds: number;
  readonly durationSeconds: number;
  /** Signed cents: negative is flat and positive is sharp. */
  readonly attackErrorCents: number;
  readonly settleTimeSeconds: number | null;
  readonly overshootCount: number;
  readonly sampleCount: number;
  readonly inBandSampleCount: number;
  readonly inBandRatio: number;
  readonly meanAbsoluteErrorCents: number;
  readonly meanSignedErrorCents: number;
  /** Standard deviation of signed cents error across reliable command samples. */
  readonly spreadCents: number;
  readonly qualityScore: number;
}

export interface PitchMazeControllerState {
  readonly options: ResolvedPitchMazeControllerOptions;
  readonly phase: PitchMazeControllerPhase;
  readonly activeDirection: CardinalDirection | null;
  readonly activeTargetMidi: number | null;
  readonly sustain: SustainTrackerState | null;
  readonly capture: PitchMazeCommandCapture | null;
  readonly releaseStartedAtSeconds: number | null;
  readonly releaseProgress: number;
  readonly lastProcessedTimeSeconds: number | null;
  readonly completedCommandCount: number;
  readonly lastCommand: PitchMazeCommandQuality | null;
}

export type PitchMazeControllerEvent =
  | { readonly type: "command-complete"; readonly command: PitchMazeCommandQuality }
  | { readonly type: "rearmed" };

export interface PitchMazeControllerUpdate {
  readonly state: PitchMazeControllerState;
  readonly event: PitchMazeControllerEvent | null;
}

export const DEFAULT_PITCH_MAZE_MINIMUM_CONFIDENCE = 0.58;
export const DEFAULT_PITCH_MAZE_ACQUISITION_CORRIDOR_CENTS = 48;
export const DEFAULT_PITCH_MAZE_DIRECTION_HYSTERESIS_CENTS = 8;
export const DEFAULT_PITCH_MAZE_RELEASE_SECONDS = 0.275;

const EPSILON = 1e-9;
const RELEASE_REASONS = new Set<YinPitchFrame["reason"]>([
  "below-rms-threshold",
  "insufficient-samples",
  "invalid-samples",
  "no-periodic-candidate",
]);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero.`);
}

function requireNonNegative(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0) throw new RangeError(`${label} cannot be negative.`);
}

function resolvedOptions(
  options: Readonly<PitchMazeControllerOptions>,
): ResolvedPitchMazeControllerOptions {
  if (!options || typeof options !== "object") {
    throw new TypeError("Pitch Maze controller options are required.");
  }

  requirePositive(options.requiredHoldSeconds, "Required hold duration");
  requirePositive(options.toleranceCents, "Pitch tolerance");
  const listeningStartedAtSeconds = options.listeningStartedAtSeconds ?? 0;
  const minimumConfidence = options.minimumConfidence ?? DEFAULT_PITCH_MAZE_MINIMUM_CONFIDENCE;
  const acquisitionCorridorCents = options.acquisitionCorridorCents
    ?? DEFAULT_PITCH_MAZE_ACQUISITION_CORRIDOR_CENTS;
  const directionSwitchHysteresisCents = options.directionSwitchHysteresisCents
    ?? DEFAULT_PITCH_MAZE_DIRECTION_HYSTERESIS_CENTS;
  const releaseDurationSeconds = options.releaseDurationSeconds
    ?? DEFAULT_PITCH_MAZE_RELEASE_SECONDS;
  const settleToleranceCents = options.settleToleranceCents
    ?? Math.min(options.toleranceCents, 18);
  const overshootDeadbandCents = options.overshootDeadbandCents
    ?? Math.min(6, options.toleranceCents / 3);

  requireNonNegative(listeningStartedAtSeconds, "Listening start timestamp");
  requireFinite(minimumConfidence, "Minimum confidence");
  if (minimumConfidence < 0 || minimumConfidence > 1) {
    throw new RangeError("Minimum confidence must be from zero through one.");
  }
  requirePositive(acquisitionCorridorCents, "Acquisition corridor");
  requireNonNegative(directionSwitchHysteresisCents, "Direction-switch hysteresis");
  requirePositive(releaseDurationSeconds, "Release duration");
  requirePositive(settleToleranceCents, "Settle tolerance");
  requireNonNegative(overshootDeadbandCents, "Overshoot deadband");

  const uniqueNotes = new Set<number>();
  const directionNotes = Object.fromEntries(CARDINAL_DIRECTIONS.map((direction) => {
    const midi = options.directionNotes?.[direction];
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      throw new RangeError(`${direction} must map to an integer MIDI note from zero through 127.`);
    }
    uniqueNotes.add(midi);
    return [direction, midi];
  })) as unknown as PitchMazeDirectionNotes;
  if (uniqueNotes.size !== CARDINAL_DIRECTIONS.length) {
    throw new RangeError("Every Pitch Maze direction must use a distinct note.");
  }

  return Object.freeze({
    directionNotes: Object.freeze(directionNotes),
    requiredHoldSeconds: options.requiredHoldSeconds,
    toleranceCents: options.toleranceCents,
    listeningStartedAtSeconds,
    minimumConfidence,
    acquisitionCorridorCents,
    directionSwitchHysteresisCents,
    releaseDurationSeconds,
    settleToleranceCents,
    overshootDeadbandCents,
  });
}

export function createPitchMazeController(
  options: Readonly<PitchMazeControllerOptions>,
): PitchMazeControllerState {
  return {
    options: resolvedOptions(options),
    phase: "armed",
    activeDirection: null,
    activeTargetMidi: null,
    sustain: null,
    capture: null,
    releaseStartedAtSeconds: null,
    releaseProgress: 0,
    lastProcessedTimeSeconds: null,
    completedCommandCount: 0,
    lastCommand: null,
  };
}

export function isReliablePitchMazeFrame(
  frame: Readonly<PitchMazeVoiceFrame>,
  minimumConfidence: number = DEFAULT_PITCH_MAZE_MINIMUM_CONFIDENCE,
): boolean {
  return frame.detector === "yin"
    && frame.reason === "detected"
    && frame.voiced
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat)
    && Number.isFinite(frame.confidence)
    && frame.confidence >= minimumConfidence;
}

/**
 * Find one unambiguous mapped note. Ties are deliberately rejected so a pitch
 * on the exact boundary between adjacent semitones cannot pick a direction.
 */
export function selectPitchMazeDirection(
  directionNotes: PitchMazeDirectionNotes,
  midiFloat: number,
  acquisitionCorridorCents: number = DEFAULT_PITCH_MAZE_ACQUISITION_CORRIDOR_CENTS,
): PitchMazeDirectionSelection | null {
  if (!Number.isFinite(midiFloat)) return null;
  requirePositive(acquisitionCorridorCents, "Acquisition corridor");
  const candidates = CARDINAL_DIRECTIONS.map((direction): PitchMazeDirectionSelection => {
    const targetMidi = directionNotes[direction];
    const errorCents = (midiFloat - targetMidi) * 100;
    return { direction, targetMidi, errorCents, absoluteErrorCents: Math.abs(errorCents) };
  }).sort((left, right) => left.absoluteErrorCents - right.absoluteErrorCents);
  const nearest = candidates[0]!;
  const nextNearest = candidates[1]!;
  if (nearest.absoluteErrorCents > acquisitionCorridorCents + EPSILON) return null;
  if (Math.abs(nearest.absoluteErrorCents - nextNearest.absoluteErrorCents) <= EPSILON) return null;
  return nearest;
}

function errorSide(errorCents: number, deadbandCents: number): -1 | 0 | 1 {
  if (errorCents < -deadbandCents) return -1;
  if (errorCents > deadbandCents) return 1;
  return 0;
}

function createCapture(
  selection: Readonly<PitchMazeDirectionSelection>,
  timeSeconds: number,
  options: Readonly<ResolvedPitchMazeControllerOptions>,
): PitchMazeCommandCapture {
  const inBand = selection.absoluteErrorCents <= options.toleranceCents + EPSILON;
  const settled = selection.absoluteErrorCents <= options.settleToleranceCents + EPSILON;
  return {
    direction: selection.direction,
    targetMidi: selection.targetMidi,
    startedAtSeconds: timeSeconds,
    attackErrorCents: selection.errorCents,
    settledAtSeconds: settled ? timeSeconds : null,
    sampleCount: 1,
    inBandSampleCount: inBand ? 1 : 0,
    absoluteErrorTotalCents: selection.absoluteErrorCents,
    signedErrorTotalCents: selection.errorCents,
    squaredErrorTotalCents: selection.errorCents ** 2,
    overshootCount: 0,
    lastErrorSide: errorSide(selection.errorCents, options.overshootDeadbandCents),
  };
}

function appendCapture(
  capture: Readonly<PitchMazeCommandCapture>,
  errorCents: number,
  timeSeconds: number,
  options: Readonly<ResolvedPitchMazeControllerOptions>,
): PitchMazeCommandCapture {
  const absoluteErrorCents = Math.abs(errorCents);
  const side = errorSide(errorCents, options.overshootDeadbandCents);
  const crossed = side !== 0 && capture.lastErrorSide !== 0 && side !== capture.lastErrorSide;
  return {
    ...capture,
    settledAtSeconds: capture.settledAtSeconds
      ?? (absoluteErrorCents <= options.settleToleranceCents + EPSILON ? timeSeconds : null),
    sampleCount: capture.sampleCount + 1,
    inBandSampleCount: capture.inBandSampleCount
      + (absoluteErrorCents <= options.toleranceCents + EPSILON ? 1 : 0),
    absoluteErrorTotalCents: capture.absoluteErrorTotalCents + absoluteErrorCents,
    signedErrorTotalCents: capture.signedErrorTotalCents + errorCents,
    squaredErrorTotalCents: capture.squaredErrorTotalCents + errorCents ** 2,
    overshootCount: capture.overshootCount + (crossed ? 1 : 0),
    lastErrorSide: side === 0 ? capture.lastErrorSide : side,
  };
}

/** Turn a completed aggregate into compact movement telemetry and a 0–100 grade. */
export function summarizePitchMazeCommand(
  capture: Readonly<PitchMazeCommandCapture>,
  endedAtSeconds: number,
  options: Pick<
    ResolvedPitchMazeControllerOptions,
    "toleranceCents" | "requiredHoldSeconds" | "acquisitionCorridorCents"
  >,
): PitchMazeCommandQuality {
  requireFinite(endedAtSeconds, "Command end timestamp");
  if (endedAtSeconds < capture.startedAtSeconds) {
    throw new RangeError("Command cannot end before it starts.");
  }
  if (capture.sampleCount < 1) throw new RangeError("A command needs at least one sample.");

  const sampleCount = capture.sampleCount;
  const meanAbsoluteErrorCents = capture.absoluteErrorTotalCents / sampleCount;
  const meanSignedErrorCents = capture.signedErrorTotalCents / sampleCount;
  const variance = Math.max(
    0,
    capture.squaredErrorTotalCents / sampleCount - meanSignedErrorCents ** 2,
  );
  const spreadCents = Math.sqrt(variance);
  const inBandRatio = capture.inBandSampleCount / sampleCount;
  const settleTimeSeconds = capture.settledAtSeconds === null
    ? null
    : Math.max(0, capture.settledAtSeconds - capture.startedAtSeconds);

  const accuracy = clamp(1 - meanAbsoluteErrorCents / (options.toleranceCents * 1.5), 0, 1);
  const stability = clamp(1 - spreadCents / (options.toleranceCents * 1.25), 0, 1);
  const attack = clamp(1 - Math.abs(capture.attackErrorCents) / options.acquisitionCorridorCents, 0, 1);
  const settleBudget = Math.max(options.requiredHoldSeconds, 0.25);
  const settle = settleTimeSeconds === null
    ? 0
    : clamp(1 - settleTimeSeconds / (settleBudget * 1.5), 0, 1);
  const overshoot = clamp(1 - capture.overshootCount / 4, 0, 1);
  const qualityScore = Math.round(100 * (
    0.3 * inBandRatio
    + 0.25 * accuracy
    + 0.2 * stability
    + 0.1 * attack
    + 0.1 * settle
    + 0.05 * overshoot
  ));

  return {
    direction: capture.direction,
    targetMidi: capture.targetMidi,
    startedAtSeconds: capture.startedAtSeconds,
    endedAtSeconds,
    durationSeconds: endedAtSeconds - capture.startedAtSeconds,
    attackErrorCents: capture.attackErrorCents,
    settleTimeSeconds,
    overshootCount: capture.overshootCount,
    sampleCount,
    inBandSampleCount: capture.inBandSampleCount,
    inBandRatio,
    meanAbsoluteErrorCents,
    meanSignedErrorCents,
    spreadCents,
    qualityScore,
  };
}

function beginTracking(
  state: Readonly<PitchMazeControllerState>,
  selection: Readonly<PitchMazeDirectionSelection>,
  frame: Readonly<PitchMazeVoiceFrame>,
): PitchMazeControllerUpdate {
  const initialSustain = createSustainTracker({
    targetMidi: selection.targetMidi,
    requiredHoldSeconds: state.options.requiredHoldSeconds,
    toleranceCents: state.options.toleranceCents,
    listeningStartedAtSeconds: frame.timeSeconds,
    minimumConfidence: state.options.minimumConfidence,
  });
  const sustain = updateSustainTracker(initialSustain, frame);
  return {
    event: null,
    state: {
      ...state,
      phase: "tracking",
      activeDirection: selection.direction,
      activeTargetMidi: selection.targetMidi,
      sustain,
      capture: createCapture(selection, frame.timeSeconds, state.options),
      releaseStartedAtSeconds: null,
      releaseProgress: 0,
      lastProcessedTimeSeconds: frame.timeSeconds,
    },
  };
}

function clearAttempt(
  state: Readonly<PitchMazeControllerState>,
  timeSeconds: number,
): PitchMazeControllerState {
  return {
    ...state,
    phase: "armed",
    activeDirection: null,
    activeTargetMidi: null,
    sustain: null,
    capture: null,
    releaseStartedAtSeconds: null,
    releaseProgress: 0,
    lastProcessedTimeSeconds: timeSeconds,
  };
}

function updateAwaitingRelease(
  state: Readonly<PitchMazeControllerState>,
  frame: Readonly<PitchMazeVoiceFrame>,
): PitchMazeControllerUpdate {
  // Interpreter uncertainty is not proof the singer released. Only detector
  // reasons that represent absent/aperiodic input can advance this gate.
  const releaseEvidence = frame.detector === "yin"
    && !frame.voiced
    && RELEASE_REASONS.has(frame.reason);
  if (!releaseEvidence) {
    return {
      event: null,
      state: {
        ...state,
        releaseStartedAtSeconds: null,
        releaseProgress: 0,
        lastProcessedTimeSeconds: frame.timeSeconds,
      },
    };
  }

  const releaseStartedAtSeconds = state.releaseStartedAtSeconds ?? frame.timeSeconds;
  const releasedSeconds = Math.max(0, frame.timeSeconds - releaseStartedAtSeconds);
  const releaseProgress = clamp(releasedSeconds / state.options.releaseDurationSeconds, 0, 1);
  if (releaseProgress + EPSILON < 1) {
    return {
      event: null,
      state: {
        ...state,
        releaseStartedAtSeconds,
        releaseProgress,
        lastProcessedTimeSeconds: frame.timeSeconds,
      },
    };
  }

  return {
    event: { type: "rearmed" },
    state: {
      ...state,
      phase: "armed",
      activeDirection: null,
      activeTargetMidi: null,
      sustain: null,
      capture: null,
      releaseStartedAtSeconds: null,
      releaseProgress: 1,
      lastProcessedTimeSeconds: frame.timeSeconds,
    },
  };
}

/**
 * Consume exactly one interpreted frame. A completed command cannot repeat
 * until a separate, continuous release gesture re-arms the controller.
 */
export function updatePitchMazeController(
  state: Readonly<PitchMazeControllerState>,
  frame: Readonly<PitchMazeVoiceFrame>,
): PitchMazeControllerUpdate {
  if (!Number.isFinite(frame.timeSeconds)
    || frame.timeSeconds < state.options.listeningStartedAtSeconds
    || (state.lastProcessedTimeSeconds !== null
      && frame.timeSeconds <= state.lastProcessedTimeSeconds)) {
    return { state: state as PitchMazeControllerState, event: null };
  }

  if (state.phase === "awaiting-release") {
    return updateAwaitingRelease(state, frame);
  }

  const reliable = isReliablePitchMazeFrame(frame, state.options.minimumConfidence);
  if (!reliable) {
    if (state.phase === "tracking" && state.sustain !== null) {
      const sustain = updateSustainTracker(state.sustain, frame);
      if (sustain.status === "waiting") {
        return { state: clearAttempt(state, frame.timeSeconds), event: null };
      }
      return {
        event: null,
        state: { ...state, sustain, lastProcessedTimeSeconds: frame.timeSeconds },
      };
    }
    return {
      event: null,
      state: { ...state, lastProcessedTimeSeconds: frame.timeSeconds },
    };
  }

  const selection = selectPitchMazeDirection(
    state.options.directionNotes,
    frame.midiFloat!,
    state.options.acquisitionCorridorCents,
  );
  if (state.phase === "armed") {
    return selection === null
      ? { state: { ...state, lastProcessedTimeSeconds: frame.timeSeconds }, event: null }
      : beginTracking(state, selection, frame);
  }

  if (state.activeDirection === null
    || state.activeTargetMidi === null
    || state.sustain === null
    || state.capture === null) {
    return { state: clearAttempt(state, frame.timeSeconds), event: null };
  }

  const activeErrorCents = (frame.midiFloat! - state.activeTargetMidi) * 100;
  const activeAbsoluteErrorCents = Math.abs(activeErrorCents);
  const shouldSwitch = selection !== null
    && selection.direction !== state.activeDirection
    && selection.absoluteErrorCents + state.options.directionSwitchHysteresisCents
      < activeAbsoluteErrorCents - EPSILON;
  if (shouldSwitch) return beginTracking(state, selection, frame);

  const lockedRetentionCorridor = state.options.acquisitionCorridorCents
    + state.options.directionSwitchHysteresisCents;
  if (activeAbsoluteErrorCents > lockedRetentionCorridor + EPSILON) {
    return selection === null
      ? { state: clearAttempt(state, frame.timeSeconds), event: null }
      : beginTracking(state, selection, frame);
  }

  const sustain = updateSustainTracker(state.sustain, frame);
  const capture = appendCapture(state.capture, activeErrorCents, frame.timeSeconds, state.options);
  if (sustain.status !== "complete") {
    return {
      event: null,
      state: {
        ...state,
        sustain,
        capture,
        lastProcessedTimeSeconds: frame.timeSeconds,
      },
    };
  }

  const command = summarizePitchMazeCommand(capture, frame.timeSeconds, state.options);
  return {
    event: { type: "command-complete", command },
    state: {
      ...state,
      phase: "awaiting-release",
      sustain,
      capture,
      releaseStartedAtSeconds: null,
      releaseProgress: 0,
      lastProcessedTimeSeconds: frame.timeSeconds,
      completedCommandCount: state.completedCommandCount + 1,
      lastCommand: command,
    },
  };
}
