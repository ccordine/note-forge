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
const MAX_SKILL_ID_LENGTH = 128;
const MAX_CONFUSION_KEY_LENGTH = 256;
const UNSAFE_DICTIONARY_KEYS = new Set(
  [...Object.getOwnPropertyNames(Object.prototype), "prototype"],
);

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const finiteOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

function requireSkillId(skillId: string): void {
  if (typeof skillId !== "string" || skillId.trim().length === 0) {
    throw new TypeError("skillId is required.");
  }
  if (skillId.length > MAX_SKILL_ID_LENGTH) {
    throw new RangeError(`skillId cannot exceed ${MAX_SKILL_ID_LENGTH} characters.`);
  }
  if (UNSAFE_DICTIONARY_KEYS.has(skillId)) {
    throw new RangeError("skillId cannot name an object-prototype property.");
  }
}

function requireConfusionKey(confusionKey: string, label = "confusionKey"): void {
  if (typeof confusionKey !== "string" || confusionKey.trim().length === 0) {
    throw new TypeError(`${label} is required.`);
  }
  if (confusionKey.length > MAX_CONFUSION_KEY_LENGTH) {
    throw new RangeError(`${label} cannot exceed ${MAX_CONFUSION_KEY_LENGTH} characters.`);
  }
  if (UNSAFE_DICTIONARY_KEYS.has(confusionKey)) {
    throw new RangeError(`${label} cannot name an object-prototype property.`);
  }
}

function requireUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number from zero through one.`);
  }
}

function requireFiniteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative.`);
  }
}

function validateSkillState(state: Readonly<SkillState>): void {
  requireSkillId(state.skillId);
  if (!Number.isSafeInteger(state.attemptCount) || state.attemptCount < 0) {
    throw new RangeError("state.attemptCount must be a non-negative safe integer.");
  }
  for (const [label, value] of [
    ["state.mastery", state.mastery],
    ["state.difficulty", state.difficulty],
    ["state.recentAccuracy", state.recentAccuracy],
    ["state.longTermAccuracy", state.longTermAccuracy],
    ["state.confidence", state.confidence],
  ] as const) {
    requireUnitInterval(value, label);
  }
  if (state.averageResponseTimeMs !== undefined) {
    requireFiniteNonnegative(state.averageResponseTimeMs, "state.averageResponseTimeMs");
  }
  if (!state.commonConfusions || typeof state.commonConfusions !== "object" ||
    Array.isArray(state.commonConfusions)) {
    throw new TypeError("state.commonConfusions must be a plain record.");
  }
  const confusionPrototype = Object.getPrototypeOf(state.commonConfusions);
  if (confusionPrototype !== Object.prototype && confusionPrototype !== null) {
    throw new TypeError("state.commonConfusions must be a plain record.");
  }
  const confusionEntries = Object.entries(state.commonConfusions);
  for (const [key, count] of confusionEntries) {
    requireConfusionKey(key, "state.commonConfusions key");
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("state.commonConfusions must contain non-negative safe-integer counts.");
    }
  }
  for (const [label, value] of [
    ["state.lastPracticedAt", state.lastPracticedAt],
    ["state.dueAt", state.dueAt],
  ] as const) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new RangeError(`${label} must be a valid timestamp when present.`);
    }
  }
}

export const createInitialSkillState = (skillId: string, difficulty = 0.5): SkillState => {
  requireSkillId(skillId);
  requireUnitInterval(difficulty, "difficulty");
  return {
    skillId,
    mastery: 0,
    difficulty,
    attemptCount: 0,
    recentAccuracy: 0,
    longTermAccuracy: 0,
    confidence: 0,
    commonConfusions: {},
  };
};

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
  {
    const key = `${answerLabel(expectedAnswer)} → ${answerLabel(givenAnswer)}`;
    requireConfusionKey(key);
    return key;
  };

export const recordSkillConfusion = (
  state: SkillState,
  confusionKey: string,
  increment = 1,
): SkillState => {
  validateSkillState(state);
  requireConfusionKey(confusionKey);
  if (!Number.isSafeInteger(increment) || increment <= 0) {
    throw new RangeError("increment must be a positive safe integer.");
  }
  const hasExistingKey = Object.hasOwn(state.commonConfusions, confusionKey);
  const current = hasExistingKey ? state.commonConfusions[confusionKey] : 0;
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new RangeError("Existing confusion counts must be non-negative safe integers.");
  }
  const nextCount = current + increment;
  if (!Number.isSafeInteger(nextCount)) {
    throw new RangeError("The confusion count would exceed the safe-integer range.");
  }
  return {
    ...state,
    commonConfusions: {
      ...state.commonConfusions,
      [confusionKey]: nextCount,
    },
  };
};

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
  requireUnitInterval(input.accuracy, "accuracy");
  requireUnitInterval(input.mastery, "mastery");
  const accuracy = input.accuracy;
  const mastery = input.mastery;
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) {
    throw new RangeError("attemptCount must be a non-negative safe integer.");
  }
  const practicedAtMs = input.practicedAt.getTime();
  if (!Number.isFinite(practicedAtMs)) throw new TypeError("practicedAt must be a valid Date.");
  const lapseMinutes = options.lapseIntervalMinutes ?? 10;
  const baseIntervalDays = options.baseIntervalDays ?? 1;
  const maximumIntervalDays = options.maximumIntervalDays ?? 90;
  requireFiniteNonnegative(lapseMinutes, "lapseIntervalMinutes");
  requireFiniteNonnegative(baseIntervalDays, "baseIntervalDays");
  requireFiniteNonnegative(maximumIntervalDays, "maximumIntervalDays");
  if (lapseMinutes === 0) throw new RangeError("lapseIntervalMinutes must be greater than zero.");
  if (baseIntervalDays === 0) throw new RangeError("baseIntervalDays must be greater than zero.");
  if (maximumIntervalDays < baseIntervalDays) {
    throw new RangeError("maximumIntervalDays cannot be shorter than baseIntervalDays.");
  }
  if (accuracy < 0.55) {
    const dueAt = new Date(practicedAtMs + lapseMinutes * MINUTE_MS);
    if (!Number.isFinite(dueAt.getTime())) {
      throw new RangeError("The calculated due date is outside the representable date range.");
    }
    return dueAt;
  }
  const repetitions = Math.sqrt(Math.max(1, input.attemptCount));
  const qualityFactor = 0.6 + accuracy * 0.8;
  const masteryFactor = 0.75 + mastery * 4.25;
  const intervalDays = Math.min(
    maximumIntervalDays,
    baseIntervalDays * repetitions * qualityFactor * masteryFactor,
  );
  const dueAt = new Date(practicedAtMs + intervalDays * DAY_MS);
  if (!Number.isFinite(dueAt.getTime())) {
    throw new RangeError("The calculated due date is outside the representable date range.");
  }
  return dueAt;
};

/** Applies one exercise observation without depending on its UI or audio source. */
export const updateSkillState = (
  previous: SkillState | undefined,
  skillId: string,
  observation: SkillObservation,
  options: SkillProgressionOptions = {},
): SkillState => {
  requireSkillId(skillId);
  requireUnitInterval(observation.accuracy, "observation.accuracy");
  const state = previous ?? createInitialSkillState(skillId, observation.difficulty);
  validateSkillState(state);
  if (state.skillId !== skillId) {
    throw new Error(`Cannot apply an observation for ${skillId} to state ${state.skillId}.`);
  }
  if (observation.confidence !== undefined) {
    requireUnitInterval(observation.confidence, "observation.confidence");
  }
  if (observation.difficulty !== undefined) {
    requireUnitInterval(observation.difficulty, "observation.difficulty");
  }
  if (observation.responseTimeMs !== undefined) {
    requireFiniteNonnegative(observation.responseTimeMs, "observation.responseTimeMs");
  }
  for (const [name, value] of [
    ["recentAccuracyAlpha", options.recentAccuracyAlpha],
    ["longTermAccuracyAlpha", options.longTermAccuracyAlpha],
    ["masteryAlpha", options.masteryAlpha],
    ["confidenceAlpha", options.confidenceAlpha],
    ["difficultyAlpha", options.difficultyAlpha],
  ] as const) {
    if (value !== undefined) requireUnitInterval(value, name);
  }
  if (options.difficultExerciseCredit !== undefined) {
    requireFiniteNonnegative(options.difficultExerciseCredit, "difficultExerciseCredit");
  }
  const accuracy = observation.accuracy;
  if (state.attemptCount === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("state.attemptCount cannot be incremented beyond the safe-integer range.");
  }
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
  if (confusionKey !== undefined) requireConfusionKey(confusionKey, "observation.confusionKey");
  const commonConfusions = { ...state.commonConfusions };
  if (!isCorrect && confusionKey) {
    const hasExistingKey = Object.hasOwn(commonConfusions, confusionKey);
    const currentCount = hasExistingKey ? commonConfusions[confusionKey] : 0;
    if (currentCount === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("The confusion count cannot be incremented beyond the safe-integer range.");
    }
    commonConfusions[confusionKey] = currentCount + 1;
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
    if (state) {
      validateSkillState(state);
      if (state.skillId !== skillId) {
        throw new RangeError(`State ${state.skillId} is stored under ${skillId}.`);
      }
      result[skillId] = state;
    }
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
