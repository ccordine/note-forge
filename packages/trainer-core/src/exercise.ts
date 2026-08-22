import type { AttemptMetrics, ExerciseAttempt, HarmonicContext, PitchFrame } from "./types";

/** Audio-agnostic input that an exercise evaluator can turn into an attempt. */
export interface ExerciseObservation<TTarget = unknown, TAnswer = unknown> {
  id: string;
  exerciseType: string;
  target: TTarget;
  context?: HarmonicContext;
  answer?: TAnswer;
  pitchFrames?: readonly PitchFrame[];
  startedAt: Date;
  completedAt: Date;
}

export type ExerciseEvaluator<TTarget = unknown, TAnswer = unknown> = (
  observation: ExerciseObservation<TTarget, TAnswer>,
) => AttemptMetrics;

/** Materializes a storage-safe attempt while keeping evaluation injectable. */
export const evaluateExerciseObservation = <TTarget, TAnswer>(
  observation: ExerciseObservation<TTarget, TAnswer>,
  evaluator: ExerciseEvaluator<TTarget, TAnswer>,
): ExerciseAttempt<TTarget, TAnswer> => {
  if (observation.completedAt.getTime() < observation.startedAt.getTime()) {
    throw new RangeError("completedAt cannot precede startedAt.");
  }
  const result: ExerciseAttempt<TTarget, TAnswer> = {
    id: observation.id,
    exerciseType: observation.exerciseType,
    target: observation.target,
    metrics: evaluator(observation),
    startedAt: observation.startedAt.toISOString(),
    completedAt: observation.completedAt.toISOString(),
  };
  if (observation.context) result.context = observation.context;
  if (observation.answer !== undefined) result.answer = observation.answer;
  if (observation.pitchFrames) result.pitchFrames = [...observation.pitchFrames];
  return result;
};
