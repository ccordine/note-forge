import type { ArcadeMode } from "./arcade-registry";

export { ARCADE_MODES, type ArcadeMode } from "./arcade-registry";
export type ArcadeDifficultyId = "easy" | "medium" | "hard";
export type ArcadeCurriculumStage = "deliberate" | "reflex" | "background";
export type ArcadeFeedbackLevel = "full" | "reduced" | "gameplay";
export type ArcadeRangeLabelDensity = "full" | "anchors" | "none";

/**
 * Presentation assistance is deliberately separate from mechanical difficulty.
 * A game may become faster or more precise without silently hiding feedback,
 * and a singer may practice without labels at any selected difficulty.
 */
export interface ArcadeFeedbackPolicy {
  level: ArcadeFeedbackLevel;
  showLiveNote: boolean;
  showCents: boolean;
  showUpcomingCue: boolean;
  showPreviewLabels: boolean;
  rangeLabelDensity: ArcadeRangeLabelDensity;
  allowReferenceReplay: boolean;
}

export interface ArcadeCurriculumModeCopy {
  focus: string;
  cognitiveLoad: string;
}

export interface ResolvedArcadeCurriculum {
  stage: ArcadeCurriculumStage;
  stageLabel: string;
  stageSummary: string;
  feedback: ArcadeFeedbackPolicy;
  focus: string;
  cognitiveLoad: string;
}

export interface ArcadeVoiceRange {
  lowMidi: number;
  highMidi: number;
  baselineMidi: number;
}

export interface ArcadeOutcome {
  mode: ArcadeMode;
  curriculumStage: ArcadeCurriculumStage;
  /** A mode-specific branch such as `ddr`, `trace-square`, `random`, or a chamber policy. */
  variant?: string;
  /** Explicitly completed progression unit; attempted `variant` never implies completion. */
  completedVariant?: string;
  score: number;
  grade: string;
  xp: number;
  accuracy: number;
  bestCombo: number;
  durationMs: number;
  details?: Record<string, number | undefined>;
}

export interface ArcadeGameProps {
  difficulty: ArcadeDifficultyId;
  curriculumStage: ArcadeCurriculumStage;
  voiceRange: ArcadeVoiceRange;
  /** Immutable shell-owned completion evidence for this active cabinet only. */
  completedVariants: readonly string[];
  onExit: () => void;
  onComplete: (outcome: ArcadeOutcome) => void;
}
