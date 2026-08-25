import { resonanceAcousticTransmission } from "./resonance-field";
import type {
  FrequencyTunedResonator,
  ResonanceAdvanceResult,
  ResonanceBallState,
  ResonanceGameState,
  ResonanceMicrophoneSource,
  ResonanceObstacle,
  ResonanceRoom,
  ResonanceVector,
  ResonanceVoiceEvaluation,
  ResonanceVoiceInput,
  ResonatorActivation,
} from "./resonance-types";
import {
  RESONANCE_EPSILON as EPSILON,
  add,
  clamp,
  clamp01,
  clampMagnitude,
  distance,
  dot,
  magnitude,
  magnitudeSquared,
  normalize,
  scale,
  subtract,
  vector,
} from "./resonance-vector";
import { evaluateResonanceVoice, evaluateResonatorActivation } from "./resonance-voice";
import { ballIsInsideResonanceGoal } from "./resonance-world";

const MAX_COLLISION_PASSES = 3;

function requireNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
  if (value < 0) throw new RangeError(`${label} cannot be negative.`);
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
  const sourceTransmission = resonanceAcousticTransmission(
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
    const transmission = resonanceAcousticTransmission(
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
  const maximumTravel = Math.max(state.ball.radius * 0.3, 0.01);
  const substeps = Math.max(1, Math.ceil(magnitude(velocity) * deltaSeconds / maximumTravel));
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
  const ball = { ...state.ball, position: integrated.position, velocity: integrated.velocity };
  const waves = advanceWaves(state, voice, activations, deltaSeconds);
  const won = state.status === "won" || ballIsInsideResonanceGoal(ball, state.level.goal);
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

/** Deterministic bounded fixed-step advancement; excess suspension time is dropped. */
export function advanceResonanceGame(
  state: Readonly<ResonanceGameState>,
  input: Readonly<ResonanceVoiceInput>,
  deltaSeconds: number,
): ResonanceAdvanceResult {
  requireNonNegative(deltaSeconds, "Resonance frame delta");
  if (deltaSeconds === 0) {
    return {
      state: state as ResonanceGameState,
      simulatedSteps: 0,
      collisions: 0,
      wonThisAdvance: false,
    };
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
  while (current.accumulatorSeconds + EPSILON >= current.options.fixedStepSeconds) {
    const alreadyWon = current.status === "won";
    const accumulatorSeconds = Math.max(
      0,
      current.accumulatorSeconds - current.options.fixedStepSeconds,
    );
    const step = fixedStep({ ...current, accumulatorSeconds }, voice, activations);
    current = step.state;
    collisions += step.collisions;
    simulatedSteps += 1;
    if (!alreadyWon && current.status === "won") wonThisAdvance = true;
  }
  return { state: current, simulatedSteps, collisions, wonThisAdvance };
}
