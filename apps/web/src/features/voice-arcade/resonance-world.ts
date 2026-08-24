import type {
  ResonanceBallState,
  ResonanceGameState,
  ResonanceGoal,
  ResonanceLevelDefinition,
  ResonanceObstacle,
  ResonancePhysicsOptions,
  ResolvedResonancePhysicsOptions,
  ResonanceRoom,
  ResonanceVector,
  ResonanceVoiceInput,
} from "./resonance-types";
import {
  RESONANCE_EPSILON as EPSILON,
  clamp,
  distance,
  magnitudeSquared,
  normalize,
  vector,
} from "./resonance-vector";
import { evaluateResonanceVoice, evaluateResonatorActivation } from "./resonance-voice";

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

const SILENT_INPUT: ResonanceVoiceInput = Object.freeze({
  voiced: false,
  midiFloat: null,
  frequencyHz: null,
  normalizedLevel: 0,
  coherentDrive: 0,
  confidence: 0,
  stability: 0,
});

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

function normalizeDirection(
  value: ResonanceVector | undefined,
  label: string,
): ResonanceVector | undefined {
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

function cloneAndValidateLevel(
  level: Readonly<ResonanceLevelDefinition>,
): ResonanceLevelDefinition {
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
    goal: Object.freeze({ position: Object.freeze({ ...level.goal.position }), radius: level.goal.radius }),
    microphone: Object.freeze({
      ...level.microphone,
      position: Object.freeze({ ...level.microphone.position }),
      direction: microphoneDirection ? Object.freeze(microphoneDirection) : undefined,
      directivity,
    }),
    resonators: Object.freeze(resonators),
  });
}

export function ballIsInsideResonanceGoal(
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
  const silentVoice = evaluateResonanceVoice(SILENT_INPUT);
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
    voice: silentVoice,
    resonatorActivations: normalizedLevel.resonators.map((resonator) =>
      evaluateResonatorActivation(silentVoice, resonator)),
    wavePulses: [],
    elapsedSeconds: 0,
    accumulatorSeconds: 0,
    droppedSeconds: 0,
    fixedStepCount: 0,
    collisionCount: 0,
    nextWaveId: 1,
    waveClockSeconds: 0,
  };
  return ballIsInsideResonanceGoal(state.ball, normalizedLevel.goal)
    ? { ...state, status: "won" }
    : state;
}
