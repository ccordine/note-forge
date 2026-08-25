import type {
  VocalFlightConfig,
  VocalFlightInput,
  VocalFlightState,
  VocalFlightControlMode,
  Vector3,
} from "./types";
import { clamp, clampSignedUnit, clampUnit } from "@/lib/numeric";

const EPSILON = 1e-10;

export const DEFAULT_VOCAL_FLIGHT_CONFIG = Object.freeze({
  fixedStepSeconds: 1 / 200,
  maximumAdvanceSeconds: 0.1,
  forwardSpeed: 26,
  pitchTorque: 2.8,
  rollTorque: 4.2,
  pitchRateDamping: 3.6,
  rollRateDamping: 4.1,
  pitchSelfLevel: 2.2,
  rollSelfLevel: 2.8,
  coordinatedTurnRate: 1.18,
  maximumPitchRadians: Math.PI * 0.36,
  maximumRollRadians: Math.PI * 0.42,
} as const satisfies VocalFlightConfig);

export interface CreateVocalFlightOptions {
  readonly config?: Readonly<Partial<VocalFlightConfig>>;
  readonly position?: Readonly<Vector3>;
  readonly pitchRadians?: number;
  readonly rollRadians?: number;
  readonly headingRadians?: number;
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function validateConfig(config: Readonly<VocalFlightConfig>): void {
  for (const [label, value] of Object.entries(config)) {
    requireFinite(value, `Flight ${label}`);
    if (value <= 0) throw new RangeError(`Flight ${label} must be positive.`);
  }
  if (config.fixedStepSeconds > config.maximumAdvanceSeconds) {
    throw new RangeError("Flight fixed step cannot exceed maximum advance time.");
  }
  if (config.maximumPitchRadians >= Math.PI / 2
    || config.maximumRollRadians >= Math.PI / 2) {
    throw new RangeError("Flight attitude limits must remain below 90 degrees.");
  }
}

function validatePosition(position: Readonly<Vector3>): void {
  requireFinite(position.x, "Flight X position");
  requireFinite(position.y, "Flight Y position");
  requireFinite(position.z, "Flight Z position");
}

export function createVocalFlightState(
  options: Readonly<CreateVocalFlightOptions> = {},
): VocalFlightState {
  const config = Object.freeze({ ...DEFAULT_VOCAL_FLIGHT_CONFIG, ...options.config });
  validateConfig(config);
  const position = Object.freeze({ ...(options.position ?? { x: 0, y: 0, z: 0 }) });
  validatePosition(position);
  const pitchRadians = options.pitchRadians ?? 0;
  const rollRadians = options.rollRadians ?? 0;
  const headingRadians = options.headingRadians ?? 0;
  requireFinite(pitchRadians, "Initial pitch");
  requireFinite(rollRadians, "Initial roll");
  requireFinite(headingRadians, "Initial heading");
  if (Math.abs(pitchRadians) > config.maximumPitchRadians
    || Math.abs(rollRadians) > config.maximumRollRadians) {
    throw new RangeError("Initial aircraft attitude exceeds configured limits.");
  }
  return Object.freeze({
    config,
    position,
    pitchRadians,
    rollRadians,
    headingRadians,
    pitchRate: 0,
    rollRate: 0,
    yawRate: 0,
    elapsedSeconds: 0,
    distanceTraveled: 0,
    accumulatorSeconds: 0,
    fixedStepCount: 0,
  });
}

function enabledAxes(mode: VocalFlightControlMode): {
  readonly pitch: boolean;
  readonly brightness: boolean;
} {
  return {
    pitch: mode === "neutral" || mode === "pitch" || mode === "combined",
    brightness: mode === "neutral" || mode === "brightness" || mode === "combined",
  };
}

function integrateStep(
  state: Readonly<VocalFlightState>,
  input: Readonly<VocalFlightInput>,
  deltaSeconds: number,
): VocalFlightState {
  const mode = input.controlMode ?? "combined";
  const enabled = enabledAxes(mode);
  const active = input.control.active;
  const tutorialScale = mode === "neutral" ? 0.35 : 1;
  const pitchAxis = active && enabled.pitch
    ? clampSignedUnit(input.control.pitchAxis) * tutorialScale
    : 0;
  const brightnessAxis = active && enabled.brightness
    ? clampSignedUnit(input.control.brightnessAxis) * tutorialScale
    : 0;
  const selfLevelStrength = clampUnit(input.selfLevelStrength ?? 1);
  const pitchAcceleration = state.config.pitchTorque * pitchAxis
    + (input.disturbancePitchTorque ?? 0)
    - state.config.pitchRateDamping * state.pitchRate
    - state.config.pitchSelfLevel * selfLevelStrength * state.pitchRadians;
  const rollAcceleration = state.config.rollTorque * brightnessAxis
    + (input.disturbanceRollTorque ?? 0)
    - state.config.rollRateDamping * state.rollRate
    - state.config.rollSelfLevel * selfLevelStrength * state.rollRadians;
  let pitchRate = state.pitchRate + pitchAcceleration * deltaSeconds;
  let rollRate = state.rollRate + rollAcceleration * deltaSeconds;
  let pitchRadians = state.pitchRadians + pitchRate * deltaSeconds;
  let rollRadians = state.rollRadians + rollRate * deltaSeconds;
  if (Math.abs(pitchRadians) >= state.config.maximumPitchRadians) {
    pitchRadians = clamp(
      pitchRadians,
      -state.config.maximumPitchRadians,
      state.config.maximumPitchRadians,
    );
    if (Math.sign(pitchRate) === Math.sign(pitchRadians)) pitchRate = 0;
  }
  if (Math.abs(rollRadians) >= state.config.maximumRollRadians) {
    rollRadians = clamp(
      rollRadians,
      -state.config.maximumRollRadians,
      state.config.maximumRollRadians,
    );
    if (Math.sign(rollRate) === Math.sign(rollRadians)) rollRate = 0;
  }
  const yawRate = state.config.coordinatedTurnRate * Math.tan(rollRadians);
  const headingRadians = state.headingRadians + yawRate * deltaSeconds;
  const horizontalSpeed = state.config.forwardSpeed * Math.cos(pitchRadians);
  const velocity = {
    x: horizontalSpeed * Math.sin(headingRadians),
    y: state.config.forwardSpeed * Math.sin(pitchRadians),
    z: horizontalSpeed * Math.cos(headingRadians),
  };
  const position = Object.freeze({
    x: state.position.x + velocity.x * deltaSeconds,
    y: state.position.y + velocity.y * deltaSeconds,
    z: state.position.z + velocity.z * deltaSeconds,
  });
  return Object.freeze({
    ...state,
    position,
    pitchRadians,
    rollRadians,
    headingRadians,
    pitchRate,
    rollRate,
    yawRate,
    elapsedSeconds: state.elapsedSeconds + deltaSeconds,
    distanceTraveled: state.distanceTraveled + state.config.forwardSpeed * deltaSeconds,
    fixedStepCount: state.fixedStepCount + 1,
  });
}

/**
 * Advance deterministic arcade flight from sample-derived time. The caller may
 * invoke this from requestAnimationFrame, but wall time never enters the result.
 */
export function advanceVocalFlight(
  previous: Readonly<VocalFlightState>,
  input: Readonly<VocalFlightInput>,
  deltaSeconds: number,
): VocalFlightState {
  requireFinite(deltaSeconds, "Flight sample delta");
  if (deltaSeconds < 0) throw new RangeError("Flight sample delta cannot be negative.");
  if (deltaSeconds > previous.config.maximumAdvanceSeconds + EPSILON) {
    throw new RangeError("Flight sample delta exceeds the no-catch-up budget.");
  }
  if (deltaSeconds === 0) return previous as VocalFlightState;
  let state = previous as VocalFlightState;
  let accumulatorSeconds = state.accumulatorSeconds + deltaSeconds;
  while (accumulatorSeconds + EPSILON >= state.config.fixedStepSeconds) {
    state = integrateStep(state, input, state.config.fixedStepSeconds);
    accumulatorSeconds -= state.config.fixedStepSeconds;
  }
  if (Math.abs(accumulatorSeconds) < EPSILON) accumulatorSeconds = 0;
  return Object.freeze({ ...state, accumulatorSeconds });
}
