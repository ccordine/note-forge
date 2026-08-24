import { noteLabel } from "../../lib/music-display";
import type { ResonanceControllerState } from "./resonance-controller";
import type { ResonanceGameState } from "./resonance-physics";
import {
  RESONANCE_TUTORIAL_LESSON_IDS,
  nextResonanceTutorialLessonId,
  type ResonanceTutorialLesson,
  type ResonanceTutorialLessonId,
  type ResonanceTutorialMechanic,
  type ResonanceTutorialObjectiveState,
} from "./resonance-tutorial";
import {
  isResonanceTutorialLessonUnlocked,
  resonanceTutorialMechanicIsProven,
  type ResonanceTutorialProgress,
} from "./resonance-tutorial-progress";
import type {
  ResonanceTutorialEvidence,
  ResonanceTutorialItemState,
  ResonanceTutorialMechanicCard,
  ResonanceTutorialObjectiveState as ResonanceTutorialObjectiveDisplayState,
} from "./ResonanceTutorialUI";

export const RESONANCE_TUTORIAL_MECHANICS = Object.freeze([
  "force",
  "pitch",
  "sustain",
  "stability",
] as const satisfies readonly ResonanceTutorialMechanic[]);

const MECHANIC_COPY: Readonly<Record<ResonanceTutorialMechanic, {
  readonly label: string;
  readonly principle: string;
  readonly input: string;
  readonly output: string;
}>> = Object.freeze({
  force: {
    label: "Force",
    principle: "Shape acceleration with comfortable, session-relative voice energy.",
    input: "relative voice energy",
    output: "field force",
  },
  pitch: {
    label: "Pitch resonance",
    principle: "Use frequency to select which physical resonator responds.",
    input: "vocal pitch",
    output: "resonator response",
  },
  sustain: {
    label: "Sustain",
    principle: "Keep reliable voice evidence continuous long enough to store power.",
    input: "continuous duration",
    output: "stored charge",
  },
  stability: {
    label: "Stability",
    principle: "Turn a scattered field into efficient, coherent force.",
    input: "pitch stability",
    output: "field coherence",
  },
});

function shortTitle(lesson: Readonly<ResonanceTutorialLesson>): string {
  return lesson.title.replace(/^(Discover|Control|Apply) · /, "");
}

export function resonanceTutorialMechanicLabel(mechanic: ResonanceTutorialMechanic): string {
  return MECHANIC_COPY[mechanic].label;
}

export function resonanceTutorialCausalRule(lesson: Readonly<ResonanceTutorialLesson>): {
  readonly input: string;
  readonly output: string;
  readonly normalized: readonly string[];
} {
  const normalized: string[] = [];
  if (lesson.isolation.pitch === "neutralize") normalized.push("pitch location");
  if (lesson.isolation.level === "normalize") normalized.push("voice energy");
  if (lesson.isolation.coherence === "normalize") normalized.push("stability / coherence");
  if (lesson.isolation.chargeGate !== undefined) normalized.push("force until charge gate");
  return {
    input: MECHANIC_COPY[lesson.mechanic].input,
    output: MECHANIC_COPY[lesson.mechanic].output,
    normalized: normalized.length > 0 ? normalized : ["no additional voice axis"],
  };
}

export function createResonanceTutorialPathCards(
  curriculum: readonly ResonanceTutorialLesson[],
  progress: Readonly<ResonanceTutorialProgress>,
  nextLessonId: ResonanceTutorialLessonId | null,
): readonly ResonanceTutorialMechanicCard[] {
  return RESONANCE_TUTORIAL_MECHANICS.map((mechanic, mechanicIndex) => {
    const lessons = curriculum.filter((lesson) => lesson.mechanic === mechanic);
    const proven = resonanceTutorialMechanicIsProven(progress, mechanic);
    const containsNext = lessons.some((lesson) => lesson.id === nextLessonId);
    const anyUnlocked = lessons.some((lesson) => isResonanceTutorialLessonUnlocked(progress, lesson.id));
    const mechanicState: ResonanceTutorialItemState = proven
      ? "complete"
      : containsNext
        ? "current"
        : anyUnlocked
          ? "available"
          : "locked";
    return {
      id: mechanic,
      number: mechanicIndex + 1,
      title: MECHANIC_COPY[mechanic].label,
      principle: MECHANIC_COPY[mechanic].principle,
      state: mechanicState,
      puzzles: lessons.map((lesson) => {
        const evidence = progress.lessons[lesson.id];
        const unlocked = isResonanceTutorialLessonUnlocked(progress, lesson.id);
        const state: ResonanceTutorialItemState = evidence.passed
          ? "complete"
          : lesson.id === nextLessonId
            ? "current"
            : unlocked
              ? "available"
              : "locked";
        const prior = lesson.order > 0 ? curriculum[lesson.order - 1] : null;
        return {
          id: lesson.id,
          kind: lesson.stage,
          title: shortTitle(lesson),
          objective: lesson.instruction,
          state,
          bestScore: evidence.attempts > 0 ? evidence.bestScore : null,
          lockReason: prior ? `Prove ${prior.title} first.` : undefined,
        };
      }),
    };
  });
}

export function focusedTutorialResonatorId(
  lesson: Readonly<ResonanceTutorialLesson>,
  objective: Readonly<ResonanceTutorialObjectiveState>,
): string | null {
  if (lesson.objective.kind !== "activation-sequence") return null;
  return lesson.objective.resonatorIds[objective.milestoneIndex] ?? null;
}

export interface ResonanceTutorialObjectiveView {
  readonly metricLabel: string;
  readonly metricValue: string;
  readonly progressText: string;
  readonly hint: string;
  readonly state: ResonanceTutorialObjectiveDisplayState;
}

function currentRequirement(lesson: Readonly<ResonanceTutorialLesson>, index: number): number | null {
  if (lesson.objective.kind === "sustain-sequence") {
    return lesson.objective.holdSeconds[index] ?? null;
  }
  if (lesson.objective.kind === "activation-sequence"
    || lesson.objective.kind === "coherence-sequence") return lesson.objective.holdSeconds;
  if (lesson.objective.kind === "charged-capture") return lesson.objective.capacitySeconds;
  return lesson.holdRequirementSeconds;
}

export function createResonanceTutorialObjectiveView(
  lesson: Readonly<ResonanceTutorialLesson>,
  objective: Readonly<ResonanceTutorialObjectiveState>,
  controller: Readonly<ResonanceControllerState> | null,
  paused: boolean,
): ResonanceTutorialObjectiveView {
  const requirement = currentRequirement(lesson, objective.milestoneIndex);
  let metricLabel = "objective progress";
  let metricValue = `${Math.round(objective.progress * 100)}%`;
  let progressText = `${Math.round(objective.progress * 100)} percent of this proof complete`;
  let hint = lesson.observation;

  switch (lesson.objective.kind) {
    case "ball-displacement":
      metricLabel = "required displacement";
      metricValue = `${Math.round(objective.progress * 100)}%`;
      progressText = "Make a comfortable reliable tone and watch cause become motion.";
      break;
    case "stopped-zones":
      metricLabel = "force marks settled";
      metricValue = `${objective.milestoneIndex}/${lesson.objective.zones.length}`;
      progressText = objective.currentHoldSeconds > 0
        ? `Sphere settling in mark for ${objective.currentHoldSeconds.toFixed(1)} seconds`
        : "Push, release completely, then let the sphere settle inside the highlighted mark.";
      break;
    case "capture":
      metricLabel = lesson.objective.maximumCollisions === 0 ? "clean transfer" : "receiver path";
      metricValue = lesson.objective.maximumCollisions === 0
        ? `${objective.progress >= 1 ? "CLEAN" : "0 CONTACTS"}`
        : `${Math.round(objective.progress * 100)}%`;
      progressText = lesson.objective.maximumCollisions === 0
        ? "Reach the receiver with zero wall contacts."
        : "Select the field that carries the sphere to the receiver.";
      break;
    case "activation-sequence": {
      const activationObjective = lesson.objective;
      const target = lesson.level.definition.resonators.find((resonator) => (
        resonator.id === activationObjective.resonatorIds[objective.milestoneIndex]
      ));
      metricLabel = "resonators proven";
      metricValue = `${objective.milestoneIndex}/${activationObjective.resonatorIds.length}`;
      progressText = target
        ? `${noteLabel(target.targetMidi)} hold ${objective.currentHoldSeconds.toFixed(1)} / ${activationObjective.holdSeconds.toFixed(1)} seconds`
        : "All authored resonators are proven.";
      break;
    }
    case "sustain-sequence":
      metricLabel = "continuous hold";
      metricValue = objective.waitingForRelease
        ? "RELEASE"
        : `${objective.currentHoldSeconds.toFixed(1)}s`;
      progressText = objective.waitingForRelease
        ? "Release completely to arm the next capacitor."
        : `${objective.currentHoldSeconds.toFixed(1)} of ${(requirement ?? 0).toFixed(1)} continuous seconds`;
      break;
    case "charged-capture":
      metricLabel = "bridge charge";
      metricValue = `${objective.chargeSeconds.toFixed(1)}s`;
      progressText = `${objective.chargeSeconds.toFixed(1)} of ${lesson.objective.capacitySeconds.toFixed(1)} seconds stored; keep the bridge powered.`;
      break;
    case "coherence-sequence": {
      const threshold = lesson.objective.minimumCoherence[objective.milestoneIndex] ?? 1;
      metricLabel = "live coherence";
      metricValue = `${Math.round((controller?.coherence ?? 0) * 100)}%`;
      progressText = `${objective.currentHoldSeconds.toFixed(1)} of ${lesson.objective.holdSeconds.toFixed(1)} seconds above the ${Math.round(threshold * 100)} percent focus mark`;
      hint = "Keep loudness comfortable. Only recent pitch consistency and periodicity move this proof.";
      break;
    }
  }

  return {
    metricLabel,
    metricValue,
    progressText,
    hint,
    state: objective.status === "passed"
      ? "complete"
      : paused
        ? "paused"
        : controller?.evidenceReliable
          ? "active"
          : "waiting",
  };
}

export interface ResonanceTutorialProofView {
  readonly passed: boolean;
  readonly score: number;
  readonly title: string;
  readonly summary: string;
  readonly primaryValue: string;
  readonly primaryLabel: string;
  readonly evidence: readonly ResonanceTutorialEvidence[];
  readonly unlock: string | null;
}

export function createResonanceTutorialProofView(
  lesson: Readonly<ResonanceTutorialLesson>,
  objective: Readonly<ResonanceTutorialObjectiveState>,
  game: Readonly<ResonanceGameState>,
): ResonanceTutorialProofView {
  const passed = objective.status === "passed";
  const score = passed ? 100 : Math.max(0, Math.round(objective.progress * 80));
  const nextId = nextResonanceTutorialLessonId(lesson.id);
  const nextMechanic = nextId?.split("-")[0] as ResonanceTutorialMechanic | undefined;
  const unlock = passed
    ? lesson.stage === "apply"
      ? nextMechanic
        ? `${MECHANIC_COPY[nextMechanic].label} can now enter the vocabulary.`
        : "Combined Resonance chambers are now unlocked."
      : `${lesson.stage === "discover" ? "Control" : "Apply"} proof unlocked for ${MECHANIC_COPY[lesson.mechanic].label}.`
    : null;
  return {
    passed,
    score,
    title: passed ? `${shortTitle(lesson)} proven.` : "Reset the chamber and prove it cleanly.",
    summary: passed ? lesson.causeAndEffect : objective.retryReason ?? "This attempt did not satisfy the authored proof.",
    primaryValue: passed ? "PROVEN" : `${score}%`,
    primaryLabel: passed ? "causal rule transferred" : "progress before reset",
    evidence: [
      {
        label: "BEST CONTINUOUS HOLD",
        value: `${objective.bestHoldSeconds.toFixed(1)}s`,
        detail: "Longest uninterrupted interval accepted by this puzzle.",
      },
      {
        label: "PHYSICS CONTACTS",
        value: String(game.collisionCount),
        detail: "Distinct ball-to-wall contact episodes in this attempt.",
      },
      {
        label: "LOCAL SIMULATION",
        value: `${game.elapsedSeconds.toFixed(1)}s`,
        detail: "Derived signal only; raw microphone audio was not retained.",
      },
    ],
    unlock,
  };
}

export function isResonanceTutorialLessonId(value: string): value is ResonanceTutorialLessonId {
  return (RESONANCE_TUTORIAL_LESSON_IDS as readonly string[]).includes(value);
}
