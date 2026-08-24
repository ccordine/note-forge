import {
  RESONANCE_TUTORIAL_LESSON_IDS,
  type ResonanceTutorialLessonId,
  type ResonanceTutorialMechanic,
} from "./resonance-tutorial";

export const RESONANCE_TUTORIAL_PROGRESS_STORAGE_KEY = "voice.arcade.resonance-tutorial";

export interface ResonanceTutorialLessonEvidence {
  readonly attempts: number;
  readonly passed: boolean;
  readonly bestScore: number;
  readonly lastScore: number | null;
  readonly firstPassedAt: string | null;
  readonly lastAttemptAt: string | null;
}

export type ResonanceTutorialEvidenceByLesson = Readonly<Record<
  ResonanceTutorialLessonId,
  ResonanceTutorialLessonEvidence
>>;

export interface ResonanceTutorialProgress {
  readonly lessons: ResonanceTutorialEvidenceByLesson;
}

export interface ResonanceTutorialAttempt {
  readonly lessonId: ResonanceTutorialLessonId;
  readonly passed: boolean;
  readonly score: number;
}

interface UnknownRecord {
  [key: string]: unknown;
}

const MECHANIC_ORDER = ["force", "pitch", "sustain", "stability"] as const satisfies readonly ResonanceTutorialMechanic[];

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? value as UnknownRecord : null;
}

function emptyEvidence(): ResonanceTutorialLessonEvidence {
  return Object.freeze({
    attempts: 0,
    passed: false,
    bestScore: 0,
    lastScore: null,
    firstPassedAt: null,
    lastAttemptAt: null,
  });
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizeScore(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, value));
}

function normalizeEvidence(candidate: unknown): ResonanceTutorialLessonEvidence {
  const source = asRecord(candidate);
  if (!source) return emptyEvidence();
  const attempts = typeof source.attempts === "number" && Number.isFinite(source.attempts)
    ? Math.max(0, Math.floor(source.attempts))
    : 0;
  const normalizedFirstPassedAt = normalizeTimestamp(source.firstPassedAt);
  const passed = source.passed === true && attempts > 0 && normalizedFirstPassedAt !== null;
  const lastScore = source.lastScore === null || source.lastScore === undefined
    ? null
    : normalizeScore(source.lastScore);
  return Object.freeze({
    attempts,
    passed,
    bestScore: normalizeScore(source.bestScore),
    lastScore,
    firstPassedAt: passed ? normalizedFirstPassedAt : null,
    lastAttemptAt: attempts > 0 ? normalizeTimestamp(source.lastAttemptAt) : null,
  });
}

export function createDefaultResonanceTutorialProgress(): ResonanceTutorialProgress {
  const lessons = Object.fromEntries(
    RESONANCE_TUTORIAL_LESSON_IDS.map((lessonId) => [lessonId, emptyEvidence()]),
  ) as Record<ResonanceTutorialLessonId, ResonanceTutorialLessonEvidence>;
  return Object.freeze({ lessons: Object.freeze(lessons) });
}

export const DEFAULT_RESONANCE_TUTORIAL_PROGRESS = createDefaultResonanceTutorialProgress();

/**
 * Normalize only authored lesson ids. Completion is evidence-backed and unlocks
 * are always derived, so malformed or future fields cannot skip the sequence.
 */
export function normalizeResonanceTutorialProgress(candidate: unknown): ResonanceTutorialProgress {
  const source = asRecord(candidate);
  const lessonSource = asRecord(source?.lessons);
  const lessons = Object.fromEntries(RESONANCE_TUTORIAL_LESSON_IDS.map((lessonId) => [
    lessonId,
    normalizeEvidence(lessonSource?.[lessonId]),
  ])) as Record<ResonanceTutorialLessonId, ResonanceTutorialLessonEvidence>;
  return Object.freeze({ lessons: Object.freeze(lessons) });
}

function requireLessonId(value: unknown): ResonanceTutorialLessonId {
  if (typeof value === "string" && (RESONANCE_TUTORIAL_LESSON_IDS as readonly string[]).includes(value)) {
    return value as ResonanceTutorialLessonId;
  }
  throw new RangeError(`Unknown Resonance tutorial lesson: ${String(value)}`);
}

function requireScore(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("Resonance tutorial score must be from zero through 100.");
  }
  return value;
}

function requireTimestamp(value: string): string {
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) throw new RangeError("Resonance tutorial attempt time must be valid.");
  return timestamp;
}

export function isResonanceTutorialLessonUnlocked(
  progress: Readonly<ResonanceTutorialProgress>,
  lessonId: ResonanceTutorialLessonId,
): boolean {
  const normalized = normalizeResonanceTutorialProgress(progress);
  const resolvedId = requireLessonId(lessonId);
  const index = RESONANCE_TUTORIAL_LESSON_IDS.indexOf(resolvedId);
  return RESONANCE_TUTORIAL_LESSON_IDS.slice(0, index).every((priorId) => (
    normalized.lessons[priorId].passed
  ));
}

export function recordResonanceTutorialAttempt(
  current: Readonly<ResonanceTutorialProgress>,
  attempt: Readonly<ResonanceTutorialAttempt>,
  completedAt: string,
): ResonanceTutorialProgress {
  const progress = normalizeResonanceTutorialProgress(current);
  const lessonId = requireLessonId(attempt.lessonId);
  const score = requireScore(attempt.score);
  const timestamp = requireTimestamp(completedAt);
  if (!isResonanceTutorialLessonUnlocked(progress, lessonId)) {
    throw new RangeError(`Resonance tutorial lesson ${lessonId} is locked.`);
  }
  const previous = progress.lessons[lessonId];
  const passed = previous.passed || attempt.passed;
  const nextEvidence: ResonanceTutorialLessonEvidence = Object.freeze({
    attempts: previous.attempts + 1,
    passed,
    bestScore: Math.max(previous.bestScore, score),
    lastScore: score,
    firstPassedAt: previous.firstPassedAt ?? (attempt.passed ? timestamp : null),
    lastAttemptAt: timestamp,
  });
  return Object.freeze({
    lessons: Object.freeze({ ...progress.lessons, [lessonId]: nextEvidence }),
  });
}

export function completedResonanceTutorialLessonCount(
  progress: Readonly<ResonanceTutorialProgress>,
): number {
  const normalized = normalizeResonanceTutorialProgress(progress);
  return RESONANCE_TUTORIAL_LESSON_IDS.reduce(
    (count, lessonId) => count + (normalized.lessons[lessonId].passed ? 1 : 0),
    0,
  );
}

export function nextResonanceTutorialLessonId(
  progress: Readonly<ResonanceTutorialProgress>,
): ResonanceTutorialLessonId | null {
  const normalized = normalizeResonanceTutorialProgress(progress);
  return RESONANCE_TUTORIAL_LESSON_IDS.find((lessonId) => (
    !normalized.lessons[lessonId].passed
    && isResonanceTutorialLessonUnlocked(normalized, lessonId)
  )) ?? null;
}

export function resonanceTutorialMechanicIsProven(
  progress: Readonly<ResonanceTutorialProgress>,
  mechanic: ResonanceTutorialMechanic,
): boolean {
  if (!(MECHANIC_ORDER as readonly string[]).includes(mechanic)) {
    throw new RangeError(`Unknown Resonance tutorial mechanic: ${String(mechanic)}`);
  }
  const normalized = normalizeResonanceTutorialProgress(progress);
  return RESONANCE_TUTORIAL_LESSON_IDS
    .filter((lessonId) => lessonId.startsWith(`${mechanic}-`))
    .every((lessonId) => normalized.lessons[lessonId].passed);
}

export function resonanceCombinedChambersUnlocked(
  progress: Readonly<ResonanceTutorialProgress>,
): boolean {
  return completedResonanceTutorialLessonCount(progress) === RESONANCE_TUTORIAL_LESSON_IDS.length;
}
