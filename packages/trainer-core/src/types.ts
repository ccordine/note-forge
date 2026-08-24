import type { HarmonicContext } from "@noteforge/music-core";
import type { PitchFrame } from "@noteforge/pitch-engine";

export type { HarmonicContext } from "@noteforge/music-core";
export type { PitchFrame } from "@noteforge/pitch-engine";

/** A synthesis or production target. `midi + centsOffset / 100` is the exact target. */
export interface NoteTarget {
  midi: number;
  centsOffset: number;
  durationMs: number;
  timbre: string;
  amplitude: number;
}

export interface VibratoMetrics {
  /** Whether enough periodic evidence exists to call the movement vibrato. */
  detected: boolean;
  /** Signed center relative to the target. Negative values are flat. */
  centerCents: number;
  /** Robust peak excursion from the center (half the 5th-to-95th percentile span). */
  depthCents: number;
  rateHz?: number;
  /** 0–1 consistency of cycle timing. */
  regularity?: number;
  cycleCount: number;
}

export interface VolumeEnvelopePoint {
  timeSeconds: number;
  rms: number;
}

export interface VolumeMetrics {
  meanRms: number;
  minimumRms: number;
  maximumRms: number;
  dynamicRangeDb: number;
  envelope: VolumeEnvelopePoint[];
}

export interface AttemptMetrics {
  /** Signed initial offset. Negative values are flat and positive values are sharp. */
  attackErrorCents?: number;
  /** Signed center offset. Negative values are flat and positive values are sharp. */
  medianErrorCents?: number;
  meanAbsoluteErrorCents?: number;
  /** Raw RMS variation around the median, including intentional vibrato. */
  stabilityCents?: number;
  /** Stability after removing an estimated periodic vibrato component. */
  vibratoAdjustedStabilityCents?: number;
  driftCentsPerSecond?: number;
  inToleranceRatio?: number;
  onsetLatencyMs?: number;
  holdDurationMs?: number;
  detectorConfidence?: number;
  voicedFrameCount?: number;
  analyzedFrameCount?: number;
  totalFrameCount?: number;
  vibratoCenterCents?: number;
  vibratoDepthCents?: number;
  vibratoRateHz?: number;
  vibratoRegularity?: number;
  vibrato?: VibratoMetrics;
  volume?: VolumeMetrics;
}

export interface ExerciseAttempt<TTarget = unknown, TAnswer = unknown> {
  id: string;
  exerciseType: string;
  target: TTarget;
  context?: HarmonicContext;
  answer?: TAnswer;
  pitchFrames?: PitchFrame[];
  metrics: AttemptMetrics;
  startedAt: string;
  completedAt: string;
}

export interface SkillState {
  skillId: string;
  mastery: number;
  difficulty: number;
  attemptCount: number;
  recentAccuracy: number;
  longTermAccuracy: number;
  averageResponseTimeMs?: number;
  confidence: number;
  commonConfusions: Record<string, number>;
  lastPracticedAt?: string;
  dueAt?: string;
}

export type SkillDomain = "perception" | "production" | "symbolic" | "spatial";

export type Representation =
  | "heard-sound"
  | "vocal-mechanics"
  | "musical-label"
  | "harmonic-function"
  | "instrument-space";

export interface SkillDefinition {
  skillId: string;
  label: string;
  description: string;
  domain: SkillDomain;
  representations: readonly Representation[];
  prerequisites: readonly string[];
  /** Relative starting complexity on a 0–1 scale. */
  difficulty: number;
  tags: readonly string[];
}

export interface SkillGraphValidation {
  valid: boolean;
  errors: string[];
}
