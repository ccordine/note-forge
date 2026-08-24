import type { YinPitchFrame } from "@noteforge/pitch-engine";
import {
  mapPitchToNormalizedVertical,
  type PitchVerticalMapping,
} from "./model";

/**
 * Evidence validity is a property of the microphone pipeline, not curriculum
 * difficulty. Games may change their mapping and response, but not this floor.
 */
export const VOICE_AXIS_MINIMUM_CONFIDENCE = 0.55;

export type VoiceAxisStatus =
  | "idle"
  | "steering"
  | "unvoiced"
  | "uncertain";

export type VoiceAxisFrame = Pick<
  YinPitchFrame,
  "timeSeconds" | "midiFloat" | "confidence" | "voiced" | "detector" | "reason"
>;

export interface VoiceAxisControllerOptions {
  readonly lowMidi: number;
  readonly highMidi: number;
  readonly centerMidi?: number;
  readonly deadZoneCents?: number;
  readonly invert?: boolean;
  /** Exponential convergence rate in inverse seconds. */
  readonly responsePerSecond: number;
  readonly initialPosition?: number;
}

export interface ResolvedVoiceAxisControllerOptions {
  readonly lowMidi: number;
  readonly highMidi: number;
  readonly centerMidi: number;
  readonly deadZoneCents: number;
  readonly invert: boolean;
  readonly responsePerSecond: number;
  readonly initialPosition: number;
}

export interface VoiceAxisControllerState {
  readonly options: ResolvedVoiceAxisControllerOptions;
  readonly status: VoiceAxisStatus;
  readonly position: number;
  readonly targetPosition: number;
  readonly pitchMidi: number | null;
  readonly clampedMidi: number | null;
  readonly inDeadZone: boolean;
  readonly lastFrameTimeSeconds: number | null;
  readonly observedFrameCount: number;
  readonly acceptedFrameCount: number;
}

export interface VoiceAxisFrameUpdate {
  readonly state: VoiceAxisControllerState;
  readonly accepted: boolean;
  readonly mapping: PitchVerticalMapping | null;
}

export interface AdvanceVoiceAxisOptions {
  readonly deltaSeconds: number;
}

const EPSILON = 1e-9;
const EXPLICIT_UNVOICED_REASONS = new Set<YinPitchFrame["reason"]>([
  "below-rms-threshold",
  "no-periodic-candidate",
]);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero.`);
}

function resolveOptions(
  options: Readonly<VoiceAxisControllerOptions>,
): ResolvedVoiceAxisControllerOptions {
  if (!options || typeof options !== "object") {
    throw new TypeError("Voice axis controller options are required.");
  }
  requireFinite(options.lowMidi, "Voice axis low MIDI");
  requireFinite(options.highMidi, "Voice axis high MIDI");
  if (options.lowMidi >= options.highMidi) {
    throw new RangeError("Voice axis high MIDI must be above low MIDI.");
  }
  const centerMidi = options.centerMidi ?? (options.lowMidi + options.highMidi) / 2;
  const deadZoneCents = options.deadZoneCents ?? 0;
  const initialPosition = options.initialPosition ?? 0.5;
  requireFinite(centerMidi, "Voice axis center MIDI");
  requireFinite(deadZoneCents, "Voice axis dead zone");
  requireFinite(initialPosition, "Voice axis initial position");
  requirePositive(options.responsePerSecond, "Voice axis response");
  if (deadZoneCents < 0) throw new RangeError("Voice axis dead zone cannot be negative.");
  if (initialPosition < 0 || initialPosition > 1) {
    throw new RangeError("Voice axis initial position must be from zero through one.");
  }

  // Reuse the canonical pitch mapping as the final authority on center/dead-zone
  // geometry. This also keeps every future analog game identical to Pong.
  mapPitchToNormalizedVertical(centerMidi, {
    lowMidi: options.lowMidi,
    highMidi: options.highMidi,
    centerMidi,
    deadZoneCents,
    invert: options.invert,
  });

  return Object.freeze({
    lowMidi: options.lowMidi,
    highMidi: options.highMidi,
    centerMidi,
    deadZoneCents,
    invert: options.invert === true,
    responsePerSecond: options.responsePerSecond,
    initialPosition,
  });
}

export function createVoiceAxisController(
  options: Readonly<VoiceAxisControllerOptions>,
): VoiceAxisControllerState {
  const resolved = resolveOptions(options);
  return {
    options: resolved,
    status: "idle",
    position: resolved.initialPosition,
    targetPosition: resolved.initialPosition,
    pitchMidi: null,
    clampedMidi: null,
    inDeadZone: false,
    lastFrameTimeSeconds: null,
    observedFrameCount: 0,
    acceptedFrameCount: 0,
  };
}

/** Canonical YIN frames steer only after this game applies its local confidence rule. */
export function isVoiceAxisFrameReliable(frame: Readonly<VoiceAxisFrame>): boolean {
  return frame.detector === "yin"
    && frame.reason === "detected"
    && frame.voiced
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat)
    && Number.isFinite(frame.confidence)
    && frame.confidence >= VOICE_AXIS_MINIMUM_CONFIDENCE;
}

function frozenStatusFor(frame: Readonly<VoiceAxisFrame>): VoiceAxisStatus {
  return !frame.voiced && EXPLICIT_UNVOICED_REASONS.has(frame.reason)
    ? "unvoiced"
    : "uncertain";
}

/**
 * Consume one interpreted pitch frame. Silence and uncertain evidence freeze
 * immediately; neither can pull the axis toward center or its previous target.
 * The detector's monotonic sample time is the only observation clock.
 */
export function updateVoiceAxisFromFrame(
  state: Readonly<VoiceAxisControllerState>,
  frame: Readonly<VoiceAxisFrame>,
): VoiceAxisFrameUpdate {
  if (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0) {
    return { state: state as VoiceAxisControllerState, accepted: false, mapping: null };
  }
  if (state.lastFrameTimeSeconds !== null
    && frame.timeSeconds <= state.lastFrameTimeSeconds + EPSILON) {
    return { state: state as VoiceAxisControllerState, accepted: false, mapping: null };
  }

  const observedFrameCount = state.observedFrameCount + 1;
  if (!isVoiceAxisFrameReliable(frame)) {
    return {
      accepted: false,
      mapping: null,
      state: {
        ...state,
        status: frozenStatusFor(frame),
        targetPosition: state.position,
        pitchMidi: null,
        clampedMidi: null,
        inDeadZone: false,
        lastFrameTimeSeconds: frame.timeSeconds,
        observedFrameCount,
      },
    };
  }

  const mapping = mapPitchToNormalizedVertical(frame.midiFloat!, {
    lowMidi: state.options.lowMidi,
    highMidi: state.options.highMidi,
    centerMidi: state.options.centerMidi,
    deadZoneCents: state.options.deadZoneCents,
    invert: state.options.invert,
  });
  return {
    accepted: true,
    mapping,
    state: {
      ...state,
      status: "steering",
      targetPosition: mapping.normalizedY,
      pitchMidi: frame.midiFloat,
      clampedMidi: mapping.clampedMidi,
      inDeadZone: mapping.inDeadZone,
      lastFrameTimeSeconds: frame.timeSeconds,
      observedFrameCount,
      acceptedFrameCount: state.acceptedFrameCount + 1,
    },
  };
}

/** Freeze deliberately while preserving the exact current axis coordinate. */
export function freezeVoiceAxisController(
  state: Readonly<VoiceAxisControllerState>,
): VoiceAxisControllerState {
  if (state.status === "idle"
    && state.targetPosition === state.position
    && state.pitchMidi === null) return state as VoiceAxisControllerState;
  return {
    ...state,
    status: "idle",
    targetPosition: state.position,
    pitchMidi: null,
    clampedMidi: null,
    inDeadZone: false,
  };
}

/**
 * Advance the bounded coordinate on the game's clock. PCM observations—not a
 * wall-clock watchdog—freeze steering when the source becomes unvoiced or
 * uncertain. A transport failure remains the audio subsystem's responsibility.
 */
export function advanceVoiceAxisController(
  state: Readonly<VoiceAxisControllerState>,
  options: Readonly<AdvanceVoiceAxisOptions>,
): VoiceAxisControllerState {
  requireFinite(options.deltaSeconds, "Voice axis frame delta");
  if (options.deltaSeconds < 0) throw new RangeError("Voice axis frame delta cannot be negative.");

  if (state.status !== "steering") return state as VoiceAxisControllerState;

  const response = 1 - Math.exp(-options.deltaSeconds * state.options.responsePerSecond);
  return {
    ...state,
    position: clamp(
      state.position + (state.targetPosition - state.position) * response,
      0,
      1,
    ),
  };
}
