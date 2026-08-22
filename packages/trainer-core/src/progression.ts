import type { SkillState } from "./types";

export interface SkillObservation {
  /** Exercise-specific accuracy normalized to 0–1. */
  accuracy: number;
  responseTimeMs?: number;
  confidence?: number;
  difficulty?: number;
  correct?: boolean;
  expectedAnswer?: unknown;
  givenAnswer?: unknown;
  /** Optional stable key for richer domain-specific confusion models. */
  confusionKey?: string;
  practicedAt?: Date;
}

export interface SkillProgressionOptions {
  recentAccuracyAlpha?: number;
  longTermAccuracyAlpha?: number;
  masteryAlpha?: number;
  confidenceAlpha?: number;
  difficultyAlpha?: number;
  difficultExerciseCredit?: number;
  lapseIntervalMinutes?: number;
  baseIntervalDays?: number;
  maximumIntervalDays?: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const finiteOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

export const createInitialSkillState = (skillId: string, difficulty = 0.5): SkillState => ({
  skillId,
  mastery: 0,
  difficulty: clamp(finiteOr(difficulty, 0.5), 0, 1),
  attemptCount: 0,
  recentAccuracy: 0,
  longTermAccuracy: 0,
  confidence: 0,
  commonConfusions: {},
});

const answerLabel = (answer: unknown): string => {
  if (typeof answer === "string") return answer;
  if (answer === undefined) return "unknown";
  try {
    return JSON.stringify(answer) ?? String(answer);
  } catch {
    return String(answer);
  }
};

export const confusionKeyFor = (expectedAnswer: unknown, givenAnswer: unknown): string =>
  `${answerLabel(expectedAnswer)} → ${answerLabel(givenAnswer)}`;

export const recordSkillConfusion = (
  state: SkillState,
  confusionKey: string,
  increment = 1,
): SkillState => ({
  ...state,
  commonConfusions: {
    ...state.commonConfusions,
    [confusionKey]: (state.commonConfusions[confusionKey] ?? 0) + Math.max(0, increment),
  },
});

export interface DueDateInput {
  accuracy: number;
  mastery: number;
  attemptCount: number;
  practicedAt: Date;
}

export const calculateNextDueDate = (
  input: DueDateInput,
  options: SkillProgressionOptions = {},
): Date => {
  const accuracy = clamp(finiteOr(input.accuracy, 0), 0, 1);
  const mastery = clamp(finiteOr(input.mastery, 0), 0, 1);
  const practicedAtMs = input.practicedAt.getTime();
  if (!Number.isFinite(practicedAtMs)) throw new TypeError("practicedAt must be a valid Date.");
  if (accuracy < 0.55) {
    const lapseMinutes = Math.max(1, finiteOr(options.lapseIntervalMinutes, 10));
    return new Date(practicedAtMs + lapseMinutes * MINUTE_MS);
  }
  const baseIntervalDays = Math.max(1 / 24, finiteOr(options.baseIntervalDays, 1));
  const maximumIntervalDays = Math.max(baseIntervalDays, finiteOr(options.maximumIntervalDays, 90));
  const repetitions = Math.sqrt(Math.max(1, input.attemptCount));
  const qualityFactor = 0.6 + accuracy * 0.8;
  const masteryFactor = 0.75 + mastery * 4.25;
  const intervalDays = Math.min(
    maximumIntervalDays,
    baseIntervalDays * repetitions * qualityFactor * masteryFactor,
  );
  return new Date(practicedAtMs + intervalDays * DAY_MS);
};

/** Applies one exercise observation without depending on its UI or audio source. */
export const updateSkillState = (
  previous: SkillState | undefined,
  skillId: string,
  observation: SkillObservation,
  options: SkillProgressionOptions = {},
): SkillState => {
  if (!skillId) throw new TypeError("skillId is required.");
  if (!Number.isFinite(observation.accuracy)) {
    throw new TypeError("observation.accuracy must be finite.");
  }
  const state = previous ?? createInitialSkillState(skillId, observation.difficulty);
  if (state.skillId !== skillId) {
    throw new Error(`Cannot apply an observation for ${skillId} to state ${state.skillId}.`);
  }
  const accuracy = clamp(observation.accuracy, 0, 1);
  const attemptCount = state.attemptCount + 1;
  const practicedAt = observation.practicedAt ?? new Date();
  if (!Number.isFinite(practicedAt.getTime())) throw new TypeError("practicedAt must be a valid Date.");

  const recentAlpha = clamp(finiteOr(options.recentAccuracyAlpha, 0.35), 0, 1);
  const longTermAlpha = clamp(finiteOr(options.longTermAccuracyAlpha, 0.08), 0, 1);
  const masteryAlpha = clamp(finiteOr(options.masteryAlpha, 0.22), 0, 1);
  const confidenceAlpha = clamp(finiteOr(options.confidenceAlpha, 0.2), 0, 1);
  const difficultyAlpha = clamp(finiteOr(options.difficultyAlpha, 0.2), 0, 1);
  const observedDifficulty = clamp(
    finiteOr(observation.difficulty, state.difficulty + (accuracy - 0.7) * 0.08),
    0,
    1,
  );
  const difficultExerciseCredit = finiteOr(options.difficultExerciseCredit, 0.15);
  const adjustedPerformance = clamp(
    accuracy + (observedDifficulty - 0.5) * difficultExerciseCredit,
    0,
    1,
  );

  const recentAccuracy =
    state.attemptCount === 0
      ? accuracy
      : state.recentAccuracy + recentAlpha * (accuracy - state.recentAccuracy);
  const longTermAccuracy =
    state.attemptCount === 0
      ? accuracy
      : state.longTermAccuracy + longTermAlpha * (accuracy - state.longTermAccuracy);
  const mastery = clamp(
    state.mastery + masteryAlpha * (adjustedPerformance - state.mastery),
    0,
    1,
  );
  const observationConfidence = clamp(finiteOr(observation.confidence, 1), 0, 1);
  const confidence =
    state.attemptCount === 0
      ? observationConfidence
      : state.confidence + confidenceAlpha * (observationConfidence - state.confidence);
  const difficulty =
    state.attemptCount === 0
      ? observedDifficulty
      : state.difficulty + difficultyAlpha * (observedDifficulty - state.difficulty);
  const responseTimeMs = observation.responseTimeMs;
  const averageResponseTimeMs =
    responseTimeMs !== undefined && Number.isFinite(responseTimeMs) && responseTimeMs >= 0
      ? state.averageResponseTimeMs === undefined
        ? responseTimeMs
        : state.averageResponseTimeMs +
          (responseTimeMs - state.averageResponseTimeMs) / attemptCount
      : state.averageResponseTimeMs;

  const isCorrect = observation.correct ?? accuracy >= 0.5;
  const confusionKey =
    observation.confusionKey ??
    (!isCorrect && observation.givenAnswer !== undefined
      ? confusionKeyFor(observation.expectedAnswer, observation.givenAnswer)
      : undefined);
  const commonConfusions = { ...state.commonConfusions };
  if (!isCorrect && confusionKey) {
    commonConfusions[confusionKey] = (commonConfusions[confusionKey] ?? 0) + 1;
  }
  const dueAt = calculateNextDueDate(
    { accuracy, mastery, attemptCount, practicedAt },
    options,
  ).toISOString();

  return {
    skillId,
    mastery,
    difficulty,
    attemptCount,
    recentAccuracy,
    longTermAccuracy,
    averageResponseTimeMs,
    confidence,
    commonConfusions,
    lastPracticedAt: practicedAt.toISOString(),
    dueAt,
  };
};

export interface SkillObservationEntry {
  skillId: string;
  observation: SkillObservation;
}

export const updateSkillStates = (
  states: Readonly<Record<string, SkillState | undefined>>,
  observations: readonly SkillObservationEntry[],
  options: SkillProgressionOptions = {},
): Record<string, SkillState> => {
  const result: Record<string, SkillState> = {};
  for (const [skillId, state] of Object.entries(states)) {
    if (state) result[skillId] = state;
  }
  for (const entry of observations) {
    result[entry.skillId] = updateSkillState(
      result[entry.skillId],
      entry.skillId,
      entry.observation,
      options,
    );
  }
  return result;
};
