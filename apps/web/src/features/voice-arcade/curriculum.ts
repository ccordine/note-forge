import {
  ARCADE_MODES,
  type ArcadeCurriculumModeCopy,
  type ArcadeCurriculumStage,
  type ArcadeFeedbackPolicy,
  type ArcadeMode,
  type ResolvedArcadeCurriculum,
} from "./types";

export const ARCADE_CURRICULUM_STAGES = Object.freeze([
  "deliberate",
  "reflex",
  "background",
] as const satisfies readonly ArcadeCurriculumStage[]);

export interface ArcadeCurriculumStageCopy {
  readonly label: string;
  readonly summary: string;
}

export interface ArcadeStageMasteryRequirement {
  /** Number of runs at or above `minimumScore` used for a recommendation. */
  readonly requiredRuns: number;
  readonly minimumScore: number;
}

/** These contracts recommend practice; they never lock a cabinet or stage. */
export const ARCADE_STAGE_MASTERY_REQUIREMENTS = Object.freeze({
  pattern: Object.freeze({
    deliberate: Object.freeze({ requiredRuns: 2, minimumScore: 72 }),
    reflex: Object.freeze({ requiredRuns: 3, minimumScore: 80 }),
    background: Object.freeze({ requiredRuns: 3, minimumScore: 86 }),
  }),
  pong: Object.freeze({
    deliberate: Object.freeze({ requiredRuns: 2, minimumScore: 68 }),
    reflex: Object.freeze({ requiredRuns: 3, minimumScore: 76 }),
    background: Object.freeze({ requiredRuns: 3, minimumScore: 82 }),
  }),
  song: Object.freeze({
    deliberate: Object.freeze({ requiredRuns: 1, minimumScore: 70 }),
    reflex: Object.freeze({ requiredRuns: 2, minimumScore: 78 }),
    background: Object.freeze({ requiredRuns: 2, minimumScore: 84 }),
  }),
  maze: Object.freeze({
    deliberate: Object.freeze({ requiredRuns: 1, minimumScore: 72 }),
    reflex: Object.freeze({ requiredRuns: 2, minimumScore: 80 }),
    background: Object.freeze({ requiredRuns: 2, minimumScore: 86 }),
  }),
  resonance: Object.freeze({
    deliberate: Object.freeze({ requiredRuns: 1, minimumScore: 70 }),
    reflex: Object.freeze({ requiredRuns: 2, minimumScore: 78 }),
    background: Object.freeze({ requiredRuns: 2, minimumScore: 84 }),
  }),
  draw: Object.freeze({
    deliberate: Object.freeze({ requiredRuns: 1, minimumScore: 70 }),
    reflex: Object.freeze({ requiredRuns: 2, minimumScore: 78 }),
    background: Object.freeze({ requiredRuns: 2, minimumScore: 84 }),
  }),
} satisfies Readonly<Record<
  ArcadeMode,
  Readonly<Record<ArcadeCurriculumStage, ArcadeStageMasteryRequirement>>
>>);

export const ARCADE_CURRICULUM_STAGE_COPY = Object.freeze({
  deliberate: Object.freeze({
    label: "Deliberate control",
    summary: "Make the pitch-to-action relationship explicit while correction is still conscious.",
  }),
  reflex: Object.freeze({
    label: "Reflex control",
    summary: "Respond faster with fewer labels so hearing and movement connect directly.",
  }),
  background: Object.freeze({
    label: "Background control",
    summary: "Keep the voice accurate while the game occupies conscious attention elsewhere.",
  }),
} satisfies Readonly<Record<ArcadeCurriculumStage, ArcadeCurriculumStageCopy>>);

/**
 * Feedback changes only what the player is shown or may replay. Detector
 * confidence, smoothing, pitch tolerance, timing, and game speed remain owned
 * by the game's mechanical difficulty and controller configuration.
 */
export const ARCADE_STAGE_FEEDBACK = Object.freeze({
  deliberate: Object.freeze({
    level: "full",
    showLiveNote: true,
    showCents: true,
    showUpcomingCue: true,
    showPreviewLabels: true,
    rangeLabelDensity: "full",
    allowReferenceReplay: true,
  }),
  reflex: Object.freeze({
    level: "reduced",
    showLiveNote: true,
    showCents: false,
    showUpcomingCue: false,
    showPreviewLabels: false,
    rangeLabelDensity: "anchors",
    allowReferenceReplay: false,
  }),
  background: Object.freeze({
    level: "gameplay",
    showLiveNote: false,
    showCents: false,
    showUpcomingCue: false,
    showPreviewLabels: false,
    rangeLabelDensity: "none",
    allowReferenceReplay: false,
  }),
} satisfies Readonly<Record<ArcadeCurriculumStage, ArcadeFeedbackPolicy>>);

export const ARCADE_MODE_CURRICULUM_COPY = Object.freeze({
  pattern: Object.freeze({
    focus: "Discrete pitch selection, cold pitch-lock, transitions, and rhythmic placement.",
    cognitiveLoad: "Read the note highway and prepare the next vocal coordinate while the beat keeps moving.",
  }),
  pong: Object.freeze({
    focus: "Continuous pitch-to-position mapping and controlled fine movement across the vocal range.",
    cognitiveLoad: "Track ball trajectory and interception timing while pitch steering becomes automatic.",
  }),
  song: Object.freeze({
    focus: "Transfer pitch control into phrases, breathing windows, and changing musical context.",
    cognitiveLoad: "Follow the track, anticipate its lane, and preserve vocal control through real phrasing.",
  }),
  maze: Object.freeze({
    focus: "Distinct nearby-note selection, stable sustain, clean release, and deliberate transitions.",
    cognitiveLoad: "Plan a route and remember rotating direction mappings while every move still needs a precise hold.",
  }),
  resonance: Object.freeze({
    focus: "Frequency-to-force coupling, steady pitch, controlled intensity, and resonance discovery.",
    cognitiveLoad: "Plan around walls and inertia while maintaining an efficient acoustic field with the voice.",
  }),
  draw: Object.freeze({
    focus: "Eight-direction pitch-to-motion mapping, clean directional changes, stable holds, and deliberate line placement.",
    cognitiveLoad: "Plan recognizable lines and shapes while the eight-note direction bank recedes into background controller fluency.",
  }),
} satisfies Readonly<Record<ArcadeMode, ArcadeCurriculumModeCopy>>);

function isArcadeMode(value: unknown): value is ArcadeMode {
  return typeof value === "string" && (ARCADE_MODES as readonly string[]).includes(value);
}

export function getArcadeCurriculumStage(value: unknown): ArcadeCurriculumStage {
  if (typeof value === "string"
    && (ARCADE_CURRICULUM_STAGES as readonly string[]).includes(value)) {
    return value as ArcadeCurriculumStage;
  }
  throw new RangeError(`Unknown Voice Arcade curriculum stage: ${String(value)}`);
}

export function getArcadeStageMasteryRequirement(
  mode: ArcadeMode,
  stage: ArcadeCurriculumStage,
): ArcadeStageMasteryRequirement {
  if (!isArcadeMode(mode)) throw new RangeError(`Unknown Voice Arcade mode: ${String(mode)}`);
  const resolvedStage = getArcadeCurriculumStage(stage);
  return ARCADE_STAGE_MASTERY_REQUIREMENTS[mode][resolvedStage];
}

/** Resolve curriculum presentation without inspecting or rewriting difficulty. */
export function resolveArcadeCurriculum(
  mode: ArcadeMode,
  stage: ArcadeCurriculumStage,
): ResolvedArcadeCurriculum {
  if (!isArcadeMode(mode)) throw new RangeError(`Unknown Voice Arcade mode: ${String(mode)}`);
  const resolvedStage = getArcadeCurriculumStage(stage);
  const stageCopy = ARCADE_CURRICULUM_STAGE_COPY[resolvedStage];
  const modeCopy = ARCADE_MODE_CURRICULUM_COPY[mode];
  return Object.freeze({
    stage: resolvedStage,
    stageLabel: stageCopy.label,
    stageSummary: stageCopy.summary,
    feedback: ARCADE_STAGE_FEEDBACK[resolvedStage],
    focus: modeCopy.focus,
    cognitiveLoad: modeCopy.cognitiveLoad,
  });
}
