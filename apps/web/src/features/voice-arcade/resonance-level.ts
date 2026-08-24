import {
  createSeededRandom,
  type SeedValue,
  type VoiceArcadeDifficulty,
} from "./model";
import type {
  FrequencyTunedResonator,
  ResonanceLevelDefinition,
  ResonanceObstacle,
  ResonanceVector,
} from "./resonance-physics";

export interface GenerateResonanceLevelOptions {
  readonly seed: SeedValue;
  readonly level?: number;
  readonly difficulty?: VoiceArcadeDifficulty;
  readonly lowMidi: number;
  readonly highMidi: number;
  readonly baselineMidi: number;
}

export interface ResonanceLevelMetadata {
  readonly seed: SeedValue;
  readonly level: number;
  readonly difficulty: VoiceArcadeDifficulty;
  readonly targetMidis: readonly number[];
  /** A presentation hint, not a privileged physics solution. */
  readonly routeWaypoints: readonly ResonanceVector[];
}

export interface GeneratedResonanceLevel {
  readonly definition: ResonanceLevelDefinition;
  readonly metadata: ResonanceLevelMetadata;
}

interface GenerationPreset {
  readonly gateCount: number;
  readonly gapHeight: number;
  readonly bandwidthCents: number;
  readonly resonatorGain: number;
  readonly sourceGain: number;
  readonly preferredMinimumStepSemitones: number;
  readonly preferredMaximumStepSemitones: number;
}

const PRESETS: Readonly<Record<VoiceArcadeDifficulty, GenerationPreset>> = Object.freeze({
  easy: Object.freeze({
    gateCount: 1,
    gapHeight: 2.1,
    bandwidthCents: 40,
    resonatorGain: 11,
    sourceGain: 8.5,
    preferredMinimumStepSemitones: 1,
    preferredMaximumStepSemitones: 2,
  }),
  medium: Object.freeze({
    gateCount: 2,
    gapHeight: 1.8,
    bandwidthCents: 32,
    resonatorGain: 12,
    sourceGain: 8,
    preferredMinimumStepSemitones: 2,
    preferredMaximumStepSemitones: 4,
  }),
  hard: Object.freeze({
    gateCount: 3,
    gapHeight: 1.55,
    bandwidthCents: 24,
    resonatorGain: 13,
    sourceGain: 7.5,
    preferredMinimumStepSemitones: 3,
    preferredMaximumStepSemitones: 7,
  }),
});

const ROOM_WIDTH = 12;
const ROOM_HEIGHT = 8;
const BALL_RADIUS = 0.28;
const GATE_THICKNESS = 0.32;
const MAX_LEVEL = 10_000;

function requireMidi(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be an integer MIDI note from zero through 127.`);
  }
}

function assertSeed(seed: SeedValue): void {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new RangeError("Resonance seed must be finite.");
  } else if (typeof seed !== "string") {
    throw new TypeError("Resonance seed must be a finite number or string.");
  }
}

function targetNotes(
  random: () => number,
  count: number,
  lowMidi: number,
  highMidi: number,
  baselineMidi: number,
  preset: Readonly<GenerationPreset>,
): number[] {
  const notes = [baselineMidi];
  const unused = Array.from(
    { length: highMidi - lowMidi + 1 },
    (_, index) => lowMidi + index,
  ).filter((midi) => midi !== baselineMidi);
  while (notes.length < count) {
    const previous = notes.at(-1)!;
    const preferred = unused.filter((midi) => {
      const interval = Math.abs(midi - previous);
      return interval >= preset.preferredMinimumStepSemitones
        && interval <= preset.preferredMaximumStepSemitones;
    });
    const bounded = unused.filter((midi) => (
      Math.abs(midi - previous) <= preset.preferredMaximumStepSemitones
    ));
    // Very narrow profiles may not contain another note in the preferred
    // interval band. Stay inside the singer's selected range, preferring any
    // remaining bounded step and then the nearest distance band, rather than
    // inventing an out-of-range target or failing level generation.
    const nearestDistance = unused.reduce(
      (minimum, midi) => Math.min(minimum, Math.abs(midi - previous)),
      Number.POSITIVE_INFINITY,
    );
    const nearest = unused.filter((midi) => Math.abs(midi - previous) === nearestDistance);
    const candidates = preferred.length > 0
      ? preferred
      : bounded.length > 0
        ? bounded
        : nearest;
    const selected = candidates[Math.floor(random() * candidates.length)]!;
    notes.push(selected);
    unused.splice(unused.indexOf(selected), 1);
  }
  return notes;
}

/**
 * Generate a deterministic, collision-valid room made of vertical gates. The
 * generator provides reproducible content; the physics engine remains equally
 * usable with authored level definitions.
 */
export function generateResonanceLevel(
  options: Readonly<GenerateResonanceLevelOptions>,
): GeneratedResonanceLevel {
  if (!options || typeof options !== "object") {
    throw new TypeError("Resonance level options are required.");
  }
  assertSeed(options.seed);
  requireMidi(options.lowMidi, "Resonance low range edge");
  requireMidi(options.highMidi, "Resonance high range edge");
  requireMidi(options.baselineMidi, "Resonance baseline");
  if (options.lowMidi > options.highMidi) {
    throw new RangeError("Resonance low range edge cannot exceed the high range edge.");
  }
  if (options.baselineMidi < options.lowMidi || options.baselineMidi > options.highMidi) {
    throw new RangeError("Resonance baseline must be inside the selected range.");
  }
  const level = options.level ?? 1;
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new RangeError(`Resonance level must be an integer from one through ${MAX_LEVEL}.`);
  }
  const difficulty = options.difficulty ?? "medium";
  const preset = PRESETS[difficulty];
  if (!preset) throw new RangeError(`Unknown Voice Arcade difficulty: ${String(difficulty)}`);
  if (options.highMidi - options.lowMidi + 1 < preset.gateCount + 1) {
    throw new RangeError(`Resonance ${difficulty} levels need at least ${preset.gateCount + 1} notes.`);
  }

  const scopedSeed = `${typeof options.seed}:${String(options.seed)}|resonance|${level}|${difficulty}`;
  const random = createSeededRandom(scopedSeed);
  const startY = 1.6 + random() * 4.8;
  const gapMargin = preset.gapHeight / 2 + BALL_RADIUS + 0.25;
  const gateCenters = Array.from({ length: preset.gateCount }, () =>
    gapMargin + random() * (ROOM_HEIGHT - 2 * gapMargin));
  const finalY = 1.1 + random() * 5.8;
  const routeWaypoints: ResonanceVector[] = [
    { x: 1.55, y: startY },
    ...gateCenters.map((y, index) => ({
      x: 3.6 + index * (5.2 / Math.max(1, preset.gateCount - 1)),
      y,
    })),
    { x: 10.85, y: finalY },
  ];
  const notes = targetNotes(
    random,
    preset.gateCount + 1,
    options.lowMidi,
    options.highMidi,
    options.baselineMidi,
    preset,
  );

  const obstacles: ResonanceObstacle[] = [];
  const resonators: FrequencyTunedResonator[] = [];
  gateCenters.forEach((gapCenter, index) => {
    const gateX = routeWaypoints[index + 1]!.x;
    const gapTop = gapCenter - preset.gapHeight / 2;
    const gapBottom = gapCenter + preset.gapHeight / 2;
    obstacles.push({
      id: `gate-${index + 1}-upper`,
      x: gateX,
      y: 0,
      width: GATE_THICKNESS,
      height: gapTop,
      acousticTransmission: difficulty === "easy" ? 0.3 : 0.16,
    });
    obstacles.push({
      id: `gate-${index + 1}-lower`,
      x: gateX,
      y: gapBottom,
      width: GATE_THICKNESS,
      height: ROOM_HEIGHT - gapBottom,
      acousticTransmission: difficulty === "easy" ? 0.3 : 0.16,
    });
    resonators.push({
      id: `gate-resonator-${index + 1}`,
      position: { x: gateX, y: gapCenter },
      targetMidi: notes[index]!,
      bandwidthCents: Math.max(16, preset.bandwidthCents - Math.min(level - 1, 10)),
      gain: preset.resonatorGain,
      // A resonator must reach the entire approach segment, including the
      // largest seeded vertical offset. The force still falls off smoothly and
      // only the correctly tuned pitch activates this wide field.
      influenceRadius: 7,
      mode: "attract",
    });
  });

  // Every generated chamber ends with a distinct goal attractor. Without this
  // final vocal tool, a ball that cleared the last tuned gate could have
  // no remaining way to correct its vertical trajectory before the goal.
  resonators.push({
    id: "goal-resonator",
    position: { x: 10.85, y: finalY },
    targetMidi: notes.at(-1)!,
    bandwidthCents: Math.max(16, preset.bandwidthCents - Math.min(level - 1, 10)),
    gain: preset.resonatorGain * 1.2,
    influenceRadius: 9.5,
    mode: "attract",
  });

  const definition: ResonanceLevelDefinition = Object.freeze({
    id: `resonance-${difficulty}-${level}-${typeof options.seed}-${String(options.seed)}`,
    room: Object.freeze({ width: ROOM_WIDTH, height: ROOM_HEIGHT }),
    obstacles: Object.freeze(obstacles.map((obstacle) => Object.freeze(obstacle))),
    ball: Object.freeze({
      position: Object.freeze({ x: 1.55, y: startY }),
      radius: BALL_RADIUS,
      mass: 1,
      restitution: 0.34,
      linearDamping: 0.9,
    }),
    goal: Object.freeze({
      position: Object.freeze({ x: 10.85, y: finalY }),
      radius: 0.72,
    }),
    microphone: Object.freeze({
      position: Object.freeze({ x: 0.55, y: startY }),
      gain: preset.sourceGain,
      falloffRadius: 5.5,
      direction: Object.freeze({ x: 1, y: 0 }),
      directivity: 1,
    }),
    resonators: Object.freeze(resonators.map((resonator) => Object.freeze(resonator))),
  });

  return Object.freeze({
    definition,
    metadata: Object.freeze({
      seed: options.seed,
      level,
      difficulty,
      targetMidis: Object.freeze(notes),
      routeWaypoints: Object.freeze(routeWaypoints.map((point) => Object.freeze(point))),
    }),
  });
}
