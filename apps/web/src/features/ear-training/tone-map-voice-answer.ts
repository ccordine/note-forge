import type { PitchObservation } from "@/audio/note-input";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";
import {
  createNoteDwell,
  reconfigureNoteDwellTolerance,
  updateNoteDwell,
  type NoteDwellState,
} from "@/features/training-session/note-dwell";

export const TONE_MAP_VOICE_HOLD_SECONDS = 0.25;

export type ToneMapVoiceAnswerStatus =
  | "inactive"
  | "awaiting-release"
  | "listening"
  | "ready";

export interface ToneMapVoiceTrialContext {
  readonly trialOrdinal: number;
  readonly active: boolean;
  readonly answered: boolean;
  readonly promptPlaying: boolean;
  readonly toleranceCents: number;
}

export interface ToneMapVoiceAnswerState {
  readonly trialOrdinal: number | null;
  readonly promptPlaying: boolean;
  readonly toleranceCents: number;
  readonly status: ToneMapVoiceAnswerStatus;
  /** Exact observation that caused the current semantic status, if any. */
  readonly statusAuthority: Readonly<ObservationSampleAuthority> | null;
  readonly dwell: Readonly<NoteDwellState> | null;
  readonly lastSeenAuthority: Readonly<ObservationSampleAuthority> | null;
}

export interface ToneMapVoiceAnswerSnapshot {
  readonly status: ToneMapVoiceAnswerStatus;
  readonly ready: boolean;
  /** Target-independent provenance published only with a semantic status change. */
  readonly statusAuthority: Readonly<ObservationSampleAuthority> | null;
}

function requireTolerance(toleranceCents: number): void {
  if (!Number.isFinite(toleranceCents) || toleranceCents <= 0 || toleranceCents > 100) {
    throw new RangeError("Tone Map voice tolerance must be greater than zero and no greater than 100 cents.");
  }
}

function awaitingRelease(
  trialOrdinal: number,
  promptPlaying: boolean,
  toleranceCents: number,
  lastSeenAuthority: Readonly<ObservationSampleAuthority> | null,
): ToneMapVoiceAnswerState {
  return Object.freeze({
    trialOrdinal,
    promptPlaying,
    toleranceCents,
    status: "awaiting-release",
    statusAuthority: null,
    dwell: null,
    lastSeenAuthority,
  });
}

function inactive(
  state: Readonly<ToneMapVoiceAnswerState>,
): ToneMapVoiceAnswerState {
  if (
    state.status === "inactive"
    && state.trialOrdinal === null
    && !state.promptPlaying
    && state.dwell === null
  ) return state as ToneMapVoiceAnswerState;
  return Object.freeze({
    trialOrdinal: null,
    promptPlaying: false,
    toleranceCents: state.toleranceCents,
    status: "inactive",
    statusAuthority: null,
    dwell: null,
    lastSeenAuthority: state.lastSeenAuthority,
  });
}

export function createToneMapVoiceAnswerState(toleranceCents: number): ToneMapVoiceAnswerState {
  requireTolerance(toleranceCents);
  return Object.freeze({
    trialOrdinal: null,
    promptPlaying: false,
    toleranceCents,
    status: "inactive",
    statusAuthority: null,
    dwell: null,
    lastSeenAuthority: null,
  });
}

/**
 * A task change or any prompt playback invalidates all prior vocal evidence.
 * Turning the prompt off deliberately does not arm the answer: a fresh
 * authoritative unvoiced frame must prove that the prompt/previous note ended.
 */
export function configureToneMapVoiceAnswer(
  state: Readonly<ToneMapVoiceAnswerState>,
  context: Readonly<ToneMapVoiceTrialContext>,
): ToneMapVoiceAnswerState {
  requireTolerance(context.toleranceCents);
  const configured = state.toleranceCents === context.toleranceCents
    ? state
    : Object.freeze({
        ...state,
        toleranceCents: context.toleranceCents,
        dwell: state.dwell === null
          ? null
          : reconfigureNoteDwellTolerance(state.dwell, context.toleranceCents),
      });
  if (!context.active || context.answered) return inactive(configured);
  if (configured.trialOrdinal !== context.trialOrdinal) {
    return awaitingRelease(
      context.trialOrdinal,
      context.promptPlaying,
      context.toleranceCents,
      configured.lastSeenAuthority,
    );
  }
  if (context.promptPlaying) {
    if (configured.promptPlaying && configured.status === "awaiting-release") return configured as ToneMapVoiceAnswerState;
    return awaitingRelease(
      context.trialOrdinal,
      true,
      context.toleranceCents,
      configured.lastSeenAuthority,
    );
  }
  if (configured.promptPlaying) {
    return awaitingRelease(
      context.trialOrdinal,
      false,
      context.toleranceCents,
      configured.lastSeenAuthority,
    );
  }
  return configured as ToneMapVoiceAnswerState;
}

function newDwell(
  midi: number,
  toleranceCents: number,
  observation: Readonly<PitchObservation>,
): NoteDwellState {
  return updateNoteDwell(createNoteDwell({
    targetMidi: midi,
    toleranceCents,
    requiredHoldSeconds: TONE_MAP_VOICE_HOLD_SECONDS,
  }), observation);
}

function validAnswerMidi(observation: Readonly<PitchObservation>): number | null {
  if (!isAuthoritativeVoicedPitch(observation)) return null;
  const midi = observation.nearestMidi;
  return Number.isSafeInteger(midi) && midi! >= 0 && midi! <= 127 ? midi : null;
}

/** Exact on-frame voice interpretation, independent of the requested answer. */
export function observeToneMapVoiceAnswer(
  state: Readonly<ToneMapVoiceAnswerState>,
  observation: Readonly<PitchObservation>,
): ToneMapVoiceAnswerState {
  const continuity = observationContinuity(state.lastSeenAuthority, observation);
  if (!continuity.accepted || continuity.authority === null) {
    return state as ToneMapVoiceAnswerState;
  }
  const lastSeenAuthority = continuity.authority;
  if (state.status === "inactive" || state.promptPlaying || state.trialOrdinal === null) {
    return Object.freeze({ ...state, lastSeenAuthority });
  }

  if (state.status === "awaiting-release") {
    if (observation.observationKind !== "unvoiced") {
      return Object.freeze({ ...state, lastSeenAuthority });
    }
    return Object.freeze({
      ...state,
      status: "listening",
      statusAuthority: lastSeenAuthority,
      dwell: null,
      lastSeenAuthority,
    });
  }

  const midi = validAnswerMidi(observation);
  let dwell = state.dwell;
  if (dwell === null) {
    if (midi === null) return Object.freeze({ ...state, lastSeenAuthority });
    dwell = newDwell(midi, state.toleranceCents, observation);
  } else {
    const updated = updateNoteDwell(dwell, observation);
    if (updated === dwell) return Object.freeze({ ...state, lastSeenAuthority });
    dwell = updated;
    if (
      midi !== null
      && dwell.currentInTolerance === false
      && midi !== dwell.targetMidi
    ) {
      dwell = newDwell(midi, state.toleranceCents, observation);
    }
  }

  const ready = dwell.heldSeconds + Number.EPSILON >= TONE_MAP_VOICE_HOLD_SECONDS;
  const status = ready ? "ready" : "listening";
  return Object.freeze({
    ...state,
    status,
    statusAuthority: status === state.status
      ? state.statusAuthority
      : lastSeenAuthority,
    dwell,
    lastSeenAuthority,
  });
}

export function toneMapVoiceAnswerMidi(
  state: Readonly<ToneMapVoiceAnswerState>,
): number | null {
  if (
    state.status !== "ready"
    || state.promptPlaying
    || state.dwell === null
    || state.dwell.heldSeconds + Number.EPSILON < TONE_MAP_VOICE_HOLD_SECONDS
  ) return null;
  return state.dwell.targetMidi;
}

export function toneMapVoiceAnswerSnapshot(
  state: Readonly<ToneMapVoiceAnswerState>,
): ToneMapVoiceAnswerSnapshot {
  return Object.freeze({
    status: state.status,
    ready: toneMapVoiceAnswerMidi(state) !== null,
    statusAuthority: state.statusAuthority,
  });
}
