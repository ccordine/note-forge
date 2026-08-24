import type {
  VocalFlightCourseDefinition,
  VocalFlightGate,
} from "./types";

export type VocalFlightGameMode = "training" | "ring-run" | "pitch-tunnel" | "free-flight";

export interface VocalFlightModeDefinition {
  readonly id: VocalFlightGameMode;
  readonly label: string;
  readonly detail: string;
  readonly course: VocalFlightCourseDefinition | null;
}

function gate(id: string, x: number, y: number, z: number, radius: number): VocalFlightGate {
  return Object.freeze({ id, center: Object.freeze({ x, y, z }), radius });
}

const RING_RUN = Object.freeze({
  id: "ring-run-course",
  chapter: "automaticity",
  order: 101,
  title: "Ring Run",
  objective: "Fly the authored ring line with precision and efficient control.",
  discovery: "application",
  controlMode: "combined",
  selfLevelStrength: .42,
  parSeconds: 12.5,
  gates: Object.freeze([
    gate("ring-1", 0, 4, 42, 4.5),
    gate("ring-2", -7, 7, 80, 4.2),
    gate("ring-3", 8, 1, 118, 4),
    gate("ring-4", 5, -7, 156, 3.8),
    gate("ring-5", -8, -4, 194, 3.8),
    gate("ring-6", 0, 5, 232, 3.6),
    gate("ring-7", 0, 0, 270, 3.5),
  ]),
  disturbances: Object.freeze([]),
  requiredNeutralRecoveries: 0,
} as const satisfies VocalFlightCourseDefinition);

const PITCH_TUNNEL_OFFSETS = Object.freeze([0, 25, 50, 75, 100, 75, 50, 25, 0]);

const PITCH_TUNNEL = Object.freeze({
  id: "pitch-tunnel-course",
  chapter: "pitch",
  order: 102,
  title: "Pitch Tunnel",
  objective: "Climb a quarter-semitone trajectory, then steer smoothly back to center.",
  discovery: "application",
  controlMode: "pitch",
  selfLevelStrength: .62,
  visual: "tunnel",
  gates: Object.freeze(PITCH_TUNNEL_OFFSETS.map((cents, index) => (
    gate(`pitch-${cents}-${index}`, 0, cents / 16, 38 + index * 32, 2.8)
  ))),
  disturbances: Object.freeze([]),
  requiredNeutralRecoveries: 0,
} as const satisfies VocalFlightCourseDefinition);

export const VOCAL_FLIGHT_MODE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "training",
    label: "Training Course",
    detail: "Discovery, control, then application for one vocal mechanic at a time.",
    course: null,
  }),
  Object.freeze({
    id: "ring-run",
    label: "Ring Run",
    detail: "A scored two-axis course for precision, smoothness, and time.",
    course: RING_RUN,
  }),
  Object.freeze({
    id: "pitch-tunnel",
    label: "Pitch Tunnel",
    detail: "Fly the canonical 0, +25, +50, +75, +100-cent path and return.",
    course: PITCH_TUNNEL,
  }),
  Object.freeze({
    id: "free-flight",
    label: "Free Flight",
    detail: "No course and no required score. Explore the acoustic control surface.",
    course: null,
  }),
] as const satisfies readonly VocalFlightModeDefinition[]);

export function getVocalFlightMode(id: VocalFlightGameMode): VocalFlightModeDefinition {
  return VOCAL_FLIGHT_MODE_DEFINITIONS.find((mode) => mode.id === id)!;
}
