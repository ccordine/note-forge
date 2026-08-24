import { MICROPHONE_ANALYSIS_HOP_SECONDS } from "../../audio/microphone";
import {
  NOTE_INPUT_DEFAULTS,
  type PitchObservation,
  type PitchObservationKind,
} from "../../audio/note-input";

export type RangeDwellStatus = "tracking" | "complete";

export const RANGE_DWELL_DEFAULTS = Object.freeze({
  minimumConfidence: NOTE_INPUT_DEFAULTS.minConfidence,
  /** One missing 20 ms detector hop cannot be credited as observed dwell. */
  maximumCreditedIntervalSeconds: MICROPHONE_ANALYSIS_HOP_SECONDS * 1.5,
});

export interface RangeDwellAuthority {
  readonly sampleRate: number;
  readonly endSample: number;
  readonly processedSampleCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly workletProcessCount: number;
}

export interface CreateRangeDwellOptions {
  readonly targetMidi: number;
  readonly toleranceCents: number;
  readonly requiredHoldSeconds: number;
  readonly minimumConfidence?: number;
  readonly maximumCreditedIntervalSeconds?: number;
}

export interface RangeDwellState {
  readonly targetMidi: number;
  readonly toleranceCents: number;
  readonly requiredHoldSeconds: number;
  readonly minimumConfidence: number;
  readonly maximumCreditedIntervalSeconds: number;
  readonly status: RangeDwellStatus;
  /** Exact count of qualifying capture-domain samples credited across all intervals. */
  readonly heldSamples: number;
  /** Sum of each credited sample interval divided by that interval's capture rate. */
  readonly heldSeconds: number;
  readonly progress: number;
  readonly currentObservationKind: PitchObservationKind | null;
  readonly currentMidiFloat: number | null;
  readonly currentNearestMidi: number | null;
  readonly currentFrequencyHz: number | null;
  readonly currentCentsFromTarget: number | null;
  readonly currentConfidence: number;
  readonly currentInTolerance: boolean | null;
  readonly observedFrameCount: number;
  readonly lastAuthority: Readonly<RangeDwellAuthority> | null;
  /** Whether the preceding authoritative frame can bound a credited interval. */
  readonly previousFrameQualified: boolean;
}

export type RangeDwellAction =
  | { readonly type: "observation"; readonly observation: Readonly<PitchObservation> }
  | { readonly type: "replace"; readonly state: Readonly<RangeDwellState> };

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function freezeState(state: RangeDwellState): RangeDwellState {
  return Object.freeze(state);
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function validObservationAuthority(observation: Readonly<PitchObservation>): boolean {
  return Number.isFinite(observation.sampleRate)
    && observation.sampleRate > 0
    && Number.isSafeInteger(observation.startSample)
    && observation.startSample >= 0
    && Number.isSafeInteger(observation.endSample)
    && observation.endSample > observation.startSample
    && Number.isSafeInteger(observation.processedSampleCount)
    && observation.processedSampleCount === observation.endSample
    && Number.isSafeInteger(observation.captureEpoch)
    && observation.captureEpoch >= 0
    && Number.isSafeInteger(observation.continuityEpoch)
    && observation.continuityEpoch >= 0
    && Number.isSafeInteger(observation.graphGeneration)
    && observation.graphGeneration >= 0
    && Number.isSafeInteger(observation.workletProcessCount)
    && observation.workletProcessCount >= 0;
}

function authorityFromObservation(
  observation: Readonly<PitchObservation>,
): Readonly<RangeDwellAuthority> {
  return Object.freeze({
    sampleRate: observation.sampleRate,
    endSample: observation.endSample,
    processedSampleCount: observation.processedSampleCount,
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
    graphGeneration: observation.graphGeneration,
    workletProcessCount: observation.workletProcessCount,
  });
}

function sameStreamAuthority(
  previous: Readonly<RangeDwellAuthority>,
  observation: Readonly<PitchObservation>,
): boolean {
  return previous.sampleRate === observation.sampleRate
    && previous.captureEpoch === observation.captureEpoch
    && previous.continuityEpoch === observation.continuityEpoch
    && previous.graphGeneration === observation.graphGeneration;
}

interface CurrentObservation {
  readonly currentObservationKind: PitchObservationKind;
  readonly currentMidiFloat: number | null;
  readonly currentNearestMidi: number | null;
  readonly currentFrequencyHz: number | null;
  readonly currentCentsFromTarget: number | null;
  readonly currentConfidence: number;
  readonly currentInTolerance: boolean | null;
  readonly reliableVoiced: boolean;
}

function currentStateFields(
  current: Readonly<CurrentObservation>,
): Omit<CurrentObservation, "reliableVoiced"> {
  const { reliableVoiced: _reliableVoiced, ...fields } = current;
  return fields;
}

function readCurrentObservation(
  state: Readonly<RangeDwellState>,
  observation: Readonly<PitchObservation>,
): CurrentObservation {
  const midiFloat = finiteOrNull(observation.midiFloat);
  const nearestMidi = observation.nearestMidi !== null
    && Number.isSafeInteger(observation.nearestMidi)
    ? observation.nearestMidi
    : null;
  const frequencyHz = finiteOrNull(observation.frequencyHz);
  const confidence = Number.isFinite(observation.confidence)
    ? Math.min(1, Math.max(0, observation.confidence))
    : 0;
  const reliableVoiced = observation.observationKind === "voiced"
    && observation.voiced
    && midiFloat !== null
    && confidence >= state.minimumConfidence;
  const centsFromTarget = midiFloat === null ? null : (midiFloat - state.targetMidi) * 100;
  return Object.freeze({
    currentObservationKind: observation.observationKind,
    currentMidiFloat: midiFloat,
    currentNearestMidi: nearestMidi,
    currentFrequencyHz: frequencyHz,
    currentCentsFromTarget: centsFromTarget,
    currentConfidence: confidence,
    currentInTolerance: reliableVoiced
      ? Math.abs(centsFromTarget!) <= state.toleranceCents + 1e-9
      : null,
    reliableVoiced,
  });
}

function observeWithoutCredit(
  state: Readonly<RangeDwellState>,
  observation: Readonly<PitchObservation>,
  current: Readonly<CurrentObservation>,
  previousFrameQualified: boolean,
): RangeDwellState {
  return freezeState({
    ...state,
    ...currentStateFields(current),
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: authorityFromObservation(observation),
    previousFrameQualified,
  });
}

function resetFromObservation(
  state: Readonly<RangeDwellState>,
  observation: Readonly<PitchObservation>,
  current: Readonly<CurrentObservation>,
): RangeDwellState {
  return freezeState({
    ...state,
    ...currentStateFields(current),
    status: "tracking",
    heldSamples: 0,
    heldSeconds: 0,
    progress: 0,
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: authorityFromObservation(observation),
    previousFrameQualified: false,
  });
}

export function createRangeDwell(
  options: Readonly<CreateRangeDwellOptions>,
): RangeDwellState {
  requireFinite(options.targetMidi, "Target MIDI");
  if (options.targetMidi < 0 || options.targetMidi > 127) {
    throw new RangeError("Target MIDI must be from 0 through 127.");
  }
  requireFinite(options.toleranceCents, "Tolerance");
  if (options.toleranceCents <= 0 || options.toleranceCents > 100) {
    throw new RangeError("Tolerance must be greater than zero and no greater than 100 cents.");
  }
  requireFinite(options.requiredHoldSeconds, "Required hold duration");
  if (options.requiredHoldSeconds <= 0) {
    throw new RangeError("Required hold duration must be greater than zero.");
  }
  const minimumConfidence = options.minimumConfidence
    ?? RANGE_DWELL_DEFAULTS.minimumConfidence;
  requireFinite(minimumConfidence, "Minimum confidence");
  if (minimumConfidence < 0 || minimumConfidence > 1) {
    throw new RangeError("Minimum confidence must be from 0 through 1.");
  }
  const maximumCreditedIntervalSeconds = options.maximumCreditedIntervalSeconds
    ?? RANGE_DWELL_DEFAULTS.maximumCreditedIntervalSeconds;
  requireFinite(maximumCreditedIntervalSeconds, "Maximum credited interval");
  if (maximumCreditedIntervalSeconds <= 0) {
    throw new RangeError("Maximum credited interval must be greater than zero.");
  }

  return freezeState({
    targetMidi: options.targetMidi,
    toleranceCents: options.toleranceCents,
    requiredHoldSeconds: options.requiredHoldSeconds,
    minimumConfidence,
    maximumCreditedIntervalSeconds,
    status: "tracking",
    heldSamples: 0,
    heldSeconds: 0,
    progress: 0,
    currentObservationKind: null,
    currentMidiFloat: null,
    currentNearestMidi: null,
    currentFrequencyHz: null,
    currentCentsFromTarget: null,
    currentConfidence: 0,
    currentInTolerance: null,
    observedFrameCount: 0,
    lastAuthority: null,
    previousFrameQualified: false,
  });
}

/**
 * Reduce one canonical pitch observation using capture-sample coordinates only.
 * Unvoiced/uncertain evidence pauses accumulation without erasing it. A credible
 * wrong pitch resets an unfinished dwell. Completion is terminal for scoring,
 * while current observation telemetry continues to update.
 */
export function updateRangeDwell(
  state: Readonly<RangeDwellState>,
  observation: Readonly<PitchObservation>,
): RangeDwellState {
  if (!validObservationAuthority(observation)) return state as RangeDwellState;
  const previous = state.lastAuthority;

  // Duplicates and reordered observations have no authority to replace a newer
  // current reading or make a later interval include already processed samples.
  if (
    previous !== null
    && sameStreamAuthority(previous, observation)
    && (
      observation.endSample <= previous.endSample
      || observation.workletProcessCount <= previous.workletProcessCount
    )
  ) {
    return state as RangeDwellState;
  }

  const current = readCurrentObservation(state, observation);
  const qualified = current.reliableVoiced && current.currentInTolerance === true;
  const boundary = previous === null
    || observation.discontinuity
    || !sameStreamAuthority(previous, observation);

  if (
    state.status !== "complete"
    && current.reliableVoiced
    && current.currentInTolerance === false
  ) {
    return resetFromObservation(state, observation, current);
  }

  if (boundary) {
    return observeWithoutCredit(state, observation, current, qualified);
  }

  const deltaSamples = observation.endSample - previous.endSample;
  const deltaSeconds = deltaSamples / observation.sampleRate;
  const missingEvidence = deltaSamples <= 0
    || deltaSeconds > state.maximumCreditedIntervalSeconds + Number.EPSILON;
  if (missingEvidence) {
    return observeWithoutCredit(state, observation, current, qualified);
  }

  if (state.status === "complete") {
    return observeWithoutCredit(state, observation, current, false);
  }

  if (!qualified || !state.previousFrameQualified) {
    return observeWithoutCredit(state, observation, current, qualified);
  }

  const remainingSeconds = Math.max(0, state.requiredHoldSeconds - state.heldSeconds);
  const remainingSamples = Math.max(
    0,
    Math.ceil(remainingSeconds * observation.sampleRate - 1e-9),
  );
  const creditedSamples = Math.min(deltaSamples, remainingSamples);
  const heldSamples = state.heldSamples + creditedSamples;
  const heldSeconds = Math.min(
    state.requiredHoldSeconds,
    state.heldSeconds + creditedSamples / observation.sampleRate,
  );
  const complete = heldSeconds + Number.EPSILON >= state.requiredHoldSeconds;
  return freezeState({
    ...state,
    ...currentStateFields(current),
    status: complete ? "complete" : "tracking",
    heldSamples,
    heldSeconds: complete ? state.requiredHoldSeconds : heldSeconds,
    progress: complete ? 1 : heldSeconds / state.requiredHoldSeconds,
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: authorityFromObservation(observation),
    previousFrameQualified: qualified,
  });
}

/** Reduce realtime observations and explicit target replacement through one owner. */
export function reduceRangeDwell(
  state: Readonly<RangeDwellState>,
  action: Readonly<RangeDwellAction>,
): RangeDwellState {
  return action.type === "observation"
    ? updateRangeDwell(state, action.observation)
    : action.state as RangeDwellState;
}
