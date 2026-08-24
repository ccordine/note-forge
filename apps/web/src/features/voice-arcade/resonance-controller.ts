import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { amplitudeToDbfs } from "../../audio/input-analysis";
import type { ResonanceVoiceInput } from "./resonance-physics";

/**
 * Evidence validity belongs to the shared microphone pipeline, not game
 * difficulty. Resonance may tighten its puzzle bandwidth, but it may never
 * lower this detector floor to make a level easier.
 */
export const RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE = 0.58;

/** A short, implicit session reference; it has no pass/fail state. */
export const RESONANCE_REFERENCE_FRAME_COUNT = 8;

export type ResonanceControllerStatus =
  | "idle"
  | "coupling"
  | "driving"
  | "unvoiced"
  | "uncertain"
  | "releasing"
  | "stale";

export type ResonanceControlFrame = Pick<
  YinPitchFrame,
  | "timeSeconds"
  | "frequencyHz"
  | "midiFloat"
  | "rms"
  | "confidence"
  | "voiced"
  | "detector"
  | "reason"
>;

export interface ResonanceControllerOptions {
  /** Seconds of reliable pitch retained when estimating recent stability. */
  readonly stabilityWindowSeconds?: number;
  /** Recent pitch spread at or below this value receives full stability. */
  readonly stableSpreadCents?: number;
  /** Recent pitch spread at or above this value receives zero stability. */
  readonly unstableSpreadCents?: number;
  /** Relative level below the session reference that maps to zero. */
  readonly quietRangeDb?: number;
  /** Relative level above the session reference that maps to one. */
  readonly loudRangeDb?: number;
  /** Exponential attack rate, in inverse seconds. */
  readonly attackPerSecond?: number;
  /** Exponential release rate, in inverse seconds. */
  readonly releasePerSecond?: number;
  /** Maximum wall-clock age of the latest reliable observation. */
  readonly freshnessSeconds?: number;
}

export interface ResolvedResonanceControllerOptions {
  readonly stabilityWindowSeconds: number;
  readonly stableSpreadCents: number;
  readonly unstableSpreadCents: number;
  readonly quietRangeDb: number;
  readonly loudRangeDb: number;
  readonly attackPerSecond: number;
  readonly releasePerSecond: number;
  readonly freshnessSeconds: number;
}

export interface ResonancePitchObservation {
  readonly timeSeconds: number;
  readonly midiFloat: number;
}

export interface ResonanceControllerState {
  readonly options: ResolvedResonanceControllerOptions;
  readonly status: ResonanceControllerStatus;
  /** Median reference collected from the first eight reliable voiced frames. */
  readonly referenceDbfs: number | null;
  readonly referenceLocked: boolean;
  readonly referenceSamplesDbfs: readonly number[];
  /** Zero through one; the implicit reference becomes fully coupled at 8/8. */
  readonly coupling: number;
  readonly pitchHistory: readonly ResonancePitchObservation[];
  /** Latest reliable interpreted pitch, retained briefly through release. */
  readonly midiFloat: number | null;
  readonly frequencyHz: number | null;
  /** Latest reliable YIN confidence. */
  readonly confidence: number;
  /** YIN periodicity mapped onto zero through one. */
  readonly periodicity: number;
  /** Recent interpreted-pitch stability mapped onto zero through one. */
  readonly stability: number;
  /** Geometric combination of periodicity and stability. */
  readonly coherence: number;
  /** Current level relative to the session reference, before smoothing. */
  readonly relativeDb: number | null;
  /** Current bounded level request, including nonblocking coupling ramp. */
  readonly targetNormalizedLevel: number;
  /** Attack/release-smoothed level suitable for the physics input. */
  readonly normalizedLevel: number;
  /** Coherence-weighted target drive. */
  readonly targetDrive: number;
  /** Attack/release-smoothed bounded drive, useful for UI and proofs. */
  readonly drive: number;
  readonly evidenceReliable: boolean;
  readonly lastFrameTimeSeconds: number | null;
  readonly lastReliableReceivedAtSeconds: number | null;
  readonly observedFrameCount: number;
  readonly reliableFrameCount: number;
}

export interface ResonanceControllerFrameUpdate {
  readonly state: ResonanceControllerState;
  readonly accepted: boolean;
  readonly duplicate: boolean;
}

export interface AdvanceResonanceControllerOptions {
  readonly nowSeconds: number;
  readonly deltaSeconds: number;
}

export interface ResetResonanceControllerOptions {
  /**
   * Keep the nonblocking session-relative comfort reference while clearing all
   * pitch, smoothing, freshness, and force state for the next puzzle.
   */
  readonly retainReference?: boolean;
}

const DEFAULT_OPTIONS = Object.freeze({
  stabilityWindowSeconds: 0.55,
  stableSpreadCents: 8,
  unstableSpreadCents: 50,
  quietRangeDb: 12,
  loudRangeDb: 6,
  attackPerSecond: 8,
  releasePerSecond: 18,
  freshnessSeconds: 0.35,
}) satisfies Readonly<ResolvedResonanceControllerOptions>;

const EPSILON = 1e-9;
const OUTPUT_EPSILON = 1e-5;
const MAXIMUM_PITCH_HISTORY = 32;
const EXPLICIT_UNVOICED_REASONS = new Set<YinPitchFrame["reason"]>([
  "below-rms-threshold",
  "no-periodic-candidate",
]);

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
  requirePositive(resolved.quietRangeDb, "Resonance quiet range");
  requirePositive(resolved.loudRangeDb, "Resonance loud range");
  requirePositive(resolved.attackPerSecond, "Resonance attack rate");
  requirePositive(resolved.releasePerSecond, "Resonance release rate");
  requirePositive(resolved.freshnessSeconds, "Resonance freshness duration");
  if (resolved.stableSpreadCents >= resolved.unstableSpreadCents) {
    throw new RangeError("Resonance stable spread must be below unstable spread.");
  }
  return Object.freeze(resolved);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
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

function frameIsReliable(frame: Readonly<ResonanceControlFrame>): boolean {
  return frame.detector === "yin"
    && frame.reason === "detected"
    && frame.voiced
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat)
    && frame.midiFloat >= 0
    && frame.midiFloat <= 127
    && frame.frequencyHz !== null
    && Number.isFinite(frame.frequencyHz)
    && frame.frequencyHz > 0
    && Number.isFinite(frame.rms)
    && frame.rms > 0
    && Number.isFinite(frame.confidence)
    && frame.confidence <= 1
    && frame.confidence >= RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE;
}

function uncertainStatus(frame: Readonly<ResonanceControlFrame>): ResonanceControllerStatus {
  return !frame.voiced && EXPLICIT_UNVOICED_REASONS.has(frame.reason)
    ? "unvoiced"
    : "uncertain";
}

function pitchStability(
  history: readonly ResonancePitchObservation[],
  options: Readonly<ResolvedResonanceControllerOptions>,
): number {
  if (history.length === 0) return 0;
  const maturity = clamp01(history.length / 4);
  if (history.length === 1) return maturity;
  const pitches = history.map((observation) => observation.midiFloat);
  // The interdecile spread resists one edge-window interpolation wobble while
  // still exposing repeated adjacent-frame jitter.
  const spreadCents = (quantile(pitches, 0.9) - quantile(pitches, 0.1)) * 100;
  const accuracy = 1 - smoothstep(
    options.stableSpreadCents,
    options.unstableSpreadCents,
    spreadCents,
  );
  return clamp01(maturity * accuracy);
}

export function createResonanceController(
  options: Readonly<ResonanceControllerOptions> = {},
): ResonanceControllerState {
  return {
    options: resolveOptions(options),
    status: "idle",
    referenceDbfs: null,
    referenceLocked: false,
    referenceSamplesDbfs: [],
    coupling: 0,
    pitchHistory: [],
    midiFloat: null,
    frequencyHz: null,
    confidence: 0,
    periodicity: 0,
    stability: 0,
    coherence: 0,
    relativeDb: null,
    targetNormalizedLevel: 0,
    normalizedLevel: 0,
    targetDrive: 0,
    drive: 0,
    evidenceReliable: false,
    lastFrameTimeSeconds: null,
    lastReliableReceivedAtSeconds: null,
    observedFrameCount: 0,
    reliableFrameCount: 0,
  };
}

/**
 * Start a clean puzzle controller. Tutorial sequences may retain only the
 * already-derived comfort reference; no pitch history or stale force crosses
 * the puzzle boundary.
 */
export function resetResonanceController(
  state: Readonly<ResonanceControllerState>,
  options: Readonly<ResetResonanceControllerOptions> = {},
): ResonanceControllerState {
  const fresh = createResonanceController(state.options);
  if (!options.retainReference || state.referenceSamplesDbfs.length === 0) return fresh;
  return {
    ...fresh,
    referenceDbfs: state.referenceDbfs,
    referenceLocked: state.referenceLocked,
    referenceSamplesDbfs: [...state.referenceSamplesDbfs],
    coupling: state.coupling,
  };
}

/**
 * Consume one interpreted, derived YIN observation. No PCM, device identity, or
 * canonical pitch evidence enters this state machine.
 */
export function updateResonanceControllerFromFrame(
  state: Readonly<ResonanceControllerState>,
  frame: Readonly<ResonanceControlFrame>,
  receivedAtSeconds: number,
): ResonanceControllerFrameUpdate {
  if (!Number.isFinite(receivedAtSeconds) || receivedAtSeconds < 0) {
    throw new RangeError("Resonance evidence receipt timestamp must be finite and non-negative.");
  }
  if (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0) {
    return { state: state as ResonanceControllerState, accepted: false, duplicate: false };
  }
  if (state.lastFrameTimeSeconds !== null
    && frame.timeSeconds <= state.lastFrameTimeSeconds + EPSILON) {
    return { state: state as ResonanceControllerState, accepted: false, duplicate: true };
  }

  const observedFrameCount = state.observedFrameCount + 1;
  if (!frameIsReliable(frame)) {
    return {
      accepted: false,
      duplicate: false,
      state: {
        ...state,
        status: uncertainStatus(frame),
        targetNormalizedLevel: 0,
        targetDrive: 0,
        evidenceReliable: false,
        lastFrameTimeSeconds: frame.timeSeconds,
        observedFrameCount,
      },
    };
  }

  const levelDbfs = amplitudeToDbfs(frame.rms);
  const referenceSamplesDbfs = state.referenceLocked
    ? state.referenceSamplesDbfs
    : [...state.referenceSamplesDbfs, levelDbfs].slice(0, RESONANCE_REFERENCE_FRAME_COUNT);
  const referenceDbfs = median(referenceSamplesDbfs);
  const referenceLocked = referenceSamplesDbfs.length >= RESONANCE_REFERENCE_FRAME_COUNT;
  const coupling = clamp01(referenceSamplesDbfs.length / RESONANCE_REFERENCE_FRAME_COUNT);
  const relativeDb = levelDbfs - referenceDbfs;
  const normalizedIntensity = clamp01(
    (relativeDb + state.options.quietRangeDb)
      / (state.options.quietRangeDb + state.options.loudRangeDb),
  );
  const pitchHistory = [
    ...state.pitchHistory.filter((observation) => (
      frame.timeSeconds - observation.timeSeconds <= state.options.stabilityWindowSeconds + EPSILON
    )),
    { timeSeconds: frame.timeSeconds, midiFloat: frame.midiFloat! },
  ].slice(-MAXIMUM_PITCH_HISTORY);
  const periodicity = smoothstep(
    RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE,
    0.95,
    frame.confidence,
  );
  const stability = pitchStability(pitchHistory, state.options);
  const coherence = Math.sqrt(clamp01(periodicity * stability));
  const targetNormalizedLevel = clamp01(coupling * normalizedIntensity);
  const targetDrive = clamp01(targetNormalizedLevel * coherence * coherence);

  return {
    accepted: true,
    duplicate: false,
    state: {
      ...state,
      status: referenceLocked ? "driving" : "coupling",
      referenceDbfs,
      referenceLocked,
      referenceSamplesDbfs,
      coupling,
      pitchHistory,
      midiFloat: frame.midiFloat,
      frequencyHz: frame.frequencyHz,
      confidence: frame.confidence,
      periodicity,
      stability,
      coherence,
      relativeDb,
      targetNormalizedLevel,
      targetDrive,
      evidenceReliable: true,
      lastFrameTimeSeconds: frame.timeSeconds,
      lastReliableReceivedAtSeconds: receivedAtSeconds,
      observedFrameCount,
      reliableFrameCount: state.reliableFrameCount + 1,
    },
  };
}

function approach(
  current: number,
  target: number,
  deltaSeconds: number,
  attackPerSecond: number,
  releasePerSecond: number,
): number {
  const rate = target >= current ? attackPerSecond : releasePerSecond;
  const alpha = 1 - Math.exp(-deltaSeconds * rate);
  const next = clamp01(current + (target - current) * alpha);
  return Math.abs(next - target) <= OUTPUT_EPSILON ? target : next;
}

/** Advance smoothed force on the game clock and expire stale evidence. */
export function advanceResonanceController(
  state: Readonly<ResonanceControllerState>,
  options: Readonly<AdvanceResonanceControllerOptions>,
): ResonanceControllerState {
  if (!Number.isFinite(options.nowSeconds) || options.nowSeconds < 0) {
    throw new RangeError("Resonance current timestamp must be finite and non-negative.");
  }
  if (!Number.isFinite(options.deltaSeconds) || options.deltaSeconds < 0) {
    throw new RangeError("Resonance frame delta must be finite and non-negative.");
  }

  const stale = state.lastReliableReceivedAtSeconds !== null
    && options.nowSeconds - state.lastReliableReceivedAtSeconds
      > state.options.freshnessSeconds + EPSILON;
  const targetNormalizedLevel = stale ? 0 : state.targetNormalizedLevel;
  const targetDrive = stale ? 0 : state.targetDrive;
  const normalizedLevel = approach(
    state.normalizedLevel,
    targetNormalizedLevel,
    options.deltaSeconds,
    state.options.attackPerSecond,
    state.options.releasePerSecond,
  );
  const drive = approach(
    state.drive,
    targetDrive,
    options.deltaSeconds,
    state.options.attackPerSecond,
    state.options.releasePerSecond,
  );
  const releasing = targetDrive <= OUTPUT_EPSILON && drive > OUTPUT_EPSILON;
  const status: ResonanceControllerStatus = stale
    ? "stale"
    : releasing
      ? "releasing"
      : state.status;

  if (!stale
    && normalizedLevel === state.normalizedLevel
    && drive === state.drive
    && status === state.status) return state as ResonanceControllerState;

  return {
    ...state,
    status,
    targetNormalizedLevel,
    normalizedLevel,
    targetDrive,
    drive,
    ...(stale ? { evidenceReliable: false } : {}),
  };
}

/** Adapter for the stable, derived-only room-physics contract. */
export function toResonanceVoiceInput(
  state: Readonly<ResonanceControllerState>,
): ResonanceVoiceInput {
  const active = state.drive > OUTPUT_EPSILON
    && state.normalizedLevel > OUTPUT_EPSILON
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

/**
 * Tutorial-only evidence adapter. Unlike production force, it preserves a
 * reliable observation even when coherence-weighted drive is zero so an
 * authored lesson can explicitly normalize coherence. The tutorial policy
 * still decides whether that axis is ignored or graded; confidence, pitch,
 * and the session-relative level floor are never fabricated here.
 */
export function toResonanceTutorialVoiceEvidence(
  state: Readonly<ResonanceControllerState>,
): ResonanceVoiceInput {
  const active = state.evidenceReliable
    && state.normalizedLevel > OUTPUT_EPSILON
    && state.midiFloat !== null
    && state.frequencyHz !== null;
  return {
    voiced: active,
    midiFloat: active ? state.midiFloat : null,
    frequencyHz: active ? state.frequencyHz : null,
    normalizedLevel: active ? state.normalizedLevel : 0,
    coherentDrive: active ? state.normalizedLevel * state.coherence : 0,
    confidence: active ? state.confidence : 0,
    stability: active ? state.stability : 0,
  };
}
