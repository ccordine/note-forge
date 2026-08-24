import { frequencyToMidi, midiToFrequency } from "@noteforge/music-core";

import type { GeneratedResonanceLevel } from "./resonance-level";
import {
  RESONANCE_MINIMUM_CONFIDENCE,
  advanceResonanceGame,
  createResonanceGame,
  type ResonanceGameState,
  type ResonanceLevelDefinition,
  type ResonanceVoiceInput,
} from "./resonance-physics";

export type ResonanceTutorialMechanic = "force" | "pitch" | "sustain" | "stability";
export type ResonanceTutorialStage = "discover" | "control" | "apply";

export const RESONANCE_TUTORIAL_LESSON_IDS = Object.freeze([
  "force-discover",
  "force-control",
  "force-apply",
  "pitch-discover",
  "pitch-control",
  "pitch-apply",
  "sustain-discover",
  "sustain-control",
  "sustain-apply",
  "stability-discover",
  "stability-control",
  "stability-apply",
] as const);

export type ResonanceTutorialLessonId = typeof RESONANCE_TUTORIAL_LESSON_IDS[number];

export interface ResonanceTutorialFeedbackVisibility {
  readonly pitchMeter: boolean;
  readonly exactNote: boolean;
  readonly exactCents: boolean;
  readonly levelMeter: boolean;
  readonly stabilityMeter: boolean;
  readonly chargeMeter: boolean;
  readonly forceZones: boolean;
  readonly exaggeratedWaves: boolean;
}

export interface ResonanceTutorialIsolationPolicy {
  /** Preserve the interpreted pitch only while pitch is the taught variable. */
  readonly pitch: "preserve" | "neutralize";
  /** Preserve relative voice energy only while force is the taught variable. */
  readonly level: "preserve" | "normalize";
  /** Preserve controller coherence only while stability is the taught variable. */
  readonly coherence: "preserve" | "normalize";
  /** Optional sustain capacitor: physics remains inert until it is charged. */
  readonly chargeGate?: number;
  /** Optional hard coherence floor used by the stability application chamber. */
  readonly minimumCoherenceToDrive?: number;
}

export interface ResonanceTutorialStopZone {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly maximumSpeed: number;
}

export type ResonanceTutorialObjective =
  | {
    readonly kind: "ball-displacement";
    readonly minimumDistance: number;
  }
  | {
    readonly kind: "stopped-zones";
    readonly zones: readonly ResonanceTutorialStopZone[];
    readonly dwellSeconds: number;
  }
  | {
    readonly kind: "capture";
    readonly maximumCollisions: number | null;
  }
  | {
    readonly kind: "activation-sequence";
    readonly resonatorIds: readonly string[];
    readonly minimumEnergy: number;
    readonly holdSeconds: number;
  }
  | {
    readonly kind: "sustain-sequence";
    readonly holdSeconds: readonly number[];
    readonly releaseSeconds: number;
  }
  | {
    readonly kind: "charged-capture";
    readonly capacitySeconds: number;
    readonly releaseDecayPerSecond: number;
  }
  | {
    readonly kind: "coherence-sequence";
    readonly minimumCoherence: readonly number[];
    readonly holdSeconds: number;
  };

export interface ResonanceTutorialLesson {
  readonly id: ResonanceTutorialLessonId;
  readonly order: number;
  readonly mechanic: ResonanceTutorialMechanic;
  readonly stage: ResonanceTutorialStage;
  readonly title: string;
  readonly instruction: string;
  readonly observation: string;
  readonly causeAndEffect: string;
  readonly level: GeneratedResonanceLevel;
  readonly targetMidis: readonly number[];
  readonly holdRequirementSeconds: number | null;
  readonly feedback: ResonanceTutorialFeedbackVisibility;
  readonly isolation: ResonanceTutorialIsolationPolicy;
  readonly objective: ResonanceTutorialObjective;
}

export type ResonanceTutorialObjectiveStatus = "playing" | "passed" | "retry";

export interface ResonanceTutorialObjectiveState {
  readonly status: ResonanceTutorialObjectiveStatus;
  readonly progress: number;
  readonly milestoneIndex: number;
  readonly currentHoldSeconds: number;
  readonly bestHoldSeconds: number;
  readonly releaseSeconds: number;
  readonly waitingForRelease: boolean;
  readonly chargeSeconds: number;
  readonly retryReason: string | null;
}

export interface ResonanceTutorialSessionState {
  readonly lesson: ResonanceTutorialLesson;
  readonly game: ResonanceGameState;
  readonly objective: ResonanceTutorialObjectiveState;
}

export interface ResonanceTutorialAdvanceResult {
  readonly state: ResonanceTutorialSessionState;
  readonly adaptedInput: ResonanceVoiceInput;
  readonly passedThisAdvance: boolean;
  readonly retryThisAdvance: boolean;
}

export interface CreateResonanceTutorialOptions {
  readonly baselineMidi: number;
}

const SILENT_VOICE: ResonanceVoiceInput = Object.freeze({
  voiced: false,
  midiFloat: null,
  frequencyHz: null,
  normalizedLevel: 0,
  coherentDrive: 0,
  confidence: 0,
  stability: 0,
});

const ROOM = Object.freeze({ width: 12, height: 8 });
const BALL_RADIUS = .28;
const NORMALIZED_TUTORIAL_LEVEL = .67;
const EPSILON = 1e-9;

const STAGE_COPY: Readonly<Record<ResonanceTutorialStage, string>> = Object.freeze({
  discover: "Discover",
  control: "Control",
  apply: "Apply",
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function validBaseline(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError("Resonance tutorial baseline must be an integer MIDI note from zero through 127.");
  }
  return value;
}

function boundedMidi(baselineMidi: number, offset: number): number {
  return clamp(baselineMidi + offset, 0, 127);
}

function vectorDistance(
  first: Readonly<{ x: number; y: number }>,
  second: Readonly<{ x: number; y: number }>,
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function speed(game: Readonly<ResonanceGameState>): number {
  return Math.hypot(game.ball.velocity.x, game.ball.velocity.y);
}

function voiceHasReliableEvidence(input: Readonly<ResonanceVoiceInput>): boolean {
  const hasMidi = input.midiFloat !== null
    && Number.isFinite(input.midiFloat)
    && input.midiFloat >= 0
    && input.midiFloat <= 127;
  const hasFrequency = input.frequencyHz !== null
    && Number.isFinite(input.frequencyHz)
    && input.frequencyHz > 0;
  return input.voiced
    && (hasMidi || hasFrequency)
    && Number.isFinite(input.normalizedLevel)
    && input.normalizedLevel > EPSILON
    && Number.isFinite(input.coherentDrive)
    && input.coherentDrive >= 0
    && Number.isFinite(input.confidence)
    && input.confidence >= RESONANCE_MINIMUM_CONFIDENCE;
}

/** The controller's already-combined coherence, recovered without double grading. */
export function resonanceTutorialInputCoherence(
  input: Readonly<ResonanceVoiceInput>,
): number {
  if (!voiceHasReliableEvidence(input)) return 0;
  return clamp01(input.coherentDrive / input.normalizedLevel);
}

function levelDefinition(
  id: string,
  overrides: Partial<ResonanceLevelDefinition>,
): GeneratedResonanceLevel {
  const definition: ResonanceLevelDefinition = {
    id,
    room: ROOM,
    obstacles: [],
    ball: {
      position: { x: 2, y: 4 },
      radius: BALL_RADIUS,
      mass: 1,
      restitution: .25,
      linearDamping: 1.35,
    },
    goal: { position: { x: 10.8, y: 4 }, radius: .72 },
    microphone: {
      position: { x: .7, y: 4 },
      gain: 10,
      falloffRadius: 8,
      direction: { x: 1, y: 0 },
      directivity: 1,
    },
    resonators: [],
    ...overrides,
  };
  return {
    definition,
    metadata: {
      seed: `tutorial:${id}`,
      level: 1,
      difficulty: "easy",
      targetMidis: definition.resonators.map((resonator) => resonator.targetMidi),
      routeWaypoints: [
        definition.ball.position,
        ...definition.resonators.map((resonator) => resonator.position),
        definition.goal.position,
      ],
    },
  };
}

function feedback(
  visible: Partial<ResonanceTutorialFeedbackVisibility>,
): ResonanceTutorialFeedbackVisibility {
  return {
    pitchMeter: false,
    exactNote: false,
    exactCents: false,
    levelMeter: false,
    stabilityMeter: false,
    chargeMeter: false,
    forceZones: false,
    exaggeratedWaves: false,
    ...visible,
  };
}

function baseLesson(
  id: ResonanceTutorialLessonId,
  mechanic: ResonanceTutorialMechanic,
  stage: ResonanceTutorialStage,
  fields: Omit<ResonanceTutorialLesson,
    "id" | "order" | "mechanic" | "stage" | "title"> & { readonly title: string },
): ResonanceTutorialLesson {
  return {
    id,
    order: RESONANCE_TUTORIAL_LESSON_IDS.indexOf(id),
    mechanic,
    stage,
    ...fields,
    title: `${STAGE_COPY[stage]} · ${fields.title}`,
  };
}

/**
 * Build the authored 12-room curriculum around the singer's comfortable note.
 * Nothing is randomized: a lesson id and baseline always produce the same room.
 */
export function createResonanceTutorialCurriculum(
  options: Readonly<CreateResonanceTutorialOptions>,
): readonly ResonanceTutorialLesson[] {
  const baseline = validBaseline(options.baselineMidi);
  const pitchTargets = baseline <= 1
    ? [baseline, baseline + 1, baseline + 2]
    : baseline >= 126
      ? [baseline, baseline - 1, baseline - 2]
      : [boundedMidi(baseline, -1), baseline, boundedMidi(baseline, 1)];
  const [firstDecoy, secondDecoy] = pitchTargets.filter((target) => target !== baseline);
  const pitchResonators = pitchTargets.map((targetMidi, index) => ({
    id: `pitch-target-${index + 1}`,
    position: { x: 3.2 + index * 2.4, y: 4 },
    targetMidi,
    bandwidthCents: 36,
    gain: 7,
    influenceRadius: 4.5,
    mode: "attract" as const,
  }));
  const neutralized: ResonanceTutorialIsolationPolicy = {
    pitch: "neutralize",
    level: "normalize",
    coherence: "normalize",
  };
  const forceIsolation: ResonanceTutorialIsolationPolicy = {
    pitch: "neutralize",
    level: "preserve",
    coherence: "normalize",
  };
  const pitchIsolation: ResonanceTutorialIsolationPolicy = {
    pitch: "preserve",
    level: "normalize",
    coherence: "normalize",
  };
  const stabilityIsolation: ResonanceTutorialIsolationPolicy = {
    pitch: "neutralize",
    level: "normalize",
    coherence: "preserve",
  };

  return Object.freeze([
    baseLesson("force-discover", "force", "discover", {
      title: "Voice energy creates force",
      instruction: "Make any comfortable voiced sound and watch the light sphere move. Change only your voice energy.",
      observation: "Larger coherent waves push the sphere farther. Your note does not matter in this room.",
      causeAndEffect: "More comfortable voice energy creates more field force; overdriving never earns extra force.",
      level: levelDefinition("tutorial-force-discover", {}),
      targetMidis: [],
      holdRequirementSeconds: null,
      feedback: feedback({ levelMeter: true, exaggeratedWaves: true }),
      isolation: forceIsolation,
      objective: { kind: "ball-displacement", minimumDistance: 1.15 },
    }),
    baseLesson("force-control", "force", "control", {
      title: "Stop at three force marks",
      instruction: "Push, release, and let the sphere settle inside each marked zone before moving to the next.",
      observation: "A release removes the field, but the sphere keeps its inertia until damping settles it.",
      causeAndEffect: "Energy controls acceleration; release and timing control stopping distance.",
      level: levelDefinition("tutorial-force-control", {
        ball: { position: { x: 1.8, y: 4 }, radius: BALL_RADIUS, linearDamping: 2.5 },
        goal: { position: { x: 6.05, y: 4 }, radius: .8 },
        microphone: {
          position: { x: .65, y: 4 }, gain: 8, falloffRadius: 8,
          direction: { x: 1, y: 0 }, directivity: 1,
        },
      }),
      targetMidis: [],
      holdRequirementSeconds: .24,
      feedback: feedback({ levelMeter: true, forceZones: true, exaggeratedWaves: true }),
      isolation: forceIsolation,
      objective: {
        kind: "stopped-zones",
        dwellSeconds: .24,
        zones: [
          { minimumX: 2.45, maximumX: 3.1, maximumSpeed: .42 },
          { minimumX: 3.55, maximumX: 4.25, maximumSpeed: .42 },
          { minimumX: 4.75, maximumX: 5.55, maximumSpeed: .42 },
        ],
      },
    }),
    baseLesson("force-apply", "force", "apply", {
      title: "Park the sphere cleanly",
      instruction: "Use controlled voice energy to park the sphere in the receiver without touching the corridor walls.",
      observation: "The safe path is wide; only an uncontrolled push creates a collision.",
      causeAndEffect: "Force plus release timing determines whether the sphere arrives cleanly.",
      level: levelDefinition("tutorial-force-apply", {
        obstacles: [
          { id: "upper-rail", x: 3, y: 0, width: 3.2, height: 2.75, acousticTransmission: .3 },
          { id: "lower-rail", x: 3, y: 5.25, width: 3.2, height: 2.75, acousticTransmission: .3 },
        ],
        goal: { position: { x: 7, y: 4 }, radius: .78 },
      }),
      targetMidis: [],
      holdRequirementSeconds: null,
      feedback: feedback({ levelMeter: true, exaggeratedWaves: true }),
      isolation: forceIsolation,
      objective: { kind: "capture", maximumCollisions: 0 },
    }),
    baseLesson("pitch-discover", "pitch", "discover", {
      title: "Find the hidden resonance",
      instruction: "Glide slowly around your comfortable note until the ring wakes up.",
      observation: "The ring brightens continuously as your measured pitch approaches its frequency.",
      causeAndEffect: "Pitch distance controls resonance; loudness and stability are normalized in this room.",
      level: levelDefinition("tutorial-pitch-discover", {
        microphone: { position: { x: .7, y: 4 }, gain: .0001, falloffRadius: 8 },
        resonators: [{
          id: "pitch-discovery-ring", position: { x: 5.2, y: 4 }, targetMidi: baseline,
          bandwidthCents: 44, gain: 8, influenceRadius: 5, mode: "attract",
        }],
      }),
      targetMidis: [baseline],
      holdRequirementSeconds: .3,
      feedback: feedback({ pitchMeter: true, exactNote: true, exactCents: true, exaggeratedWaves: true }),
      isolation: pitchIsolation,
      objective: {
        kind: "activation-sequence", resonatorIds: ["pitch-discovery-ring"],
        minimumEnergy: .55, holdSeconds: .3,
      },
    }),
    baseLesson("pitch-control", "pitch", "control", {
      title: "Address three neighboring notes",
      instruction: "Activate the three rings in order. Settle each measured pitch before moving on.",
      observation: "Only the ring near the current fundamental receives useful energy.",
      causeAndEffect: "Small pitch changes select distinct resonators even when every other input axis is fixed.",
      level: levelDefinition("tutorial-pitch-control", {
        microphone: { position: { x: .7, y: 4 }, gain: .0001, falloffRadius: 8 },
        resonators: pitchResonators,
      }),
      targetMidis: pitchTargets,
      holdRequirementSeconds: .34,
      feedback: feedback({ pitchMeter: true, exactNote: true, exactCents: true, exaggeratedWaves: true }),
      isolation: pitchIsolation,
      objective: {
        kind: "activation-sequence", resonatorIds: pitchResonators.map((item) => item.id),
        minimumEnergy: .5, holdSeconds: .34,
      },
    }),
    baseLesson("pitch-apply", "pitch", "apply", {
      title: "Choose the exit frequency",
      instruction: "Three frequencies are available. Find the one whose field carries the sphere into the receiver.",
      observation: "Wrong notes pull toward decoys; the exit note creates the useful horizontal field.",
      causeAndEffect: "Selecting the correct pitch selects the physical tool required by the room.",
      level: levelDefinition("tutorial-pitch-apply", {
        microphone: { position: { x: .7, y: 4 }, gain: .0001, falloffRadius: 8 },
        goal: { position: { x: 7.2, y: 4 }, radius: .8 },
        resonators: [
          { id: "upper-decoy", position: { x: 2.4, y: 1.1 }, targetMidi: firstDecoy!,
            bandwidthCents: 34, gain: 8, influenceRadius: 6, mode: "attract" },
          { id: "exit-frequency", position: { x: 7.2, y: 4 }, targetMidi: baseline,
            bandwidthCents: 34, gain: 10, influenceRadius: 7, mode: "attract" },
          { id: "lower-decoy", position: { x: 2.4, y: 6.9 }, targetMidi: secondDecoy!,
            bandwidthCents: 34, gain: 8, influenceRadius: 6, mode: "attract" },
        ],
      }),
      targetMidis: [firstDecoy!, baseline, secondDecoy!],
      holdRequirementSeconds: null,
      feedback: feedback({ pitchMeter: true, exactNote: true, exactCents: true, exaggeratedWaves: true }),
      isolation: pitchIsolation,
      objective: { kind: "capture", maximumCollisions: null },
    }),
    baseLesson("sustain-discover", "sustain", "discover", {
      title: "Charge requires continuous sound",
      instruction: "Make any comfortable voiced sound and keep it going until the capacitor fills.",
      observation: "Charge grows only while reliable voice evidence is continuous and pauses on release.",
      causeAndEffect: "Unbroken duration stores energy; pitch, level, and stability are normalized.",
      level: levelDefinition("tutorial-sustain-discover", {
        microphone: { position: { x: .7, y: 4 }, gain: .0001, falloffRadius: 8 },
      }),
      targetMidis: [],
      holdRequirementSeconds: 1,
      feedback: feedback({ chargeMeter: true, exaggeratedWaves: true }),
      isolation: neutralized,
      objective: { kind: "sustain-sequence", holdSeconds: [1], releaseSeconds: 0 },
    }),
    baseLesson("sustain-control", "sustain", "control", {
      title: "Build three exact holds",
      instruction: "Fill three capacitors in order. Release clearly between the short, medium, and long holds.",
      observation: "Each capacitor needs a longer uninterrupted tone and accepts any reliable note.",
      causeAndEffect: "Sustain duration is independently addressable and a release separates attempts.",
      level: levelDefinition("tutorial-sustain-control", {
        microphone: { position: { x: .7, y: 4 }, gain: .0001, falloffRadius: 8 },
      }),
      targetMidis: [],
      holdRequirementSeconds: 1.1,
      feedback: feedback({ chargeMeter: true, exaggeratedWaves: true }),
      isolation: neutralized,
      objective: {
        kind: "sustain-sequence", holdSeconds: [.45, .75, 1.1], releaseSeconds: .22,
      },
    }),
    baseLesson("sustain-apply", "sustain", "apply", {
      title: "Keep the bridge powered",
      instruction: "Charge the bridge, then keep your sound continuous while the sphere crosses to the receiver.",
      observation: "The movement field stays inert until the capacitor reaches its marked gate.",
      causeAndEffect: "Sustained input first unlocks force, then keeps that force available for the crossing.",
      level: levelDefinition("tutorial-sustain-apply", {
        goal: { position: { x: 6.5, y: 4 }, radius: .8 },
        microphone: {
          position: { x: .7, y: 4 }, gain: 10, falloffRadius: 8,
          direction: { x: 1, y: 0 }, directivity: 1,
        },
      }),
      targetMidis: [],
      holdRequirementSeconds: .7,
      feedback: feedback({ chargeMeter: true, exaggeratedWaves: true }),
      isolation: { ...neutralized, chargeGate: .7 },
      objective: { kind: "charged-capture", capacitySeconds: 1.2, releaseDecayPerSecond: .9 },
    }),
    baseLesson("stability-discover", "stability", "discover", {
      title: "A stable note focuses the field",
      instruction: "Hold any comfortable note and make the field change from scattered to focused.",
      observation: "The beam narrows as recent pitch spread and detector periodicity become coherent.",
      causeAndEffect: "Stability controls field coherence; note and voice energy are normalized.",
      level: levelDefinition("tutorial-stability-discover", {
        microphone: { position: { x: .7, y: 4 }, gain: .0001, falloffRadius: 8 },
      }),
      targetMidis: [],
      holdRequirementSeconds: .65,
      feedback: feedback({ stabilityMeter: true, exaggeratedWaves: true }),
      isolation: stabilityIsolation,
      objective: {
        kind: "coherence-sequence", minimumCoherence: [.62], holdSeconds: .65,
      },
    }),
    baseLesson("stability-control", "stability", "control", {
      title: "Focus three narrowing beams",
      instruction: "Meet three increasingly strict coherence marks without changing loudness to compensate.",
      observation: "Each mark asks for a steadier recent pitch history than the one before it.",
      causeAndEffect: "Fine pitch stability, not loudness, determines whether the field reaches each focus threshold.",
      level: levelDefinition("tutorial-stability-control", {
        microphone: { position: { x: .7, y: 4 }, gain: .0001, falloffRadius: 8 },
      }),
      targetMidis: [],
      holdRequirementSeconds: .4,
      feedback: feedback({ stabilityMeter: true, exaggeratedWaves: true }),
      isolation: stabilityIsolation,
      objective: {
        kind: "coherence-sequence", minimumCoherence: [.48, .66, .8], holdSeconds: .4,
      },
    }),
    baseLesson("stability-apply", "stability", "apply", {
      title: "Carry the fragile sphere",
      instruction: "Keep the beam coherent enough to carry the fragile sphere through the lane without contact.",
      observation: "The meter still exposes scattered input, but the precision field remains inert.",
      causeAndEffect: "Only stable evidence crosses the coherence gate and becomes useful force.",
      level: levelDefinition("tutorial-stability-apply", {
        obstacles: [
          { id: "precision-upper", x: 3, y: 0, width: 3.4, height: 2.9, acousticTransmission: .3 },
          { id: "precision-lower", x: 3, y: 5.1, width: 3.4, height: 2.9, acousticTransmission: .3 },
        ],
        goal: { position: { x: 7.15, y: 4 }, radius: .8 },
      }),
      targetMidis: [],
      holdRequirementSeconds: null,
      feedback: feedback({ stabilityMeter: true, exaggeratedWaves: true }),
      isolation: { ...stabilityIsolation, minimumCoherenceToDrive: .72 },
      objective: { kind: "capture", maximumCollisions: 0 },
    }),
  ]);
}

export function resonanceTutorialLesson(
  id: ResonanceTutorialLessonId,
  options: Readonly<CreateResonanceTutorialOptions>,
): ResonanceTutorialLesson {
  return createResonanceTutorialCurriculum(options).find((lesson) => lesson.id === id)!;
}

export function nextResonanceTutorialLessonId(
  id: ResonanceTutorialLessonId,
): ResonanceTutorialLessonId | null {
  const index = RESONANCE_TUTORIAL_LESSON_IDS.indexOf(id);
  return RESONANCE_TUTORIAL_LESSON_IDS[index + 1] ?? null;
}

export function resonanceTutorialLessonIsUnlocked(
  id: ResonanceTutorialLessonId,
  completed: ReadonlySet<ResonanceTutorialLessonId> | readonly ResonanceTutorialLessonId[],
): boolean {
  const completedSet = completed instanceof Set ? completed : new Set(completed);
  const index = RESONANCE_TUTORIAL_LESSON_IDS.indexOf(id);
  return index === 0 || RESONANCE_TUTORIAL_LESSON_IDS.slice(0, index).every((candidate) => (
    completedSet.has(candidate)
  ));
}

export function nextUnlockedResonanceTutorialLessonId(
  completed: ReadonlySet<ResonanceTutorialLessonId> | readonly ResonanceTutorialLessonId[],
): ResonanceTutorialLessonId | null {
  const completedSet = completed instanceof Set ? completed : new Set(completed);
  return RESONANCE_TUTORIAL_LESSON_IDS.find((id) => !completedSet.has(id)) ?? null;
}

export function createResonanceTutorialObjectiveState(): ResonanceTutorialObjectiveState {
  return {
    status: "playing",
    progress: 0,
    milestoneIndex: 0,
    currentHoldSeconds: 0,
    bestHoldSeconds: 0,
    releaseSeconds: 0,
    waitingForRelease: false,
    chargeSeconds: 0,
    retryReason: null,
  };
}

/**
 * Apply the lesson's separation-of-concerns contract before physics. This
 * never turns rejected/unreliable evidence into force. Once evidence is valid,
 * only the variable under instruction is allowed to vary. A reliable tutorial
 * observation may carry zero production drive so Force, Pitch, and Sustain can
 * explicitly neutralize coherence; Stability deliberately preserves that zero.
 */
export function adaptResonanceTutorialVoice(
  lesson: Readonly<ResonanceTutorialLesson>,
  input: Readonly<ResonanceVoiceInput>,
  objective: Readonly<ResonanceTutorialObjectiveState> = createResonanceTutorialObjectiveState(),
): ResonanceVoiceInput {
  if (!voiceHasReliableEvidence(input)) return SILENT_VOICE;
  const sourceMidi = input.midiFloat ?? frequencyToMidi(input.frequencyHz!);
  const midiFloat = lesson.isolation.pitch === "preserve"
    ? sourceMidi
    : (lesson.targetMidis[0] ?? lesson.level.metadata.targetMidis[0] ?? 48);
  // Keep force lessons monotonic throughout the comfortable operating region;
  // the shared physics curve still prevents shouting from creating bonus force.
  const normalizedLevel = lesson.isolation.level === "preserve"
    ? clamp(input.normalizedLevel, .03, .7)
    : NORMALIZED_TUTORIAL_LEVEL;
  const sourceCoherence = resonanceTutorialInputCoherence(input);
  let coherence = lesson.isolation.coherence === "preserve" ? sourceCoherence : 1;
  if (lesson.isolation.minimumCoherenceToDrive !== undefined
    && coherence + EPSILON < lesson.isolation.minimumCoherenceToDrive) {
    coherence = 0;
  }
  if (lesson.isolation.chargeGate !== undefined
    && objective.chargeSeconds + EPSILON < lesson.isolation.chargeGate) {
    coherence = 0;
  }
  if (coherence <= EPSILON) return SILENT_VOICE;
  return {
    voiced: true,
    midiFloat,
    frequencyHz: midiToFrequency(midiFloat),
    normalizedLevel,
    coherentDrive: normalizedLevel * coherence,
    confidence: Math.max(RESONANCE_MINIMUM_CONFIDENCE, clamp01(input.confidence)),
    stability: lesson.isolation.coherence === "preserve" ? clamp01(input.stability) : 1,
  };
}

function activationIsHeld(
  game: Readonly<ResonanceGameState>,
  resonatorId: string,
  minimumEnergy: number,
): boolean {
  return (game.resonatorActivations.find((activation) => (
    activation.resonatorId === resonatorId
  ))?.effectiveEnergy ?? 0) + EPSILON >= minimumEnergy;
}

function activeInput(input: Readonly<ResonanceVoiceInput>): boolean {
  return voiceHasReliableEvidence(input);
}

function withProgress(
  state: Readonly<ResonanceTutorialObjectiveState>,
  updates: Partial<ResonanceTutorialObjectiveState>,
): ResonanceTutorialObjectiveState {
  return { ...state, ...updates, progress: clamp01(updates.progress ?? state.progress) };
}

/** Pure, render-cadence-independent objective reducer. */
export function advanceResonanceTutorialObjective(
  lesson: Readonly<ResonanceTutorialLesson>,
  state: Readonly<ResonanceTutorialObjectiveState>,
  nextGame: Readonly<ResonanceGameState>,
  rawInput: Readonly<ResonanceVoiceInput>,
  deltaSeconds: number,
): ResonanceTutorialObjectiveState {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    throw new RangeError("Resonance tutorial delta must be finite and non-negative.");
  }
  if (state.status !== "playing" || deltaSeconds === 0) return state as ResonanceTutorialObjectiveState;
  const objective = lesson.objective;
  switch (objective.kind) {
    case "ball-displacement": {
      const displacement = vectorDistance(nextGame.level.ball.position, nextGame.ball.position);
      const progress = displacement / objective.minimumDistance;
      return withProgress(state, {
        progress,
        status: progress + EPSILON >= 1 ? "passed" : "playing",
      });
    }
    case "stopped-zones": {
      const zone = objective.zones[state.milestoneIndex];
      if (!zone) return withProgress(state, { progress: 1, status: "passed" });
      const stoppedInZone = nextGame.ball.position.x + EPSILON >= zone.minimumX
        && nextGame.ball.position.x <= zone.maximumX + EPSILON
        && speed(nextGame) <= zone.maximumSpeed + EPSILON
        && !activeInput(rawInput);
      const currentHoldSeconds = stoppedInZone ? state.currentHoldSeconds + deltaSeconds : 0;
      const completedZone = currentHoldSeconds + EPSILON >= objective.dwellSeconds;
      const milestoneIndex = state.milestoneIndex + (completedZone ? 1 : 0);
      const complete = milestoneIndex >= objective.zones.length;
      return withProgress(state, {
        milestoneIndex,
        currentHoldSeconds: completedZone ? 0 : currentHoldSeconds,
        bestHoldSeconds: Math.max(state.bestHoldSeconds, currentHoldSeconds),
        progress: (milestoneIndex + (completedZone ? 0 : currentHoldSeconds / objective.dwellSeconds))
          / objective.zones.length,
        status: complete ? "passed" : "playing",
      });
    }
    case "capture": {
      if (nextGame.status !== "won") {
        const start = nextGame.level.ball.position;
        const goal = nextGame.level.goal.position;
        const fullDistance = Math.max(EPSILON, vectorDistance(start, goal));
        return withProgress(state, {
          progress: vectorDistance(start, nextGame.ball.position) / fullDistance,
        });
      }
      const clean = objective.maximumCollisions === null
        || nextGame.collisionCount <= objective.maximumCollisions;
      return withProgress(state, {
        progress: 1,
        status: clean ? "passed" : "retry",
        retryReason: clean ? null : "The sphere reached the receiver after a collision. Reset and make the transfer clean.",
      });
    }
    case "activation-sequence": {
      const targetId = objective.resonatorIds[state.milestoneIndex];
      if (!targetId) return withProgress(state, { progress: 1, status: "passed" });
      const held = activationIsHeld(nextGame, targetId, objective.minimumEnergy);
      const currentHoldSeconds = held ? state.currentHoldSeconds + deltaSeconds : 0;
      const completedTarget = currentHoldSeconds + EPSILON >= objective.holdSeconds;
      const milestoneIndex = state.milestoneIndex + (completedTarget ? 1 : 0);
      const complete = milestoneIndex >= objective.resonatorIds.length;
      return withProgress(state, {
        milestoneIndex,
        currentHoldSeconds: completedTarget ? 0 : currentHoldSeconds,
        bestHoldSeconds: Math.max(state.bestHoldSeconds, currentHoldSeconds),
        progress: (milestoneIndex + (completedTarget ? 0 : currentHoldSeconds / objective.holdSeconds))
          / objective.resonatorIds.length,
        status: complete ? "passed" : "playing",
      });
    }
    case "sustain-sequence": {
      const requirement = objective.holdSeconds[state.milestoneIndex];
      if (requirement === undefined) return withProgress(state, { progress: 1, status: "passed" });
      if (state.waitingForRelease) {
        const releaseSeconds = activeInput(rawInput) ? 0 : state.releaseSeconds + deltaSeconds;
        const released = releaseSeconds + EPSILON >= objective.releaseSeconds;
        return withProgress(state, {
          releaseSeconds: released ? 0 : releaseSeconds,
          waitingForRelease: !released,
          progress: state.milestoneIndex / objective.holdSeconds.length,
        });
      }
      const currentHoldSeconds = activeInput(rawInput) ? state.currentHoldSeconds + deltaSeconds : 0;
      const completedHold = currentHoldSeconds + EPSILON >= requirement;
      const milestoneIndex = state.milestoneIndex + (completedHold ? 1 : 0);
      const complete = milestoneIndex >= objective.holdSeconds.length;
      return withProgress(state, {
        milestoneIndex,
        currentHoldSeconds: completedHold ? 0 : currentHoldSeconds,
        bestHoldSeconds: Math.max(state.bestHoldSeconds, currentHoldSeconds),
        waitingForRelease: completedHold && !complete && objective.releaseSeconds > 0,
        releaseSeconds: 0,
        progress: (milestoneIndex + (completedHold ? 0 : currentHoldSeconds / requirement))
          / objective.holdSeconds.length,
        status: complete ? "passed" : "playing",
      });
    }
    case "charged-capture": {
      const chargeSeconds = clamp(
        state.chargeSeconds + (activeInput(rawInput)
          ? deltaSeconds
          : -objective.releaseDecayPerSecond * deltaSeconds),
        0,
        objective.capacitySeconds,
      );
      const start = nextGame.level.ball.position;
      const goal = nextGame.level.goal.position;
      const travelProgress = vectorDistance(start, nextGame.ball.position)
        / Math.max(EPSILON, vectorDistance(start, goal));
      return withProgress(state, {
        chargeSeconds,
        currentHoldSeconds: activeInput(rawInput) ? state.currentHoldSeconds + deltaSeconds : 0,
        bestHoldSeconds: Math.max(
          state.bestHoldSeconds,
          activeInput(rawInput) ? state.currentHoldSeconds + deltaSeconds : state.currentHoldSeconds,
        ),
        progress: nextGame.status === "won"
          ? 1
          : Math.max(
            state.progress,
            chargeSeconds / objective.capacitySeconds * .3,
            .3 + travelProgress * .7,
          ),
        status: nextGame.status === "won" ? "passed" : "playing",
      });
    }
    case "coherence-sequence": {
      const threshold = objective.minimumCoherence[state.milestoneIndex];
      if (threshold === undefined) return withProgress(state, { progress: 1, status: "passed" });
      const coherence = resonanceTutorialInputCoherence(rawInput);
      const held = activeInput(rawInput) && coherence + EPSILON >= threshold;
      const currentHoldSeconds = held ? state.currentHoldSeconds + deltaSeconds : 0;
      const completedBand = currentHoldSeconds + EPSILON >= objective.holdSeconds;
      const milestoneIndex = state.milestoneIndex + (completedBand ? 1 : 0);
      const complete = milestoneIndex >= objective.minimumCoherence.length;
      return withProgress(state, {
        milestoneIndex,
        currentHoldSeconds: completedBand ? 0 : currentHoldSeconds,
        bestHoldSeconds: Math.max(state.bestHoldSeconds, currentHoldSeconds),
        progress: (milestoneIndex + (completedBand ? 0 : currentHoldSeconds / objective.holdSeconds))
          / objective.minimumCoherence.length,
        status: complete ? "passed" : "playing",
      });
    }
  }
}

export function createResonanceTutorialSession(
  id: ResonanceTutorialLessonId,
  options: Readonly<CreateResonanceTutorialOptions>,
): ResonanceTutorialSessionState {
  const lesson = resonanceTutorialLesson(id, options);
  return {
    lesson,
    game: createResonanceGame(lesson.level.definition),
    objective: createResonanceTutorialObjectiveState(),
  };
}

/** Advance tutorial policy, the existing deterministic physics, and objective as one replayable step. */
export function advanceResonanceTutorialSession(
  state: Readonly<ResonanceTutorialSessionState>,
  rawInput: Readonly<ResonanceVoiceInput>,
  deltaSeconds: number,
): ResonanceTutorialAdvanceResult {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    throw new RangeError("Resonance tutorial delta must be finite and non-negative.");
  }
  if (state.objective.status !== "playing" || deltaSeconds === 0) {
    return {
      state: state as ResonanceTutorialSessionState,
      adaptedInput: SILENT_VOICE,
      passedThisAdvance: false,
      retryThisAdvance: false,
    };
  }
  const adaptedInput = adaptResonanceTutorialVoice(state.lesson, rawInput, state.objective);
  const game = advanceResonanceGame(state.game, adaptedInput, deltaSeconds).state;
  const objective = advanceResonanceTutorialObjective(
    state.lesson,
    state.objective,
    game,
    rawInput,
    deltaSeconds,
  );
  return {
    state: { ...state, game, objective },
    adaptedInput,
    passedThisAdvance: objective.status === "passed",
    retryThisAdvance: objective.status === "retry",
  };
}
