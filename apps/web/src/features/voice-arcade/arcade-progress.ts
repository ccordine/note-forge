import {
  type ArcadeCurriculumStage,
  type ArcadeMode,
  type ArcadeOutcome,
} from "./types";
import { ARCADE_MODES } from "./arcade-registry";
import {
  getArcadeCurriculumStage,
  getArcadeStageMasteryRequirement,
} from "./curriculum";

export const ARCADE_PROGRESS_STORAGE_KEY = "voice.arcade.progress";
export const MAX_COMPLETED_VARIANT_LENGTH = 160;

export interface ArcadeStageMasteryEvidence {
  readonly runs: number;
  readonly qualifyingRuns: number;
  readonly bestScore: number;
  readonly averageScore: number;
  readonly lastScore: number | null;
  readonly lastPlayedAt: string | null;
}

export type ArcadeStageMastery = Readonly<Record<
  ArcadeCurriculumStage,
  ArcadeStageMasteryEvidence
>>;

export type ArcadeMasteryByMode = Readonly<Record<ArcadeMode, ArcadeStageMastery>>;
export type ArcadeCompletedVariantsByMode = Readonly<Record<ArcadeMode, readonly string[]>>;

export interface ArcadeProgress {
  readonly totalXp: number;
  readonly gamesPlayed: number;
  readonly bestByMode: Readonly<Record<ArcadeMode, number>>;
  readonly masteryByMode: ArcadeMasteryByMode;
  readonly completedVariantsByMode: ArcadeCompletedVariantsByMode;
  readonly lastPlayedAt: string | null;
}

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? value as UnknownRecord : null;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return Math.floor(finiteNonNegative(value, fallback));
}

function scoreValue(value: unknown, fallback = 0): number {
  return Math.min(100, finiteNonNegative(value, fallback));
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function emptyEvidence(): ArcadeStageMasteryEvidence {
  return Object.freeze({
    runs: 0,
    qualifyingRuns: 0,
    bestScore: 0,
    averageScore: 0,
    lastScore: null,
    lastPlayedAt: null,
  });
}

function emptyStageMastery(): ArcadeStageMastery {
  return Object.freeze({
    deliberate: emptyEvidence(),
    reflex: emptyEvidence(),
    background: emptyEvidence(),
  });
}

function emptyMasteryByMode(): ArcadeMasteryByMode {
  return Object.freeze(Object.fromEntries(
    ARCADE_MODES.map((mode) => [mode, emptyStageMastery()]),
  ) as Record<ArcadeMode, ArcadeStageMastery>);
}

function emptyBestByMode(): Readonly<Record<ArcadeMode, number>> {
  return Object.freeze(Object.fromEntries(
    ARCADE_MODES.map((mode) => [mode, 0]),
  ) as Record<ArcadeMode, number>);
}

function emptyCompletedVariantsByMode(): ArcadeCompletedVariantsByMode {
  return Object.freeze(Object.fromEntries(
    ARCADE_MODES.map((mode) => [mode, Object.freeze([] as string[])]),
  ) as Record<ArcadeMode, readonly string[]>);
}

function completedVariantValue(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const value = candidate.trim();
  return value.length > 0 && value.length <= MAX_COMPLETED_VARIANT_LENGTH ? value : null;
}

function normalizeCompletedVariants(candidate: unknown): readonly string[] {
  if (!Array.isArray(candidate)) return Object.freeze([]);
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const candidateVariant of candidate) {
    const variant = completedVariantValue(candidateVariant);
    if (variant === null || seen.has(variant)) continue;
    seen.add(variant);
    variants.push(variant);
  }
  return Object.freeze(variants);
}

export function createDefaultArcadeProgress(): ArcadeProgress {
  return Object.freeze({
    totalXp: 0,
    gamesPlayed: 0,
    bestByMode: emptyBestByMode(),
    masteryByMode: emptyMasteryByMode(),
    completedVariantsByMode: emptyCompletedVariantsByMode(),
    lastPlayedAt: null,
  });
}

export const DEFAULT_ARCADE_PROGRESS = createDefaultArcadeProgress();

function normalizeEvidence(candidate: unknown): ArcadeStageMasteryEvidence {
  const source = asRecord(candidate);
  if (!source) return emptyEvidence();
  const runs = nonNegativeInteger(source.runs);
  const qualifyingRuns = Math.min(runs, nonNegativeInteger(source.qualifyingRuns));
  const lastScore = source.lastScore === null || source.lastScore === undefined
    ? null
    : scoreValue(source.lastScore);
  return Object.freeze({
    runs,
    qualifyingRuns,
    bestScore: scoreValue(source.bestScore),
    averageScore: runs === 0 ? 0 : scoreValue(source.averageScore),
    lastScore,
    lastPlayedAt: normalizedTimestamp(source.lastPlayedAt),
  });
}

function normalizeStageMastery(candidate: unknown): ArcadeStageMastery {
  const source = asRecord(candidate);
  return Object.freeze({
    deliberate: normalizeEvidence(source?.deliberate),
    reflex: normalizeEvidence(source?.reflex),
    background: normalizeEvidence(source?.background),
  });
}

/** Sanitize the one current progress schema without inventing performance. */
export function normalizeArcadeProgress(candidate: unknown): ArcadeProgress {
  const source = asRecord(candidate);
  if (!source) return createDefaultArcadeProgress();
  const bestSource = asRecord(source.bestByMode);
  const masterySource = asRecord(source.masteryByMode);
  const completedVariantsSource = asRecord(source.completedVariantsByMode);

  const bestByMode = Object.fromEntries(ARCADE_MODES.map((mode) => [
    mode,
    Math.round(scoreValue(bestSource?.[mode])),
  ])) as Record<ArcadeMode, number>;
  const masteryByMode = Object.fromEntries(ARCADE_MODES.map((mode) => [
    mode,
    normalizeStageMastery(masterySource?.[mode]),
  ])) as Record<ArcadeMode, ArcadeStageMastery>;
  const completedVariantsByMode = Object.fromEntries(ARCADE_MODES.map((mode) => [
    mode,
    normalizeCompletedVariants(completedVariantsSource?.[mode]),
  ])) as Record<ArcadeMode, readonly string[]>;

  return Object.freeze({
    totalXp: Math.round(finiteNonNegative(source.totalXp)),
    gamesPlayed: nonNegativeInteger(source.gamesPlayed),
    bestByMode: Object.freeze(bestByMode),
    masteryByMode: Object.freeze(masteryByMode),
    completedVariantsByMode: Object.freeze(completedVariantsByMode),
    lastPlayedAt: normalizedTimestamp(source.lastPlayedAt),
  });
}

function requireArcadeMode(value: unknown): ArcadeMode {
  if (typeof value === "string" && (ARCADE_MODES as readonly string[]).includes(value)) {
    return value as ArcadeMode;
  }
  throw new RangeError(`Unknown Voice Arcade mode: ${String(value)}`);
}

function requireOutcomeScore(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("Arcade outcome score must be from zero through 100.");
  }
  return value;
}

function requireOutcomeXp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Arcade outcome XP must be finite and non-negative.");
  }
  return Math.round(value);
}

function requireCompletedAt(value: string): string {
  const normalized = normalizedTimestamp(value);
  if (normalized === null) throw new RangeError("Arcade completion time must be a valid timestamp.");
  return normalized;
}

function requireCompletedVariant(value: string | undefined): string | null {
  if (value === undefined) return null;
  const variant = completedVariantValue(value);
  if (variant === null) throw new RangeError("Completed Arcade variant must be a bounded non-empty identifier.");
  return variant;
}

/** Record evidence at any selected stage; recommendations are never access gates. */
export function applyArcadeOutcome(
  current: Readonly<ArcadeProgress>,
  outcome: Readonly<ArcadeOutcome>,
  completedAt: string,
): ArcadeProgress {
  const progress = normalizeArcadeProgress(current);
  const mode = requireArcadeMode(outcome.mode);
  const stage = getArcadeCurriculumStage(outcome.curriculumStage);
  const score = requireOutcomeScore(outcome.score);
  const xp = requireOutcomeXp(outcome.xp);
  const timestamp = requireCompletedAt(completedAt);
  const completedVariant = requireCompletedVariant(outcome.completedVariant);
  const previousEvidence = progress.masteryByMode[mode][stage];
  const requirement = getArcadeStageMasteryRequirement(mode, stage);
  const nextRuns = previousEvidence.runs + 1;
  const nextEvidence: ArcadeStageMasteryEvidence = Object.freeze({
    runs: nextRuns,
    qualifyingRuns: previousEvidence.qualifyingRuns
      + (score >= requirement.minimumScore ? 1 : 0),
    bestScore: Math.max(previousEvidence.bestScore, score),
    averageScore: (previousEvidence.averageScore * previousEvidence.runs + score) / nextRuns,
    lastScore: score,
    lastPlayedAt: timestamp,
  });
  const nextModeMastery: ArcadeStageMastery = Object.freeze({
    ...progress.masteryByMode[mode],
    [stage]: nextEvidence,
  });
  const previousVariants = progress.completedVariantsByMode[mode];
  const nextVariants = completedVariant === null
    || previousVariants.includes(completedVariant)
    ? previousVariants
    : Object.freeze([...previousVariants, completedVariant]);

  return Object.freeze({
    totalXp: progress.totalXp + xp,
    gamesPlayed: progress.gamesPlayed + 1,
    bestByMode: Object.freeze({
      ...progress.bestByMode,
      [mode]: Math.max(progress.bestByMode[mode], Math.round(score)),
    }),
    masteryByMode: Object.freeze({
      ...progress.masteryByMode,
      [mode]: nextModeMastery,
    }),
    completedVariantsByMode: nextVariants === previousVariants
      ? progress.completedVariantsByMode
      : Object.freeze({ ...progress.completedVariantsByMode, [mode]: nextVariants }),
    lastPlayedAt: timestamp,
  });
}

export function hasArcadeStageMastery(
  progress: Readonly<ArcadeProgress>,
  mode: ArcadeMode,
  stage: ArcadeCurriculumStage,
): boolean {
  const resolvedMode = requireArcadeMode(mode);
  const resolvedStage = getArcadeCurriculumStage(stage);
  const requirement = getArcadeStageMasteryRequirement(resolvedMode, resolvedStage);
  return progress.masteryByMode[resolvedMode][resolvedStage].qualifyingRuns
    >= requirement.requiredRuns;
}

/** Recommend the first unmastered stage while leaving every stage selectable. */
export function recommendArcadeStage(
  progress: Readonly<ArcadeProgress>,
  mode: ArcadeMode,
): ArcadeCurriculumStage {
  const resolvedMode = requireArcadeMode(mode);
  if (!hasArcadeStageMastery(progress, resolvedMode, "deliberate")) return "deliberate";
  if (!hasArcadeStageMastery(progress, resolvedMode, "reflex")) return "reflex";
  return "background";
}
