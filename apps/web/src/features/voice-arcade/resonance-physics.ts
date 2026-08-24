import { frequencyToMidi, midiToFrequency } from "@noteforge/music-core";

/**
 * Deterministic, deliberately stylized acoustic puzzle physics.
 *
 * This module does not inspect PCM and does not claim to simulate real room
 * acoustics. It consumes pitch, confidence, stability, and a caller-normalized
 * level from the established microphone pipeline, then turns that evidence
 * into a repeatable pressure-field game mechanic.
 */

export interface ResonanceVector {
  readonly x: number;
  readonly y: number;
}

export interface ResonanceRoom {
  readonly width: number;
  readonly height: number;
}

export interface ResonanceObstacle {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Fraction of visualized pressure transmitted through this obstacle. */
  readonly acousticTransmission?: number;
}

export interface ResonanceBallDefinition {
  readonly position: ResonanceVector;
  readonly velocity?: ResonanceVector;
  readonly radius: number;
  readonly mass?: number;
  readonly restitution?: number;
  readonly linearDamping?: number;
}

export interface ResonanceGoal {
  readonly position: ResonanceVector;
  readonly radius: number;
}

export interface ResonanceMicrophoneSource {
  readonly position: ResonanceVector;
  /** Force produced by fully coherent, efficiently normalized input. */
  readonly gain: number;
  /** Distance at which direct pressure has fallen to half strength. */
  readonly falloffRadius: number;
  /** Optional forward axis for a directional microphone visualization. */
  readonly direction?: ResonanceVector;
  /** Zero is omnidirectional; one rejects all pressure behind `direction`. */
  readonly directivity?: number;
}

export type ResonanceForceMode = "repel" | "attract" | "directional";

export interface FrequencyTunedResonator {
  readonly id: string;
  readonly position: ResonanceVector;
  readonly targetMidi: number;
  /** Gaussian pitch-response width. This is not a hard pass/fail lane. */
  readonly bandwidthCents: number;
  readonly gain: number;
  readonly influenceRadius: number;
  readonly mode: ResonanceForceMode;
  /** Required and used only for directional resonators. */
  readonly direction?: ResonanceVector;
}

export interface ResonanceLevelDefinition {
  readonly id: string;
  readonly room: ResonanceRoom;
  readonly obstacles: readonly ResonanceObstacle[];
  readonly ball: ResonanceBallDefinition;
  readonly goal: ResonanceGoal;
  readonly microphone: ResonanceMicrophoneSource;
  readonly resonators: readonly FrequencyTunedResonator[];
}

export interface ResonancePhysicsOptions {
  readonly fixedStepSeconds?: number;
  readonly maximumFrameDeltaSeconds?: number;
  readonly maximumSpeed?: number;
  readonly maximumForce?: number;
  readonly waveSpeed?: number;
  readonly waveIntervalSeconds?: number;
  readonly waveShellWidth?: number;
  readonly maximumWavePulses?: number;
}

export interface ResolvedResonancePhysicsOptions {
  readonly fixedStepSeconds: number;
  readonly maximumFrameDeltaSeconds: number;
  readonly maximumSpeed: number;
  readonly maximumForce: number;
  readonly waveSpeed: number;
  readonly waveIntervalSeconds: number;
  readonly waveShellWidth: number;
  readonly maximumWavePulses: number;
}

/** Caller-normalized, interpreted microphone evidence. */
export interface ResonanceVoiceInput {
  readonly voiced: boolean;
  readonly midiFloat: number | null;
  readonly frequencyHz: number | null;
  /** Mapped by the caller onto zero through one. */
  readonly normalizedLevel: number;
  /**
   * Authoritative, attack/release-smoothed level x coherence request from the
   * voice controller. Physics may shape its level efficiency, but it must
   * never manufacture energy when this value is zero.
   */
  readonly coherentDrive: number;
  /** Detector/interpreter confidence on zero through one. */
  readonly confidence: number;
  /** Caller-provided recent pitch stability on zero through one. */
  readonly stability: number;
}

export interface ResonanceVoiceEvaluation {
  readonly active: boolean;
  readonly midiFloat: number | null;
  readonly frequencyHz: number | null;
  readonly normalizedLevel: number;
  readonly coherentDrive: number;
  readonly effectiveIntensity: number;
  readonly confidence: number;
  readonly stability: number;
  readonly evidenceCoherence: number;
  readonly directEnergy: number;
}

export interface ResonatorActivation {
  readonly resonatorId: string;
  readonly targetMidi: number;
  readonly centsError: number | null;
  readonly pitchAccuracy: number;
  readonly coherence: number;
  readonly effectiveEnergy: number;
}

export type ResonanceWaveOriginKind = "microphone" | "resonator";

export interface ResonanceWavePulse {
  readonly id: number;
  readonly originKind: ResonanceWaveOriginKind;
  readonly originId: string;
  readonly origin: ResonanceVector;
  readonly radius: number;
  readonly ageSeconds: number;
  readonly amplitude: number;
  readonly pitchMidi: number | null;
  readonly targetMidi: number | null;
  readonly coherence: number;
}

export interface ResonanceBallState {
  readonly position: ResonanceVector;
  readonly velocity: ResonanceVector;
  readonly radius: number;
  readonly mass: number;
  readonly restitution: number;
  readonly linearDamping: number;
}

export type ResonanceGameStatus = "playing" | "won";

export interface ResonanceGameState {
  readonly level: ResonanceLevelDefinition;
  readonly options: ResolvedResonancePhysicsOptions;
  readonly status: ResonanceGameStatus;
  readonly ball: ResonanceBallState;
  readonly voice: ResonanceVoiceEvaluation;
  readonly resonatorActivations: readonly ResonatorActivation[];
  readonly wavePulses: readonly ResonanceWavePulse[];
  readonly elapsedSeconds: number;
  readonly accumulatorSeconds: number;
  readonly droppedSeconds: number;
  readonly fixedStepCount: number;
  readonly collisionCount: number;
  readonly nextWaveId: number;
  readonly waveClockSeconds: number;
}

export interface ResonanceAdvanceResult {
  readonly state: ResonanceGameState;
  readonly simulatedSteps: number;
  readonly collisions: number;
  readonly wonThisAdvance: boolean;
}

export interface ResonanceFieldSample {
  /** Signed stylized pressure, useful for wave coloring. */
  readonly pressure: number;
  /** Sum of absolute pulse contributions. */
  readonly intensity: number;
  readonly gradient: ResonanceVector;
  readonly contributingPulses: number;
}

/** Fixed production/controller evidence floor; gameplay never weakens it. */
export const RESONANCE_MINIMUM_CONFIDENCE = 0.58;

const DEFAULT_OPTIONS: ResolvedResonancePhysicsOptions = Object.freeze({
  fixedStepSeconds: 1 / 120,
  maximumFrameDeltaSeconds: 0.25,
  maximumSpeed: 5,
  maximumForce: 24,
  waveSpeed: 5,
  waveIntervalSeconds: 0.12,
  waveShellWidth: 0.22,
  maximumWavePulses: 96,
});

const EPSILON = 1e-9;
const MAX_COLLISION_PASSES = 3;

const SILENT_INPUT: ResonanceVoiceInput = Object.freeze({
  voiced: false,
  midiFloat: null,
  frequencyHz: null,
  normalizedLevel: 0,
  coherentDrive: 0,
  confidence: 0,
  stability: 0,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
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

function vector(x: number, y: number): ResonanceVector {
  return { x, y };
}

function add(first: ResonanceVector, second: ResonanceVector): ResonanceVector {
  return vector(first.x + second.x, first.y + second.y);
}

function subtract(first: ResonanceVector, second: ResonanceVector): ResonanceVector {
  return vector(first.x - second.x, first.y - second.y);
}

function scale(value: ResonanceVector, scalar: number): ResonanceVector {
  return vector(value.x * scalar, value.y * scalar);
}

function dot(first: ResonanceVector, second: ResonanceVector): number {
  return first.x * second.x + first.y * second.y;
}

function magnitudeSquared(value: ResonanceVector): number {
  return dot(value, value);
}

function magnitude(value: ResonanceVector): number {
  return Math.sqrt(magnitudeSquared(value));
}

function normalize(value: ResonanceVector, fallback: ResonanceVector = vector(1, 0)): ResonanceVector {
  const length = magnitude(value);
  return length <= EPSILON ? fallback : scale(value, 1 / length);
}

function clampMagnitude(value: ResonanceVector, maximum: number): ResonanceVector {
  const length = magnitude(value);
  return length > maximum ? scale(value, maximum / length) : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const position = clamp01((value - edge0) / (edge1 - edge0));
  return position * position * (3 - 2 * position);
}

function distance(first: ResonanceVector, second: ResonanceVector): number {
  return magnitude(subtract(first, second));
}

function normalizeDirection(value: ResonanceVector | undefined, label: string): ResonanceVector | undefined {
  if (!value) return undefined;
  requireFinite(value.x, `${label} x`);
  requireFinite(value.y, `${label} y`);
  if (magnitudeSquared(value) <= EPSILON) {
    throw new RangeError(`${label} cannot be a zero vector.`);
  }
  return normalize(value);
}

function resolveOptions(
  options: Readonly<ResonancePhysicsOptions> = {},
): ResolvedResonancePhysicsOptions {
  const resolved = {
    fixedStepSeconds: options.fixedStepSeconds ?? DEFAULT_OPTIONS.fixedStepSeconds,
    maximumFrameDeltaSeconds:
      options.maximumFrameDeltaSeconds ?? DEFAULT_OPTIONS.maximumFrameDeltaSeconds,
    maximumSpeed: options.maximumSpeed ?? DEFAULT_OPTIONS.maximumSpeed,
    maximumForce: options.maximumForce ?? DEFAULT_OPTIONS.maximumForce,
    waveSpeed: options.waveSpeed ?? DEFAULT_OPTIONS.waveSpeed,
    waveIntervalSeconds: options.waveIntervalSeconds ?? DEFAULT_OPTIONS.waveIntervalSeconds,
    waveShellWidth: options.waveShellWidth ?? DEFAULT_OPTIONS.waveShellWidth,
    maximumWavePulses: options.maximumWavePulses ?? DEFAULT_OPTIONS.maximumWavePulses,
  };
  requirePositive(resolved.fixedStepSeconds, "Resonance fixed step");
  requirePositive(resolved.maximumFrameDeltaSeconds, "Resonance maximum frame delta");
  requirePositive(resolved.maximumSpeed, "Resonance maximum speed");
  requirePositive(resolved.maximumForce, "Resonance maximum force");
  requirePositive(resolved.waveSpeed, "Resonance wave speed");
  requirePositive(resolved.waveIntervalSeconds, "Resonance wave interval");
  requirePositive(resolved.waveShellWidth, "Resonance wave shell width");
  if (!Number.isInteger(resolved.maximumWavePulses) || resolved.maximumWavePulses < 1) {
    throw new RangeError("Resonance maximum wave pulses must be a positive integer.");
  }
  if (resolved.fixedStepSeconds > resolved.maximumFrameDeltaSeconds) {
    throw new RangeError("Resonance fixed step cannot exceed the maximum frame delta.");
  }
  return Object.freeze(resolved);
}

function validatePointInRoom(
  point: Readonly<ResonanceVector>,
  room: Readonly<ResonanceRoom>,
  label: string,
): void {
  requireFinite(point.x, `${label} x`);
  requireFinite(point.y, `${label} y`);
  if (point.x < 0 || point.x > room.width || point.y < 0 || point.y > room.height) {
    throw new RangeError(`${label} must be inside the room.`);
  }
}

function circleOverlapsObstacle(
  position: Readonly<ResonanceVector>,
  radius: number,
  obstacle: Readonly<ResonanceObstacle>,
): boolean {
  const nearestX = clamp(position.x, obstacle.x, obstacle.x + obstacle.width);
  const nearestY = clamp(position.y, obstacle.y, obstacle.y + obstacle.height);
  const dx = position.x - nearestX;
  const dy = position.y - nearestY;
  return dx * dx + dy * dy < radius * radius - EPSILON;
}

function cloneAndValidateLevel(level: Readonly<ResonanceLevelDefinition>): ResonanceLevelDefinition {
  if (!level || typeof level !== "object") {
    throw new TypeError("A Resonance level definition is required.");
  }
  if (typeof level.id !== "string" || level.id.length === 0) {
    throw new RangeError("Resonance level id cannot be empty.");
  }
  requirePositive(level.room.width, "Resonance room width");
  requirePositive(level.room.height, "Resonance room height");
  const room = Object.freeze({ width: level.room.width, height: level.room.height });

  requirePositive(level.ball.radius, "Resonance ball radius");
  const mass = level.ball.mass ?? 1;
  const restitution = level.ball.restitution ?? 0.45;
  const linearDamping = level.ball.linearDamping ?? 0.8;
  requirePositive(mass, "Resonance ball mass");
  requireNonNegative(restitution, "Resonance ball restitution");
  requireNonNegative(linearDamping, "Resonance ball damping");
  if (restitution > 1) throw new RangeError("Resonance ball restitution cannot exceed one.");
  validatePointInRoom(level.ball.position, room, "Resonance ball position");
  if (level.ball.position.x - level.ball.radius < 0
    || level.ball.position.x + level.ball.radius > room.width
    || level.ball.position.y - level.ball.radius < 0
    || level.ball.position.y + level.ball.radius > room.height) {
    throw new RangeError("Resonance ball must begin fully inside the room.");
  }
  const initialVelocity = level.ball.velocity ?? vector(0, 0);
  requireFinite(initialVelocity.x, "Resonance ball velocity x");
  requireFinite(initialVelocity.y, "Resonance ball velocity y");

  requirePositive(level.goal.radius, "Resonance goal radius");
  if (level.goal.radius + EPSILON < level.ball.radius) {
    throw new RangeError("Resonance goal must be at least as large as the ball.");
  }
  validatePointInRoom(level.goal.position, room, "Resonance goal position");
  if (level.goal.position.x - level.goal.radius < 0
    || level.goal.position.x + level.goal.radius > room.width
    || level.goal.position.y - level.goal.radius < 0
    || level.goal.position.y + level.goal.radius > room.height) {
    throw new RangeError("Resonance goal must fit inside the room.");
  }

  validatePointInRoom(level.microphone.position, room, "Resonance microphone position");
  requirePositive(level.microphone.gain, "Resonance microphone gain");
  requirePositive(level.microphone.falloffRadius, "Resonance microphone falloff radius");
  const directivity = level.microphone.directivity ?? 0;
  requireFinite(directivity, "Resonance microphone directivity");
  if (directivity < 0 || directivity > 1) {
    throw new RangeError("Resonance microphone directivity must be from zero through one.");
  }
  const microphoneDirection = normalizeDirection(
    level.microphone.direction,
    "Resonance microphone direction",
  );
  if (directivity > 0 && !microphoneDirection) {
    throw new RangeError("A directional Resonance microphone requires a direction.");
  }

  const ids = new Set<string>();
  const obstacles = level.obstacles.map((obstacle, index) => {
    if (typeof obstacle.id !== "string" || obstacle.id.length === 0 || ids.has(obstacle.id)) {
      throw new RangeError(`Resonance obstacle ${index + 1} needs a unique, nonempty id.`);
    }
    ids.add(obstacle.id);
    requireNonNegative(obstacle.x, `Resonance obstacle ${obstacle.id} x`);
    requireNonNegative(obstacle.y, `Resonance obstacle ${obstacle.id} y`);
    requirePositive(obstacle.width, `Resonance obstacle ${obstacle.id} width`);
    requirePositive(obstacle.height, `Resonance obstacle ${obstacle.id} height`);
    if (obstacle.x + obstacle.width > room.width + EPSILON
      || obstacle.y + obstacle.height > room.height + EPSILON) {
      throw new RangeError(`Resonance obstacle ${obstacle.id} must fit inside the room.`);
    }
    const acousticTransmission = obstacle.acousticTransmission ?? 0.2;
    requireFinite(acousticTransmission, `Resonance obstacle ${obstacle.id} transmission`);
    if (acousticTransmission < 0 || acousticTransmission > 1) {
      throw new RangeError(`Resonance obstacle ${obstacle.id} transmission must be zero through one.`);
    }
    if (circleOverlapsObstacle(level.ball.position, level.ball.radius, obstacle)) {
      throw new RangeError(`Resonance ball overlaps obstacle ${obstacle.id}.`);
    }
    if (circleOverlapsObstacle(level.goal.position, level.goal.radius, obstacle)) {
      throw new RangeError(`Resonance goal overlaps obstacle ${obstacle.id}.`);
    }
    return Object.freeze({ ...obstacle, acousticTransmission });
  });

  const resonators = level.resonators.map((resonator, index) => {
    if (typeof resonator.id !== "string" || resonator.id.length === 0 || ids.has(resonator.id)) {
      throw new RangeError(`Resonance resonator ${index + 1} needs a unique, nonempty id.`);
    }
    ids.add(resonator.id);
    validatePointInRoom(resonator.position, room, `Resonance resonator ${resonator.id}`);
    requireFinite(resonator.targetMidi, `Resonance resonator ${resonator.id} target MIDI`);
    if (resonator.targetMidi < 0 || resonator.targetMidi > 127) {
      throw new RangeError(`Resonance resonator ${resonator.id} target MIDI is out of range.`);
    }
    requirePositive(resonator.bandwidthCents, `Resonance resonator ${resonator.id} bandwidth`);
    requirePositive(resonator.gain, `Resonance resonator ${resonator.id} gain`);
    requirePositive(resonator.influenceRadius, `Resonance resonator ${resonator.id} radius`);
    if (resonator.mode !== "repel"
      && resonator.mode !== "attract"
      && resonator.mode !== "directional") {
      throw new RangeError(`Unknown Resonance force mode: ${String(resonator.mode)}`);
    }
    const direction = normalizeDirection(
      resonator.direction,
      `Resonance resonator ${resonator.id} direction`,
    );
    if (resonator.mode === "directional" && !direction) {
      throw new RangeError(`Directional resonator ${resonator.id} requires a direction.`);
    }
    return Object.freeze({
      ...resonator,
      position: Object.freeze({ ...resonator.position }),
      direction: direction ? Object.freeze(direction) : undefined,
    });
  });

  return Object.freeze({
    id: level.id,
    room,
    obstacles: Object.freeze(obstacles),
    ball: Object.freeze({
      position: Object.freeze({ ...level.ball.position }),
      velocity: Object.freeze({ ...initialVelocity }),
      radius: level.ball.radius,
      mass,
      restitution,
      linearDamping,
    }),
    goal: Object.freeze({
      position: Object.freeze({ ...level.goal.position }),
      radius: level.goal.radius,
    }),
    microphone: Object.freeze({
      ...level.microphone,
      position: Object.freeze({ ...level.microphone.position }),
      direction: microphoneDirection ? Object.freeze(microphoneDirection) : undefined,
      directivity,
    }),
    resonators: Object.freeze(resonators),
  });
}

/**
 * Comfortable normalized input is most efficient. Beyond the mapped
 * plateau, more level produces less force, preventing "yell louder" gameplay.
 */
export function normalizeResonanceIntensity(normalizedLevel: number): number {
  const level = clamp01(finiteOr(normalizedLevel, 0));
  const onset = smoothstep(0.03, 0.55, level);
  const overdrive = smoothstep(0.72, 1, level);
  return clamp01(onset * (1 - 0.4 * overdrive));
}

function midiFromFrequency(frequencyHz: number): number {
  return frequencyToMidi(frequencyHz);
}

function frequencyFromMidi(midiFloat: number): number {
  return midiToFrequency(midiFloat);
}

export function evaluateResonanceVoice(
  input: Readonly<ResonanceVoiceInput>,
): ResonanceVoiceEvaluation {
  const normalizedLevel = clamp01(finiteOr(input.normalizedLevel, 0));
  const coherentDrive = clamp01(finiteOr(input.coherentDrive, 0));
  const confidence = clamp01(finiteOr(input.confidence, 0));
  const stability = clamp01(finiteOr(input.stability, 0));
  const suppliedMidi = input.midiFloat !== null && Number.isFinite(input.midiFloat)
    ? input.midiFloat
    : null;
  const suppliedFrequency = input.frequencyHz !== null
    && Number.isFinite(input.frequencyHz)
    && input.frequencyHz > 0
    ? input.frequencyHz
    : null;
  const midiFloat = suppliedMidi ?? (suppliedFrequency === null ? null : midiFromFrequency(suppliedFrequency));
  // MIDI is the canonical interpreted coordinate when both are present. This
  // prevents contradictory caller fields from entering a replay/state record.
  const frequencyHz = suppliedMidi !== null
    ? frequencyFromMidi(suppliedMidi)
    : suppliedFrequency;
  const active = input.voiced
    && midiFloat !== null
    && midiFloat >= 0
    && midiFloat <= 127
    && confidence >= RESONANCE_MINIMUM_CONFIDENCE
    && normalizedLevel > EPSILON
    && coherentDrive > EPSILON;
  const effectiveIntensity = active ? normalizeResonanceIntensity(normalizedLevel) : 0;
  // Confidence and stability have already been combined exactly once by the
  // controller. Recover that bounded coherence fraction from its authoritative
  // level x coherence drive, then apply the comfortable-level efficiency curve
  // without grading the same evidence a second time.
  const evidenceCoherence = active
    ? clamp01(coherentDrive / normalizedLevel)
    : 0;
  return {
    active,
    midiFloat: active ? midiFloat : null,
    frequencyHz: active ? frequencyHz : null,
    normalizedLevel,
    coherentDrive,
    effectiveIntensity,
    confidence,
    stability,
    evidenceCoherence,
    directEnergy: effectiveIntensity * evidenceCoherence,
  };
}

export function evaluateResonatorActivation(
  voice: Readonly<ResonanceVoiceEvaluation>,
  resonator: Readonly<FrequencyTunedResonator>,
): ResonatorActivation {
  const centsError = voice.midiFloat === null
    ? null
    : (voice.midiFloat - resonator.targetMidi) * 100;
  const pitchAccuracy = centsError === null
    ? 0
    : Math.exp(-0.5 * (centsError / resonator.bandwidthCents) ** 2);
  const coherence = pitchAccuracy * voice.evidenceCoherence;
  return {
    resonatorId: resonator.id,
    targetMidi: resonator.targetMidi,
    centsError,
    pitchAccuracy,
    coherence,
    effectiveEnergy: voice.effectiveIntensity * coherence,
  };
}

function isBallInsideGoal(
  ball: Readonly<Pick<ResonanceBallState, "position" | "radius">>,
  goal: Readonly<ResonanceGoal>,
): boolean {
  return distance(ball.position, goal.position) <= Math.max(0, goal.radius - ball.radius) + EPSILON;
}

export function createResonanceGame(
  level: Readonly<ResonanceLevelDefinition>,
  options: Readonly<ResonancePhysicsOptions> = {},
): ResonanceGameState {
  const normalizedLevel = cloneAndValidateLevel(level);
  const ball = normalizedLevel.ball;
  const state: ResonanceGameState = {
    level: normalizedLevel,
    options: resolveOptions(options),
    status: "playing",
    ball: {
      position: { ...ball.position },
      velocity: { ...(ball.velocity ?? vector(0, 0)) },
      radius: ball.radius,
      mass: ball.mass ?? 1,
      restitution: ball.restitution ?? 0.45,
      linearDamping: ball.linearDamping ?? 0.8,
    },
    voice: evaluateResonanceVoice(SILENT_INPUT),
    resonatorActivations: normalizedLevel.resonators.map((resonator) =>
      evaluateResonatorActivation(evaluateResonanceVoice(SILENT_INPUT), resonator)),
    wavePulses: [],
    elapsedSeconds: 0,
    accumulatorSeconds: 0,
    droppedSeconds: 0,
    fixedStepCount: 0,
    collisionCount: 0,
    nextWaveId: 1,
    waveClockSeconds: 0,
  };
  return isBallInsideGoal(state.ball, normalizedLevel.goal)
    ? { ...state, status: "won" }
    : state;
}

function directivityWeight(
  source: Readonly<ResonanceMicrophoneSource>,
  radialDirection: Readonly<ResonanceVector>,
): number {
  if (!source.direction || !source.directivity) return 1;
  const forward = Math.max(0, dot(normalize(source.direction), radialDirection));
  return (1 - source.directivity) + source.directivity * forward * forward;
}

function sourceForceDirection(
  source: Readonly<ResonanceMicrophoneSource>,
  radialDirection: Readonly<ResonanceVector>,
): ResonanceVector {
  if (!source.direction || !source.directivity) return radialDirection;
  const directivity = clamp01(source.directivity);
  return normalize(add(
    scale(radialDirection, 1 - directivity),
    scale(normalize(source.direction), directivity),
  ), radialDirection);
}

function resonanceDirection(
  resonator: Readonly<FrequencyTunedResonator>,
  ballPosition: Readonly<ResonanceVector>,
): ResonanceVector {
  if (resonator.mode === "directional") return normalize(resonator.direction!);
  const away = normalize(subtract(ballPosition, resonator.position));
  return resonator.mode === "attract" ? scale(away, -1) : away;
}

export function computeResonanceForce(
  state: Readonly<ResonanceGameState>,
  voice: Readonly<ResonanceVoiceEvaluation> = state.voice,
  activations: readonly ResonatorActivation[] = state.resonatorActivations,
): ResonanceVector {
  if (!voice.active || voice.directEnergy <= EPSILON) return vector(0, 0);
  const sourceOffset = subtract(state.ball.position, state.level.microphone.position);
  const sourceDistance = magnitude(sourceOffset);
  const radialDirection = normalize(sourceOffset);
  const forceDirection = sourceForceDirection(state.level.microphone, radialDirection);
  const sourceFalloff = 1 / (
    1 + (sourceDistance / state.level.microphone.falloffRadius) ** 2
  );
  const sourceTransmission = acousticTransmission(
    state,
    state.level.microphone.position,
    state.ball.position,
  );
  let force = scale(
    forceDirection,
    state.level.microphone.gain
      * voice.directEnergy
      * sourceFalloff
      * sourceTransmission
      * directivityWeight(state.level.microphone, radialDirection),
  );

  state.level.resonators.forEach((resonator, index) => {
    const activation = activations[index];
    if (!activation || activation.effectiveEnergy <= EPSILON) return;
    const distanceFromResonator = distance(state.ball.position, resonator.position);
    if (distanceFromResonator >= resonator.influenceRadius) return;
    const normalizedDistance = distanceFromResonator / resonator.influenceRadius;
    const falloff = (1 - normalizedDistance * normalizedDistance) ** 2;
    const transmission = acousticTransmission(
      state,
      resonator.position,
      state.ball.position,
    );
    force = add(
      force,
      scale(
        resonanceDirection(resonator, state.ball.position),
        resonator.gain * activation.effectiveEnergy * falloff * transmission,
      ),
    );
  });

  return clampMagnitude(force, state.options.maximumForce);
}

interface CollisionResolution {
  readonly position: ResonanceVector;
  readonly velocity: ResonanceVector;
  readonly collisions: number;
}

function reflectVelocity(
  velocity: Readonly<ResonanceVector>,
  normal: Readonly<ResonanceVector>,
  restitution: number,
): ResonanceVector {
  const inwardSpeed = dot(velocity, normal);
  return inwardSpeed < 0
    ? subtract(velocity, scale(normal, (1 + restitution) * inwardSpeed))
    : vector(velocity.x, velocity.y);
}

function resolveRoomCollision(
  position: ResonanceVector,
  velocity: ResonanceVector,
  ball: Readonly<ResonanceBallState>,
  room: Readonly<ResonanceRoom>,
): CollisionResolution {
  let nextPosition = position;
  let nextVelocity = velocity;
  let collisions = 0;
  if (nextPosition.x < ball.radius) {
    nextPosition = vector(ball.radius, nextPosition.y);
    nextVelocity = reflectVelocity(nextVelocity, vector(1, 0), ball.restitution);
    collisions += 1;
  } else if (nextPosition.x > room.width - ball.radius) {
    nextPosition = vector(room.width - ball.radius, nextPosition.y);
    nextVelocity = reflectVelocity(nextVelocity, vector(-1, 0), ball.restitution);
    collisions += 1;
  }
  if (nextPosition.y < ball.radius) {
    nextPosition = vector(nextPosition.x, ball.radius);
    nextVelocity = reflectVelocity(nextVelocity, vector(0, 1), ball.restitution);
    collisions += 1;
  } else if (nextPosition.y > room.height - ball.radius) {
    nextPosition = vector(nextPosition.x, room.height - ball.radius);
    nextVelocity = reflectVelocity(nextVelocity, vector(0, -1), ball.restitution);
    collisions += 1;
  }
  return { position: nextPosition, velocity: nextVelocity, collisions };
}

function resolveObstacleCollision(
  position: ResonanceVector,
  velocity: ResonanceVector,
  ball: Readonly<ResonanceBallState>,
  obstacle: Readonly<ResonanceObstacle>,
): CollisionResolution {
  const nearestX = clamp(position.x, obstacle.x, obstacle.x + obstacle.width);
  const nearestY = clamp(position.y, obstacle.y, obstacle.y + obstacle.height);
  const difference = vector(position.x - nearestX, position.y - nearestY);
  const squaredDistance = magnitudeSquared(difference);
  if (squaredDistance >= ball.radius * ball.radius - EPSILON) {
    return { position, velocity, collisions: 0 };
  }

  let normal: ResonanceVector;
  let correctedPosition: ResonanceVector;
  if (squaredDistance > EPSILON) {
    const separation = Math.sqrt(squaredDistance);
    normal = scale(difference, 1 / separation);
    correctedPosition = add(position, scale(normal, ball.radius - separation + EPSILON));
  } else {
    const candidates = [
      { distance: Math.abs(position.x - obstacle.x), normal: vector(-1, 0),
        position: vector(obstacle.x - ball.radius - EPSILON, position.y) },
      { distance: Math.abs(obstacle.x + obstacle.width - position.x), normal: vector(1, 0),
        position: vector(obstacle.x + obstacle.width + ball.radius + EPSILON, position.y) },
      { distance: Math.abs(position.y - obstacle.y), normal: vector(0, -1),
        position: vector(position.x, obstacle.y - ball.radius - EPSILON) },
      { distance: Math.abs(obstacle.y + obstacle.height - position.y), normal: vector(0, 1),
        position: vector(position.x, obstacle.y + obstacle.height + ball.radius + EPSILON) },
    ].sort((first, second) => first.distance - second.distance);
    normal = candidates[0]!.normal;
    correctedPosition = candidates[0]!.position;
  }
  return {
    position: correctedPosition,
    velocity: reflectVelocity(velocity, normal, ball.restitution),
    collisions: 1,
  };
}

function resolveCollisions(
  position: ResonanceVector,
  velocity: ResonanceVector,
  state: Readonly<ResonanceGameState>,
): CollisionResolution {
  let resolution = resolveRoomCollision(position, velocity, state.ball, state.level.room);
  let collisions = resolution.collisions;
  for (let pass = 0; pass < MAX_COLLISION_PASSES; pass += 1) {
    let changed = false;
    for (const obstacle of state.level.obstacles) {
      const obstacleResolution = resolveObstacleCollision(
        resolution.position,
        resolution.velocity,
        state.ball,
        obstacle,
      );
      if (obstacleResolution.collisions > 0) changed = true;
      collisions += obstacleResolution.collisions;
      resolution = obstacleResolution;
    }
    const roomResolution = resolveRoomCollision(
      resolution.position,
      resolution.velocity,
      state.ball,
      state.level.room,
    );
    collisions += roomResolution.collisions;
    resolution = roomResolution;
    if (!changed && roomResolution.collisions === 0) break;
  }
  return { ...resolution, collisions };
}

function integrateBall(
  state: Readonly<ResonanceGameState>,
  force: Readonly<ResonanceVector>,
  deltaSeconds: number,
): CollisionResolution {
  const acceleration = scale(force, 1 / state.ball.mass);
  const damping = Math.exp(-state.ball.linearDamping * deltaSeconds);
  let velocity = clampMagnitude(
    scale(add(state.ball.velocity, scale(acceleration, deltaSeconds)), damping),
    state.options.maximumSpeed,
  );
  let position = state.ball.position;
  let collisions = 0;

  // No substep can cross an expanded obstacle, even at the configured speed cap.
  const maximumTravel = Math.max(state.ball.radius * 0.3, 0.01);
  const substeps = Math.max(
    1,
    Math.ceil(magnitude(velocity) * deltaSeconds / maximumTravel),
  );
  const substepSeconds = deltaSeconds / substeps;
  for (let index = 0; index < substeps; index += 1) {
    const resolution = resolveCollisions(
      add(position, scale(velocity, substepSeconds)),
      velocity,
      state,
    );
    position = resolution.position;
    velocity = resolution.velocity;
    collisions += resolution.collisions;
  }
  return { position, velocity, collisions };
}

function advanceWaves(
  state: Readonly<ResonanceGameState>,
  voice: Readonly<ResonanceVoiceEvaluation>,
  activations: readonly ResonatorActivation[],
  deltaSeconds: number,
): Pick<ResonanceGameState, "wavePulses" | "waveClockSeconds" | "nextWaveId"> {
  const diagonal = Math.hypot(state.level.room.width, state.level.room.height);
  const maximumAge = diagonal / state.options.waveSpeed + 0.5;
  let pulses = state.wavePulses
    .map((pulse) => ({
      ...pulse,
      radius: pulse.radius + state.options.waveSpeed * deltaSeconds,
      ageSeconds: pulse.ageSeconds + deltaSeconds,
      amplitude: pulse.amplitude * Math.exp(-0.65 * deltaSeconds),
    }))
    .filter((pulse) => pulse.ageSeconds <= maximumAge && pulse.amplitude >= 0.006);
  let waveClockSeconds = state.waveClockSeconds + deltaSeconds;
  let nextWaveId = state.nextWaveId;

  while (waveClockSeconds + EPSILON >= state.options.waveIntervalSeconds) {
    waveClockSeconds -= state.options.waveIntervalSeconds;
    if (voice.directEnergy >= 0.025) {
      pulses.push({
        id: nextWaveId,
        originKind: "microphone",
        originId: "microphone",
        origin: state.level.microphone.position,
        radius: 0,
        ageSeconds: 0,
        amplitude: voice.directEnergy,
        pitchMidi: voice.midiFloat,
        targetMidi: null,
        coherence: voice.evidenceCoherence,
      });
      nextWaveId += 1;
    }
    state.level.resonators.forEach((resonator, index) => {
      const activation = activations[index];
      if (!activation || activation.effectiveEnergy < 0.04) return;
      pulses.push({
        id: nextWaveId,
        originKind: "resonator",
        originId: resonator.id,
        origin: resonator.position,
        radius: 0,
        ageSeconds: 0,
        amplitude: activation.effectiveEnergy,
        pitchMidi: voice.midiFloat,
        targetMidi: resonator.targetMidi,
        coherence: activation.coherence,
      });
      nextWaveId += 1;
    });
  }
  if (pulses.length > state.options.maximumWavePulses) {
    pulses = pulses.slice(pulses.length - state.options.maximumWavePulses);
  }
  return { wavePulses: pulses, waveClockSeconds, nextWaveId };
}

function fixedStep(
  state: Readonly<ResonanceGameState>,
  voice: Readonly<ResonanceVoiceEvaluation>,
  activations: readonly ResonatorActivation[],
): Readonly<{ state: ResonanceGameState; collisions: number }> {
  const deltaSeconds = state.options.fixedStepSeconds;
  const force = computeResonanceForce(state, voice, activations);
  const integrated = integrateBall(state, force, deltaSeconds);
  const ball = {
    ...state.ball,
    position: integrated.position,
    velocity: integrated.velocity,
  };
  const waves = advanceWaves(state, voice, activations, deltaSeconds);
  const won = isBallInsideGoal(ball, state.level.goal);
  return {
    collisions: integrated.collisions,
    state: {
      ...state,
      ...waves,
      status: won ? "won" : "playing",
      ball,
      voice,
      resonatorActivations: activations,
      elapsedSeconds: state.elapsedSeconds + deltaSeconds,
      fixedStepCount: state.fixedStepCount + 1,
      collisionCount: state.collisionCount + integrated.collisions,
    },
  };
}

/**
 * Advance with a bounded accumulator. Identical fixed steps make replays
 * deterministic; excess tab-suspension time is reported instead of simulated.
 */
export function advanceResonanceGame(
  state: Readonly<ResonanceGameState>,
  input: Readonly<ResonanceVoiceInput>,
  deltaSeconds: number,
): ResonanceAdvanceResult {
  requireNonNegative(deltaSeconds, "Resonance frame delta");
  if (state.status === "won" || deltaSeconds === 0) {
    return { state: state as ResonanceGameState, simulatedSteps: 0, collisions: 0,
      wonThisAdvance: false };
  }
  const acceptedDelta = Math.min(deltaSeconds, state.options.maximumFrameDeltaSeconds);
  const droppedDelta = Math.max(0, deltaSeconds - acceptedDelta);
  const voice = evaluateResonanceVoice(input);
  const activations = state.level.resonators.map((resonator) =>
    evaluateResonatorActivation(voice, resonator));
  let current: ResonanceGameState = {
    ...state,
    voice,
    resonatorActivations: activations,
    accumulatorSeconds: state.accumulatorSeconds + acceptedDelta,
    droppedSeconds: state.droppedSeconds + droppedDelta,
  };
  let simulatedSteps = 0;
  let collisions = 0;
  let wonThisAdvance = false;
  while (current.accumulatorSeconds + EPSILON >= current.options.fixedStepSeconds
    && current.status === "playing") {
    const accumulatorSeconds = Math.max(
      0,
      current.accumulatorSeconds - current.options.fixedStepSeconds,
    );
    const step = fixedStep({ ...current, accumulatorSeconds }, voice, activations);
    current = step.state;
    collisions += step.collisions;
    simulatedSteps += 1;
    if (current.status === "won") wonThisAdvance = true;
  }
  return { state: current, simulatedSteps, collisions, wonThisAdvance };
}

function orientation(
  first: Readonly<ResonanceVector>,
  second: Readonly<ResonanceVector>,
  third: Readonly<ResonanceVector>,
): number {
  return (second.x - first.x) * (third.y - first.y)
    - (second.y - first.y) * (third.x - first.x);
}

function pointOnSegment(
  start: Readonly<ResonanceVector>,
  end: Readonly<ResonanceVector>,
  point: Readonly<ResonanceVector>,
): boolean {
  return point.x >= Math.min(start.x, end.x) - EPSILON
    && point.x <= Math.max(start.x, end.x) + EPSILON
    && point.y >= Math.min(start.y, end.y) - EPSILON
    && point.y <= Math.max(start.y, end.y) + EPSILON;
}

function segmentsIntersect(
  firstStart: Readonly<ResonanceVector>,
  firstEnd: Readonly<ResonanceVector>,
  secondStart: Readonly<ResonanceVector>,
  secondEnd: Readonly<ResonanceVector>,
): boolean {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  if (((firstOrientation > EPSILON && secondOrientation < -EPSILON)
      || (firstOrientation < -EPSILON && secondOrientation > EPSILON))
    && ((thirdOrientation > EPSILON && fourthOrientation < -EPSILON)
      || (thirdOrientation < -EPSILON && fourthOrientation > EPSILON))) return true;
  if (Math.abs(firstOrientation) <= EPSILON
    && pointOnSegment(firstStart, firstEnd, secondStart)) return true;
  if (Math.abs(secondOrientation) <= EPSILON
    && pointOnSegment(firstStart, firstEnd, secondEnd)) return true;
  if (Math.abs(thirdOrientation) <= EPSILON
    && pointOnSegment(secondStart, secondEnd, firstStart)) return true;
  return Math.abs(fourthOrientation) <= EPSILON
    && pointOnSegment(secondStart, secondEnd, firstEnd);
}

function segmentIntersectsObstacle(
  start: Readonly<ResonanceVector>,
  end: Readonly<ResonanceVector>,
  obstacle: Readonly<ResonanceObstacle>,
): boolean {
  if (start.x >= obstacle.x && start.x <= obstacle.x + obstacle.width
    && start.y >= obstacle.y && start.y <= obstacle.y + obstacle.height) return false;
  const corners = [
    vector(obstacle.x, obstacle.y),
    vector(obstacle.x + obstacle.width, obstacle.y),
    vector(obstacle.x + obstacle.width, obstacle.y + obstacle.height),
    vector(obstacle.x, obstacle.y + obstacle.height),
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const edgeStart = corners[index]!;
    const edgeEnd = corners[(index + 1) % corners.length]!;
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return true;
  }
  return false;
}

function acousticTransmission(
  state: Readonly<ResonanceGameState>,
  origin: Readonly<ResonanceVector>,
  sample: Readonly<ResonanceVector>,
): number {
  return state.level.obstacles.reduce((transmission, obstacle) =>
    segmentIntersectsObstacle(origin, sample, obstacle)
      ? transmission * (obstacle.acousticTransmission ?? 0.2)
      : transmission, 1);
}

/** Sample the deterministic visualization field generated by active pulses. */
export function sampleResonanceField(
  state: Readonly<ResonanceGameState>,
  position: Readonly<ResonanceVector>,
): ResonanceFieldSample {
  requireFinite(position.x, "Resonance field sample x");
  requireFinite(position.y, "Resonance field sample y");
  let pressure = 0;
  let intensity = 0;
  let gradient = vector(0, 0);
  let contributingPulses = 0;
  for (const pulse of state.wavePulses) {
    const offset = subtract(position, pulse.origin);
    const sampleDistance = magnitude(offset);
    const shellOffset = sampleDistance - pulse.radius;
    const normalizedOffset = shellOffset / state.options.waveShellWidth;
    if (Math.abs(normalizedOffset) > 3) continue;
    const envelope = Math.exp(-0.5 * normalizedOffset * normalizedOffset);
    const signedWave = Math.cos(normalizedOffset * Math.PI) * envelope;
    const transmitted = acousticTransmission(state, pulse.origin, position);
    const contribution = pulse.amplitude * signedWave * transmitted;
    pressure += contribution;
    intensity += Math.abs(contribution);
    // The signed radial derivative is sufficient for arrows/particles; physics
    // intentionally uses the stable force model rather than this visual sample.
    gradient = add(
      gradient,
      scale(
        normalize(offset, vector(0, 0)),
        -pulse.amplitude * normalizedOffset * envelope * transmitted,
      ),
    );
    contributingPulses += 1;
  }
  return { pressure, intensity, gradient, contributingPulses };
}
