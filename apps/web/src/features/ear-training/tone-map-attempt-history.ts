import type { LocalAttempt } from "@/storage/database";
import type { ToneMapSessionState } from "./tone-map-session";

/**
 * Only a reducer-accepted commitment can become history. The stable id makes
 * React effect replay an idempotent IndexedDB put rather than a duplicate row.
 */
export function toneMapAcceptedAttempt(
  session: Readonly<ToneMapSessionState>,
): LocalAttempt | null {
  const { answer, task } = session;
  if (task === null || answer?.kind !== "midi") return null;
  return {
    id: answer.attemptId,
    exerciseType: task.skill === "production"
      ? "pitch.absolute.production.tone_map"
      : "pitch.absolute.identification.tone_map",
    target: {
      midi: task.midi,
      answerMidi: answer.midi,
      skill: task.skill,
      challengeKind: task.challengeKind,
      cueVisibility: task.cueVisibility,
      trialOrdinal: session.trialOrdinal,
    },
    metrics: { correct: Number(answer.correct) },
    startedAt: answer.committedAt,
    completedAt: answer.committedAt,
  };
}
