import { MICROPHONE_ANALYSIS_HOP_SECONDS } from "../../audio/microphone";
import {
  type PitchObservation,
  type PitchObservationKind,
} from "../../audio/note-input";
import { clampUnit } from "@/lib/numeric";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";

export const RANGE_DWELL_DEFAULTS = Object.freeze({
  /** One missing 20 ms detector hop cannot be credited as observed dwell. */
  maximumCreditedIntervalSeconds: MICROPHONE_ANALYSIS_HOP_SECONDS * 1.5,
});

export type RangeDwellAuthority = ObservationSampleAuthority;

export interface CreateRangeDwellOptions {
  readonly targetMidi: number;
  readonly toleranceCents: number;
  readonly requiredHoldSeconds: number;
  readonly maximumCreditedIntervalSeconds?: number;
}

export interface RangeDwellState {
  readonly targetMidi: number;
  readonly toleranceCents: number;
  readonly requiredHoldSeconds: number;
  readonly maximumCreditedIntervalSeconds: number;
  /** A threshold milestone. It never stops or freezes observation processing. */
  readonly achievementReached: boolean;
  /** Exact count of qualifying capture-domain samples in the current occupation. */
  readonly heldSamples: number;
  /** Sum of each credited sample interval divided by that interval's capture rate. */
  readonly heldSeconds: number;
  /** Largest exact current-occupation sample count observed before any later reset. */
  readonly peakHeldSamples: number;
  /** Largest exact current-occupation duration observed before any later reset. */
  readonly peakHeldSeconds: number;
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
    ? clampUnit(observation.confidence)
    : 0;
  const reliableVoiced = isAuthoritativeVoicedPitch(observation);
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
  authority: Readonly<ObservationSampleAuthority>,
  current: Readonly<CurrentObservation>,
  previousFrameQualified: boolean,
): RangeDwellState {
  return freezeState({
    ...state,
    ...currentStateFields(current),
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: authority,
    previousFrameQualified,
  });
}

function resetFromObservation(
  state: Readonly<RangeDwellState>,
  authority: Readonly<ObservationSampleAuthority>,
  current: Readonly<CurrentObservation>,
): RangeDwellState {
  return freezeState({
    ...state,
    ...currentStateFields(current),
    heldSamples: 0,
    heldSeconds: 0,
    progress: 0,
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: authority,
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
    maximumCreditedIntervalSeconds,
    achievementReached: false,
    heldSamples: 0,
    heldSeconds: 0,
    peakHeldSamples: 0,
    peakHeldSeconds: 0,
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
 * wrong pitch resets the current dwell even after its threshold was reached.
 * Achievement is a latched milestone; observation processing and exact current
 * occupation time never become terminal or clamp at the milestone.
 */
export function updateRangeDwell(
  state: Readonly<RangeDwellState>,
  observation: Readonly<PitchObservation>,
): RangeDwellState {
  const previous = state.lastAuthority;
  const continuity = observationContinuity(previous, observation);
  if (!continuity.accepted || continuity.authority === null) return state as RangeDwellState;
  const authority = continuity.authority;

  const current = readCurrentObservation(state, observation);
  const qualified = current.reliableVoiced && current.currentInTolerance === true;
  if (
    current.reliableVoiced
    && current.currentInTolerance === false
  ) {
    return resetFromObservation(state, authority, current);
  }

  if (continuity.boundary) {
    return observeWithoutCredit(state, authority, current, qualified);
  }

  const deltaSamples = continuity.deltaSamples;
  const deltaSeconds = continuity.deltaSeconds;
  const missingEvidence = deltaSeconds > state.maximumCreditedIntervalSeconds + Number.EPSILON;
  if (missingEvidence) {
    return observeWithoutCredit(state, authority, current, qualified);
  }

  if (!qualified || !state.previousFrameQualified) {
    return observeWithoutCredit(state, authority, current, qualified);
  }

  const heldSamples = state.heldSamples + deltaSamples;
  const heldSeconds = state.heldSeconds + deltaSeconds;
  const achievementReached = state.achievementReached
    || heldSeconds + Number.EPSILON >= state.requiredHoldSeconds;
  return freezeState({
    ...state,
    ...currentStateFields(current),
    achievementReached,
    heldSamples,
    heldSeconds,
    peakHeldSamples: Math.max(state.peakHeldSamples, heldSamples),
    peakHeldSeconds: Math.max(state.peakHeldSeconds, heldSeconds),
    progress: Math.min(1, heldSeconds / state.requiredHoldSeconds),
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: authority,
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
