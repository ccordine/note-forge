import type {
  VocalControlVector,
  VocalFlightCourseDefinition,
  VocalFlightCourseState,
  VocalFlightDisturbance,
  VocalFlightGate,
  VocalFlightState,
  Vector3,
} from "./types";
import { clampUnit } from "@/lib/numeric";

interface CourseInput extends Omit<VocalFlightCourseDefinition, "gates" | "disturbances"> {
  readonly gates?: readonly VocalFlightGate[];
  readonly disturbances?: readonly VocalFlightDisturbance[];
}

function gate(id: string, x: number, y: number, z: number, radius: number): VocalFlightGate {
  return Object.freeze({ id, center: Object.freeze({ x, y, z }), radius });
}

function movingGate(
  id: string,
  x: number,
  y: number,
  z: number,
  radius: number,
  xAmplitude: number,
  yAmplitude: number,
  phaseRadians: number,
): VocalFlightGate {
  return Object.freeze({
    ...gate(id, x, y, z, radius),
    motion: Object.freeze({
      xAmplitude,
      yAmplitude,
      cyclesPerSecond: 0.055,
      phaseRadians,
    }),
  });
}

function choiceGate(
  id: string,
  choiceGroup: string,
  x: number,
  y: number,
  z: number,
  radius: number,
): VocalFlightGate {
  return Object.freeze({ ...gate(id, x, y, z, radius), choiceGroup });
}

function course(input: CourseInput): VocalFlightCourseDefinition {
  return Object.freeze({
    ...input,
    gates: Object.freeze([...(input.gates ?? [])]),
    disturbances: Object.freeze([...(input.disturbances ?? [])]),
  });
}

const wideVertical = Object.freeze([
  gate("high", 0, 7, 55, 6.5),
  gate("low", 0, -7, 110, 6.5),
  gate("level", 0, 0, 165, 6.5),
]);
const wideBanks = Object.freeze([
  gate("left", -9, 0, 60, 7.5),
  gate("right", 9, 0, 125, 7.5),
  gate("center", 0, 0, 190, 7.5),
]);
const diagonal = Object.freeze([
  gate("upper-left", -7, 7, 55, 6),
  gate("upper-right", 7, 7, 110, 6),
  gate("lower-left", -7, -7, 165, 6),
  gate("lower-right", 7, -7, 220, 6),
]);

/** Six chapters, each preserving discovery → control → application. */
export const VOCAL_FLIGHT_TUTORIALS: readonly VocalFlightCourseDefinition[] = Object.freeze([
  course({
    id: "neutral-find-center", chapter: "neutral", order: 1,
    title: "Find center", objective: "Return the vocal reticle to center to steady the aircraft.",
    discovery: "discovery", controlMode: "neutral", selfLevelStrength: 1,
    disturbances: [
      { startZ: 0, endZ: 42, pitchTorque: 0.13, rollTorque: -0.15 },
    ],
    requiredNeutralRecoveries: 0,
    requiredNeutralHoldSeconds: 1.2,
  }),
  course({
    id: "neutral-leave-return", chapter: "neutral", order: 2,
    title: "Leave and return", objective: "Move away deliberately, then release back to vocal center.",
    discovery: "control", controlMode: "neutral", selfLevelStrength: 1,
    requiredNeutralRecoveries: 3,
  }),
  course({
    id: "neutral-stabilize", chapter: "neutral", order: 3,
    title: "Stabilize", objective: "Recover center through three controlled, repeatable disturbances.",
    discovery: "application", controlMode: "neutral", selfLevelStrength: 0.9,
    disturbances: [
      { startZ: 20, endZ: 28, pitchTorque: 0.32, rollTorque: -0.36 },
      { startZ: 48, endZ: 56, pitchTorque: -0.3, rollTorque: 0.34 },
      { startZ: 76, endZ: 84, pitchTorque: 0.26, rollTorque: 0.3 },
    ],
    requiredNeutralRecoveries: 3,
  }),
  course({
    id: "pitch-climb-descend", chapter: "pitch", order: 4,
    title: "Climb and descend", objective: "Use only relative pitch to cross the large vertical rings.",
    discovery: "discovery", controlMode: "pitch", selfLevelStrength: 0.9,
    gates: wideVertical, requiredNeutralRecoveries: 0,
  }),
  course({
    id: "pitch-hold-altitude", chapter: "pitch", order: 5,
    title: "Hold altitude", objective: "Make small pitch corrections through a level tunnel.",
    discovery: "control", controlMode: "pitch", selfLevelStrength: 0.72,
    gates: [0, 45, 90, 135, 180].map((z, index) => gate(`level-${index}`, 0, 0, z + 40, 4.8)),
    requiredNeutralRecoveries: 0,
  }),
  course({
    id: "pitch-alternating-altitude", chapter: "pitch", order: 6,
    title: "Alternating altitude", objective: "Scale corrections to alternating high and low gates.",
    discovery: "application", controlMode: "pitch", selfLevelStrength: 0.65,
    gates: [-5, 6, -7, 5, 0].map((y, index) => gate(`alternate-${index}`, 0, y, 45 + index * 45, 4.5)),
    requiredNeutralRecoveries: 0,
  }),
  course({
    id: "brightness-roll", chapter: "brightness", order: 7,
    title: "Roll left and right", objective: "Darken to bank left; brighten to bank right.",
    discovery: "discovery", controlMode: "brightness", selfLevelStrength: 0.95,
    gates: wideBanks, requiredNeutralRecoveries: 0,
  }),
  course({
    id: "brightness-hold-bank", chapter: "brightness", order: 8,
    title: "Hold bank", objective: "Maintain a gentle brightness displacement around one broad curve.",
    discovery: "control", controlMode: "brightness", selfLevelStrength: 0.8,
    gates: [
      gate("curve-1", 5, 0, 45, 7), gate("curve-2", 13, 0, 90, 7),
      gate("curve-3", 20, 0, 135, 7), gate("curve-4", 22, 0, 180, 7),
    ], requiredNeutralRecoveries: 0,
  }),
  course({
    id: "brightness-alternating-banks", chapter: "brightness", order: 9,
    title: "Alternating banks", objective: "Fly an S-course: dark, center, bright, center, dark.",
    discovery: "application", controlMode: "brightness", selfLevelStrength: 0.75,
    gates: [-8, 0, 9, 0, -8].map((x, index) => gate(`bank-${index}`, x, 0, 45 + index * 45, 5.5)),
    requiredNeutralRecoveries: 0,
  }),
  course({
    id: "combined-diagonal-rings", chapter: "combined", order: 10,
    title: "Diagonal rings", objective: "Combine pitch and brightness to reach each quadrant.",
    discovery: "discovery", controlMode: "combined", selfLevelStrength: 0.75,
    gates: diagonal, requiredNeutralRecoveries: 0,
  }),
  course({
    id: "combined-altitude-curve", chapter: "combined", order: 11,
    title: "S-curve with altitude", objective: "Bank repeatedly while climbing and descending.",
    discovery: "control", controlMode: "combined", selfLevelStrength: 0.65,
    gates: [
      gate("s1", -8, 4, 50, 5.5), gate("s2", 8, 8, 100, 5.5),
      gate("s3", -8, -4, 150, 5.5), gate("s4", 8, -8, 200, 5.5),
    ], requiredNeutralRecoveries: 0,
  }),
  course({
    id: "combined-helix", chapter: "combined", order: 12,
    title: "Broad helix", objective: "Coordinate both axes continuously around a broad spiral.",
    discovery: "application", controlMode: "combined", selfLevelStrength: 0.58,
    gates: Array.from({ length: 8 }, (_, index) => {
      const angle = index * Math.PI / 3;
      return gate(`helix-${index}`, Math.sin(angle) * 8, index * 2 - 6, 45 + index * 38, 5);
    }), requiredNeutralRecoveries: 0,
  }),
  course({
    id: "precision-narrow-tunnel", chapter: "precision", order: 13,
    title: "Narrow tunnel", objective: "Use continuous small corrections inside a narrow lane.",
    discovery: "discovery", controlMode: "combined", selfLevelStrength: 0.52,
    gates: Array.from({ length: 7 }, (_, index) => gate(`narrow-${index}`, 0, 0, 38 + index * 35, 3.4)),
    requiredNeutralRecoveries: 0,
  }),
  course({
    id: "precision-moving-line", chapter: "precision", order: 14,
    title: "Moving target", objective: "Track a slowly moving ring with measured corrections.",
    discovery: "control", controlMode: "combined", selfLevelStrength: 0.48,
    gates: Array.from({ length: 8 }, (_, index) => movingGate(
      `moving-${index}`,
      Math.sin(index * 0.8) * 3,
      Math.cos(index * 0.65) * 2,
      40 + index * 34,
      3.2,
      2.4,
      1.8,
      index * 0.7,
    )), requiredNeutralRecoveries: 0,
  }),
  course({
    id: "precision-turbulence", chapter: "precision", order: 15,
    title: "Controlled turbulence", objective: "Correct three visible, repeatable disturbances.",
    discovery: "application", controlMode: "combined", selfLevelStrength: 0.42,
    gates: Array.from({ length: 6 }, (_, index) => gate(`turbulence-${index}`, 0, 0, 45 + index * 42, 3.5)),
    disturbances: [
      { startZ: 55, endZ: 68, pitchTorque: 0.55, rollTorque: -0.7 },
      { startZ: 125, endZ: 138, pitchTorque: -0.6, rollTorque: 0.65 },
      { startZ: 195, endZ: 208, pitchTorque: 0.45, rollTorque: 0.8 },
    ], requiredNeutralRecoveries: 0,
  }),
  course({
    id: "automaticity-navigation", chapter: "automaticity", order: 16,
    title: "Navigation", objective: "Choose the cleanest line while your voice flies automatically.",
    discovery: "discovery", controlMode: "combined", selfLevelStrength: 0.4,
    gates: [
      choiceGate("route-1-left", "route-1", -7, 5, 48, 5),
      choiceGate("route-1-right", "route-1", 7, -5, 48, 5),
      choiceGate("route-2-left", "route-2", -11, -2, 96, 4.6),
      choiceGate("route-2-right", "route-2", 11, 2, 96, 4.6),
      gate("route-finish", 0, 0, 150, 4.4),
    ], requiredNeutralRecoveries: 0,
  }),
  course({
    id: "automaticity-collect", chapter: "automaticity", order: 17,
    title: "Collectible line", objective: "Collect the ring chain without watching the vocal HUD.",
    discovery: "control", controlMode: "combined", selfLevelStrength: 0.35,
    gates: [
      gate("collect-1", -5, 3, 42, 3.8), gate("collect-2", 7, 7, 79, 3.8),
      gate("collect-3", 10, -5, 116, 3.8), gate("collect-4", -8, -7, 153, 3.8),
      gate("collect-5", 0, 4, 190, 3.8),
    ], requiredNeutralRecoveries: 0,
  }),
  course({
    id: "automaticity-timed-run", chapter: "automaticity", order: 18,
    title: "Timed course", objective: "Fly the complete line while attending to the world, not your throat.",
    discovery: "application", controlMode: "combined", selfLevelStrength: 0.3,
    parSeconds: 10.5,
    gates: [
      gate("run-1", 0, 5, 40, 3.5), gate("run-2", -7, 1, 75, 3.5),
      gate("run-3", 5, -6, 110, 3.5), gate("run-4", 9, 4, 145, 3.5),
      gate("run-5", -5, 7, 180, 3.5), gate("run-6", 0, 0, 215, 3.5),
    ], requiredNeutralRecoveries: 0,
  }),
]);

export function getVocalFlightCourse(id: string): VocalFlightCourseDefinition {
  const found = VOCAL_FLIGHT_TUTORIALS.find((candidate) => candidate.id === id);
  if (!found) throw new RangeError(`Unknown Vocal Flight course: ${id}`);
  return found;
}

export function createVocalFlightCourseState(
  definition: Readonly<VocalFlightCourseDefinition>,
): VocalFlightCourseState {
  return Object.freeze({
    definition: definition as VocalFlightCourseDefinition,
    status: "flying",
    nextGateIndex: 0,
    lastPassedCenter: null,
    gatesPassed: 0,
    gatesMissed: 0,
    centerRecoveries: 0,
    neutralWasReleased: false,
    neutralHoldSeconds: 0,
    neutralSteadySeconds: 0,
    pathErrorIntegral: 0,
    sampleSeconds: 0,
  });
}

function distance2d(first: Readonly<Vector3>, second: Readonly<Vector3>): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function vocalFlightGateCenter(
  gate: Readonly<VocalFlightGate>,
  sampleSeconds: number,
): Vector3 {
  if (gate.motion === undefined) return gate.center as Vector3;
  const angle = gate.motion.phaseRadians
    + sampleSeconds * gate.motion.cyclesPerSecond * Math.PI * 2;
  return Object.freeze({
    x: gate.center.x + Math.sin(angle) * gate.motion.xAmplitude,
    y: gate.center.y + Math.cos(angle) * gate.motion.yAmplitude,
    z: gate.center.z,
  });
}

function activeGateCandidates(
  state: Readonly<VocalFlightCourseState>,
): readonly VocalFlightGate[] {
  const first = state.definition.gates[state.nextGateIndex];
  if (!first) return [];
  if (first.choiceGroup === undefined) return [first];
  const candidates: VocalFlightGate[] = [];
  for (let index = state.nextGateIndex; index < state.definition.gates.length; index += 1) {
    const candidate = state.definition.gates[index]!;
    if (candidate.choiceGroup !== first.choiceGroup) break;
    candidates.push(candidate);
  }
  return candidates;
}

export function vocalFlightCourseGateCount(
  definition: Readonly<VocalFlightCourseDefinition>,
): number {
  let count = 0;
  let previousChoice: string | undefined;
  for (const current of definition.gates) {
    if (current.choiceGroup === undefined || current.choiceGroup !== previousChoice) count += 1;
    previousChoice = current.choiceGroup;
  }
  return count;
}

export function vocalFlightDesiredPoint(
  state: Readonly<VocalFlightCourseState>,
  position: Readonly<Vector3>,
): Vector3 {
  const candidates = activeGateCandidates(state);
  const next = candidates.length <= 1
    ? candidates[0]
    : [...candidates].sort((left, right) => {
      const leftCenter = vocalFlightGateCenter(left, state.sampleSeconds);
      const rightCenter = vocalFlightGateCenter(right, state.sampleSeconds);
      return distance2d(position, leftCenter) - distance2d(position, rightCenter);
    })[0];
  if (!next) return Object.freeze({ x: 0, y: 0, z: position.z });
  const nextCenter = vocalFlightGateCenter(next, state.sampleSeconds);
  const previousCenter = state.lastPassedCenter;
  if (previousCenter === null) {
    return Object.freeze({ x: nextCenter.x, y: nextCenter.y, z: position.z });
  }
  const span = Math.max(0.001, nextCenter.z - previousCenter.z);
  const progress = clampUnit((position.z - previousCenter.z) / span);
  return Object.freeze({
    x: previousCenter.x + (nextCenter.x - previousCenter.x) * progress,
    y: previousCenter.y + (nextCenter.y - previousCenter.y) * progress,
    z: position.z,
  });
}

export function disturbanceAtPosition(
  definition: Readonly<VocalFlightCourseDefinition>,
  z: number,
): Readonly<{ pitchTorque: number; rollTorque: number }> {
  return definition.disturbances.reduce(
    (total, disturbance) => z >= disturbance.startZ && z < disturbance.endZ
      ? {
        pitchTorque: total.pitchTorque + disturbance.pitchTorque,
        rollTorque: total.rollTorque + disturbance.rollTorque,
      }
      : total,
    { pitchTorque: 0, rollTorque: 0 },
  );
}

export function advanceVocalFlightCourse(
  state: Readonly<VocalFlightCourseState>,
  previousFlight: Readonly<VocalFlightState>,
  nextFlight: Readonly<VocalFlightState>,
  control: Readonly<VocalControlVector>,
  deltaSeconds: number,
): VocalFlightCourseState {
  if (state.status === "complete" || deltaSeconds <= 0) return state as VocalFlightCourseState;
  let nextGateIndex = state.nextGateIndex;
  let gatesPassed = state.gatesPassed;
  let gatesMissed = state.gatesMissed;
  let lastPassedCenter = state.lastPassedCenter;
  const candidates = activeGateCandidates({ ...state, nextGateIndex });
  const nextGate = candidates[0];
  if (nextGate && previousFlight.position.z < nextGate.center.z
    && nextFlight.position.z >= nextGate.center.z) {
    const progress = (nextGate.center.z - previousFlight.position.z)
      / Math.max(1e-9, nextFlight.position.z - previousFlight.position.z);
    const crossing = {
      x: previousFlight.position.x
        + (nextFlight.position.x - previousFlight.position.x) * progress,
      y: previousFlight.position.y
        + (nextFlight.position.y - previousFlight.position.y) * progress,
      z: nextGate.center.z,
    };
    const crossingSeconds = state.sampleSeconds + deltaSeconds * progress;
    const centers = candidates.map((candidate) => ({
      candidate,
      center: vocalFlightGateCenter(candidate, crossingSeconds),
    })).sort((left, right) => distance2d(crossing, left.center) - distance2d(crossing, right.center));
    const chosen = centers[0]!;
    if (distance2d(crossing, chosen.center) <= chosen.candidate.radius) gatesPassed += 1;
    else gatesMissed += 1;
    lastPassedCenter = chosen.center;
    nextGateIndex += candidates.length;
  }
  const magnitude = Math.hypot(control.pitchAxis, control.brightnessAxis);
  let neutralWasReleased = state.neutralWasReleased
    || (control.active && magnitude >= 0.35);
  let centerRecoveries = state.centerRecoveries;
  let neutralHoldSeconds = state.neutralHoldSeconds;
  const neutralSteadySeconds = control.active && magnitude <= 0.1
    ? state.neutralSteadySeconds + deltaSeconds
    : 0;
  if (neutralWasReleased && control.active && magnitude <= 0.1) {
    neutralHoldSeconds += deltaSeconds;
    if (neutralHoldSeconds >= 0.3) {
      centerRecoveries += 1;
      neutralWasReleased = false;
      neutralHoldSeconds = 0;
    }
  } else if (neutralWasReleased) {
    neutralHoldSeconds = 0;
  }
  const pathError = distance2d(nextFlight.position, vocalFlightDesiredPoint(
    { ...state, nextGateIndex, lastPassedCenter },
    nextFlight.position,
  ));
  const gatesFinished = nextGateIndex >= state.definition.gates.length;
  const recoveriesFinished = centerRecoveries >= state.definition.requiredNeutralRecoveries;
  const neutralHoldFinished = neutralSteadySeconds
    >= (state.definition.requiredNeutralHoldSeconds ?? 0);
  return Object.freeze({
    ...state,
    status: gatesFinished && recoveriesFinished && neutralHoldFinished ? "complete" : "flying",
    nextGateIndex,
    lastPassedCenter,
    gatesPassed,
    gatesMissed,
    centerRecoveries,
    neutralWasReleased,
    neutralHoldSeconds,
    neutralSteadySeconds,
    pathErrorIntegral: state.pathErrorIntegral + pathError * deltaSeconds,
    sampleSeconds: state.sampleSeconds + deltaSeconds,
  });
}
