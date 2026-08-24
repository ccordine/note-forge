import type { PitchObservation } from "@/audio/note-input";
import type { ResonanceVoiceInput } from "./resonance-types";

export type ResonanceControllerStatus = "idle" | "driving" | "unvoiced" | "uncertain";

export interface ResonanceControllerOptions {
  /** Recent pitch evidence used to describe stability, never to admit a note. */
  readonly stabilityWindowSeconds?: number;
  readonly stableSpreadCents?: number;
  readonly unstableSpreadCents?: number;
}

export interface ResolvedResonanceControllerOptions {
  readonly stabilityWindowSeconds: number;
  readonly stableSpreadCents: number;
  readonly unstableSpreadCents: number;
}

export interface ResonancePitchEvidence {
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly endSample: number;
  readonly sampleRate: number;
  readonly midiFloat: number;
}

export interface ResonanceObservationAuthority {
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
}

export interface ResonanceControllerState {
  readonly options: ResolvedResonanceControllerOptions;
  readonly status: ResonanceControllerStatus;
  readonly pitchHistory: readonly ResonancePitchEvidence[];
  readonly midiFloat: number | null;
  readonly frequencyHz: number | null;
  readonly confidence: number;
  readonly periodicity: number;
  readonly stability: number;
  readonly coherence: number;
  readonly normalizedLevel: number;
  readonly drive: number;
  readonly evidenceReliable: boolean;
  readonly authority: ResonanceObservationAuthority | null;
  readonly observedFrameCount: number;
  readonly reliableFrameCount: number;
}

export interface ResonanceControllerFrameUpdate {
  readonly state: ResonanceControllerState;
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly authorityChanged: boolean;
}

const DEFAULT_OPTIONS = Object.freeze({
  stabilityWindowSeconds: 0.55,
  stableSpreadCents: 8,
  unstableSpreadCents: 50,
}) satisfies Readonly<ResolvedResonanceControllerOptions>;

const MAXIMUM_PITCH_HISTORY = 32;
const VOICED_FIELD_LEVEL = 0.72;
const MINIMUM_VOICED_DRIVE = 0.34;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number.`);
  }
}

function requireNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number.`);
  }
}

function resolveOptions(
  options: Readonly<ResonanceControllerOptions>,
): ResolvedResonanceControllerOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  requirePositive(resolved.stabilityWindowSeconds, "Resonance stability window");
  requireNonNegative(resolved.stableSpreadCents, "Resonance stable spread");
  requirePositive(resolved.unstableSpreadCents, "Resonance unstable spread");
  if (resolved.stableSpreadCents >= resolved.unstableSpreadCents) {
    throw new RangeError("Resonance stable spread must be below unstable spread.");
  }
  return Object.freeze(resolved);
}

function quantile(values: readonly number[], position: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function smoothstep(lower: number, upper: number, value: number): number {
  if (upper <= lower) return value >= upper ? 1 : 0;
  const normalized = clamp01((value - lower) / (upper - lower));
  return normalized * normalized * (3 - 2 * normalized);
}

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validAuthority(frame: Readonly<PitchObservation>): boolean {
  return Number.isFinite(frame.sampleRate)
    && frame.sampleRate > 0
    && isFiniteNonNegativeInteger(frame.captureEpoch)
    && isFiniteNonNegativeInteger(frame.continuityEpoch)
    && isFiniteNonNegativeInteger(frame.graphGeneration)
    && isFiniteNonNegativeInteger(frame.startSample)
    && isFiniteNonNegativeInteger(frame.endSample)
    && frame.endSample > frame.startSample;
}

function authorityFrom(frame: Readonly<PitchObservation>): ResonanceObservationAuthority {
  return {
    captureEpoch: frame.captureEpoch,
    continuityEpoch: frame.continuityEpoch,
    graphGeneration: frame.graphGeneration,
    sampleRate: frame.sampleRate,
    startSample: frame.startSample,
    endSample: frame.endSample,
  };
}

export function resonanceAuthorityChanged(
  previous: Readonly<ResonanceObservationAuthority> | null,
  frame: Readonly<PitchObservation>,
): boolean {
  return previous === null
    || frame.discontinuity
    || previous.captureEpoch !== frame.captureEpoch
    || previous.continuityEpoch !== frame.continuityEpoch
    || previous.graphGeneration !== frame.graphGeneration
    || previous.sampleRate !== frame.sampleRate;
}

function isDuplicateOrReordered(
  previous: Readonly<ResonanceObservationAuthority> | null,
  frame: Readonly<PitchObservation>,
): boolean {
  return previous !== null
    && !resonanceAuthorityChanged(previous, frame)
    && frame.endSample <= previous.endSample;
}

function credibleVoicedFrame(frame: Readonly<PitchObservation>): boolean {
  return frame.observationKind === "voiced"
    && frame.voiced
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat)
    && frame.midiFloat >= 0
    && frame.midiFloat <= 127
    && frame.frequencyHz !== null
    && Number.isFinite(frame.frequencyHz)
    && frame.frequencyHz > 0
    && Number.isFinite(frame.confidence)
    && frame.confidence >= 0
    && frame.confidence <= 1
    && Number.isFinite(frame.periodicity)
    && frame.periodicity >= 0
    && frame.periodicity <= 1;
}

function pitchStability(
  history: readonly ResonancePitchEvidence[],
  options: Readonly<ResolvedResonanceControllerOptions>,
): number {
  if (history.length <= 1) return history.length;
  const pitches = history.map((observation) => observation.midiFloat);
  const spreadCents = (quantile(pitches, 0.9) - quantile(pitches, 0.1)) * 100;
  return 1 - smoothstep(
    options.stableSpreadCents,
    options.unstableSpreadCents,
    spreadCents,
  );
}

function clearCurrentEvidence(
  state: Readonly<ResonanceControllerState>,
  frame: Readonly<PitchObservation>,
  status: ResonanceControllerStatus,
  authorityChanged: boolean,
): ResonanceControllerState {
  return {
    ...state,
    status,
    pitchHistory: authorityChanged ? [] : state.pitchHistory,
    midiFloat: null,
    frequencyHz: null,
    confidence: clamp01(frame.confidence),
    periodicity: clamp01(frame.periodicity),
    stability: 0,
    coherence: 0,
    normalizedLevel: 0,
    drive: 0,
    evidenceReliable: false,
    authority: authorityFrom(frame),
    observedFrameCount: state.observedFrameCount + 1,
  };
}

export function createResonanceController(
  options: Readonly<ResonanceControllerOptions> = {},
): ResonanceControllerState {
  return {
    options: resolveOptions(options),
    status: "idle",
    pitchHistory: [],
    midiFloat: null,
    frequencyHz: null,
    confidence: 0,
    periodicity: 0,
    stability: 0,
    coherence: 0,
    normalizedLevel: 0,
    drive: 0,
    evidenceReliable: false,
    authority: null,
    observedFrameCount: 0,
    reliableFrameCount: 0,
  };
}

/** Clear observation authority between runs without creating an audio lifecycle. */
export function resetResonanceController(
  state: Readonly<ResonanceControllerState>,
): ResonanceControllerState {
  return createResonanceController(state.options);
}

/**
 * Reduce exactly one immutable detector observation. There is no wall clock,
 * freshness watchdog, release tail, prompt exclusion, or amplitude admission.
 */
export function updateResonanceControllerFromFrame(
  state: Readonly<ResonanceControllerState>,
  frame: Readonly<PitchObservation>,
): ResonanceControllerFrameUpdate {
  if (!validAuthority(frame)) {
    return {
      state: state as ResonanceControllerState,
      accepted: false,
      duplicate: false,
      authorityChanged: false,
    };
  }
  if (isDuplicateOrReordered(state.authority, frame)) {
    return {
      state: state as ResonanceControllerState,
      accepted: false,
      duplicate: true,
      authorityChanged: false,
    };
  }

  const authorityChanged = resonanceAuthorityChanged(state.authority, frame);
  if (!credibleVoicedFrame(frame)) {
    const status = frame.observationKind === "unvoiced" ? "unvoiced" : "uncertain";
    return {
      accepted: false,
      duplicate: false,
      authorityChanged,
      state: clearCurrentEvidence(state, frame, status, authorityChanged),
    };
  }

  const historyFloor = frame.endSample
    - Math.round(frame.sampleRate * state.options.stabilityWindowSeconds);
  const retainedHistory = authorityChanged
    ? []
    : state.pitchHistory.filter((evidence) => (
        evidence.captureEpoch === frame.captureEpoch
        && evidence.continuityEpoch === frame.continuityEpoch
        && evidence.sampleRate === frame.sampleRate
        && evidence.endSample >= historyFloor
      ));
  const pitchHistory = [
    ...retainedHistory,
    {
      captureEpoch: frame.captureEpoch,
      continuityEpoch: frame.continuityEpoch,
      endSample: frame.endSample,
      sampleRate: frame.sampleRate,
      midiFloat: frame.midiFloat!,
    },
  ].slice(-MAXIMUM_PITCH_HISTORY);
  const stability = pitchStability(pitchHistory, state.options);
  const periodicity = clamp01(frame.periodicity);
  const confidence = clamp01(frame.confidence);
  const coherence = Math.sqrt(clamp01(periodicity * stability));
  const drive = MINIMUM_VOICED_DRIVE + (1 - MINIMUM_VOICED_DRIVE) * coherence;

  return {
    accepted: true,
    duplicate: false,
    authorityChanged,
    state: {
      ...state,
      status: "driving",
      pitchHistory,
      midiFloat: frame.midiFloat,
      frequencyHz: frame.frequencyHz,
      confidence,
      periodicity,
      stability,
      coherence,
      normalizedLevel: VOICED_FIELD_LEVEL,
      drive,
      evidenceReliable: true,
      authority: authorityFrom(frame),
      observedFrameCount: state.observedFrameCount + 1,
      reliableFrameCount: state.reliableFrameCount + 1,
    },
  };
}

/** Adapter from derived pitch evidence into deterministic room physics. */
export function toResonanceVoiceInput(
  state: Readonly<ResonanceControllerState>,
): ResonanceVoiceInput {
  const active = state.evidenceReliable
    && state.midiFloat !== null
    && state.frequencyHz !== null;
  return {
    voiced: active,
    midiFloat: active ? state.midiFloat : null,
    frequencyHz: active ? state.frequencyHz : null,
    normalizedLevel: active ? state.normalizedLevel : 0,
    coherentDrive: active ? state.drive : 0,
    confidence: active ? state.confidence : 0,
    stability: active ? state.stability : 0,
  };
}
