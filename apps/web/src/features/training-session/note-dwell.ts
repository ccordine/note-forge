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

export const NOTE_DWELL_DEFAULTS = Object.freeze({
  /** One missing 20 ms detector hop cannot be credited as observed dwell. */
  maximumCreditedIntervalSeconds: MICROPHONE_ANALYSIS_HOP_SECONDS * 1.5,
});

export type NoteDwellAuthority = ObservationSampleAuthority;

export interface CreateNoteDwellOptions {
  readonly targetMidi: number;
  readonly toleranceCents: number;
  readonly requiredHoldSeconds: number;
  readonly maximumCreditedIntervalSeconds?: number;
}

export interface NoteDwellState {
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
  readonly lastAuthority: Readonly<NoteDwellAuthority> | null;
  /** Whether the preceding authoritative frame can bound a credited interval. */
  readonly previousFrameQualified: boolean;
}

export type NoteDwellAction =
  | { readonly type: "observation"; readonly observation: Readonly<PitchObservation> }
  | { readonly type: "reconfigure-tolerance"; readonly toleranceCents: number }
  | { readonly type: "replace"; readonly state: Readonly<NoteDwellState> };

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requireTolerance(toleranceCents: number): void {
  requireFinite(toleranceCents, "Tolerance");
  if (toleranceCents <= 0 || toleranceCents > 100) {
    throw new RangeError("Tolerance must be greater than zero and no greater than 100 cents.");
  }
}

function freezeState(state: NoteDwellState): NoteDwellState {
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
  state: Readonly<NoteDwellState>,
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
  state: Readonly<NoteDwellState>,
  authority: Readonly<ObservationSampleAuthority>,
  current: Readonly<CurrentObservation>,
  previousFrameQualified: boolean,
): NoteDwellState {
  return freezeState({
    ...state,
    ...currentStateFields(current),
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: authority,
    previousFrameQualified,
  });
}

function resetFromObservation(
  state: Readonly<NoteDwellState>,
  authority: Readonly<ObservationSampleAuthority>,
  current: Readonly<CurrentObservation>,
): NoteDwellState {
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

export function createNoteDwell(
  options: Readonly<CreateNoteDwellOptions>,
): NoteDwellState {
  requireFinite(options.targetMidi, "Target MIDI");
  if (options.targetMidi < 0 || options.targetMidi > 127) {
    throw new RangeError("Target MIDI must be from 0 through 127.");
  }
  requireTolerance(options.toleranceCents);
  requireFinite(options.requiredHoldSeconds, "Required hold duration");
  if (options.requiredHoldSeconds <= 0) {
    throw new RangeError("Required hold duration must be greater than zero.");
  }
  const maximumCreditedIntervalSeconds = options.maximumCreditedIntervalSeconds
    ?? NOTE_DWELL_DEFAULTS.maximumCreditedIntervalSeconds;
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
 * Apply an explicitly chosen lane width without rewriting retained evidence.
 * The previous frame was classified under the old lane, so it cannot bound a
 * credited interval under the new one. The next authoritative observation
 * establishes qualification for the new lane; a following contiguous frame
 * may then add sample time. Current and peak occupancy remain exact.
 */
export function reconfigureNoteDwellTolerance(
  state: Readonly<NoteDwellState>,
  toleranceCents: number,
): NoteDwellState {
  requireTolerance(toleranceCents);
  if (state.toleranceCents === toleranceCents) return state as NoteDwellState;
  return freezeState({
    ...state,
    toleranceCents,
    currentInTolerance: null,
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
export function updateNoteDwell(
  state: Readonly<NoteDwellState>,
  observation: Readonly<PitchObservation>,
): NoteDwellState {
  const previous = state.lastAuthority;
  const continuity = observationContinuity(previous, observation);
  if (!continuity.accepted || continuity.authority === null) return state as NoteDwellState;
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

/** Reduce realtime observations and explicit configuration through one owner. */
export function reduceNoteDwell(
  state: Readonly<NoteDwellState>,
  action: Readonly<NoteDwellAction>,
): NoteDwellState {
  switch (action.type) {
    case "observation": return updateNoteDwell(state, action.observation);
    case "reconfigure-tolerance": {
      return reconfigureNoteDwellTolerance(state, action.toleranceCents);
    }
    case "replace": return action.state as NoteDwellState;
  }
}
