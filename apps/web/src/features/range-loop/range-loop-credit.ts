import type {
  PitchObservation,
  PitchObservationKind,
} from "@/audio/note-input";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";

export const RANGE_LOOP_CREDIT_GOAL_SECONDS = 30;

export interface CreateRangeLoopCreditOptions {
  readonly targetMidi: number;
  readonly toleranceCents: number;
  readonly acceptingCredit?: boolean;
}

export interface RangeLoopCreditState {
  readonly targetMidi: number;
  readonly toleranceCents: number;
  readonly requiredSeconds: typeof RANGE_LOOP_CREDIT_GOAL_SECONDS;
  readonly acceptingCredit: boolean;
  /** A milestone that enables Next; it never stops or caps collection. */
  readonly achievementReached: boolean;
  /** Exact qualifying samples summed from consecutive detector hops. */
  readonly creditedSamples: number;
  /** Each qualifying sample interval divided by its negotiated sample rate. */
  readonly creditedSeconds: number;
  readonly progress: number;
  readonly currentObservationKind: PitchObservationKind | null;
  readonly currentInTolerance: boolean | null;
  readonly observedFrameCount: number;
  readonly lastAuthority: Readonly<ObservationSampleAuthority> | null;
  readonly previousFrameQualified: boolean;
}

export type RangeLoopCreditAction =
  | Readonly<{ type: "observation"; observation: Readonly<PitchObservation> }>
  | Readonly<{ type: "reconfigure-tolerance"; toleranceCents: number }>
  | Readonly<{ type: "replace"; state: Readonly<RangeLoopCreditState> }>;

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requireTolerance(toleranceCents: number): void {
  requireFinite(toleranceCents, "Tolerance");
  if (toleranceCents <= 0 || toleranceCents > 100) {
    throw new RangeError("Tolerance must be greater than zero and no greater than 100 cents.");
  }
}

function freezeState(state: RangeLoopCreditState): RangeLoopCreditState {
  return Object.freeze(state);
}

export function createRangeLoopCredit(
  options: Readonly<CreateRangeLoopCreditOptions>,
): RangeLoopCreditState {
  requireFinite(options.targetMidi, "Target MIDI");
  if (options.targetMidi < 0 || options.targetMidi > 127) {
    throw new RangeError("Target MIDI must be from 0 through 127.");
  }
  requireTolerance(options.toleranceCents);
  return freezeState({
    targetMidi: options.targetMidi,
    toleranceCents: options.toleranceCents,
    requiredSeconds: RANGE_LOOP_CREDIT_GOAL_SECONDS,
    acceptingCredit: options.acceptingCredit ?? true,
    achievementReached: false,
    creditedSamples: 0,
    creditedSeconds: 0,
    progress: 0,
    currentObservationKind: null,
    currentInTolerance: null,
    observedFrameCount: 0,
    lastAuthority: null,
    previousFrameQualified: false,
  });
}

/**
 * A new lane width applies only to new evidence. Already collected time stays
 * exact, and the next frame establishes fresh qualification under the new
 * boundary before another interval can be credited.
 */
export function reconfigureRangeLoopTolerance(
  state: Readonly<RangeLoopCreditState>,
  toleranceCents: number,
): RangeLoopCreditState {
  requireTolerance(toleranceCents);
  if (state.toleranceCents === toleranceCents) return state as RangeLoopCreditState;
  return freezeState({
    ...state,
    toleranceCents,
    currentInTolerance: null,
    previousFrameQualified: false,
  });
}

/**
 * Collect exact in-lane sample time across any number of vocal attempts.
 * Silence, uncertainty, wrong notes, and authority boundaries add nothing and
 * bridge nothing, but none of them erase credit already collected.
 */
export function updateRangeLoopCredit(
  state: Readonly<RangeLoopCreditState>,
  observation: Readonly<PitchObservation>,
): RangeLoopCreditState {
  const continuity = observationContinuity(state.lastAuthority, observation);
  if (!continuity.accepted || continuity.authority === null) {
    return state as RangeLoopCreditState;
  }

  const reliableVoiced = isAuthoritativeVoicedPitch(observation);
  const currentInTolerance = reliableVoiced
    ? Math.abs((observation.midiFloat - state.targetMidi) * 100)
      <= state.toleranceCents + 1e-9
    : null;
  const qualified = state.acceptingCredit && currentInTolerance === true;
  const creditInterval = continuity.contiguous
    && qualified
    && state.previousFrameQualified;
  const creditedSamples = state.creditedSamples
    + (creditInterval ? continuity.deltaSamples : 0);
  const creditedSeconds = state.creditedSeconds
    + (creditInterval ? continuity.deltaSeconds : 0);
  const achievementReached = state.achievementReached
    || creditedSeconds + 1e-9 >= state.requiredSeconds;
  return freezeState({
    ...state,
    achievementReached,
    creditedSamples,
    creditedSeconds,
    progress: achievementReached
      ? 1
      : Math.min(1, creditedSeconds / state.requiredSeconds),
    currentObservationKind: observation.observationKind,
    currentInTolerance,
    observedFrameCount: state.observedFrameCount + 1,
    lastAuthority: continuity.authority,
    previousFrameQualified: qualified,
  });
}

export function reduceRangeLoopCredit(
  state: Readonly<RangeLoopCreditState>,
  action: Readonly<RangeLoopCreditAction>,
): RangeLoopCreditState {
  switch (action.type) {
    case "observation": return updateRangeLoopCredit(state, action.observation);
    case "reconfigure-tolerance": {
      return reconfigureRangeLoopTolerance(state, action.toleranceCents);
    }
    case "replace": return action.state as RangeLoopCreditState;
  }
}
