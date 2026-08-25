import { describe, expect, it } from "vitest";
import { toneMapAcceptedAttempt } from "../apps/web/src/features/ear-training/tone-map-attempt-history";
import { createToneMapCourse } from "../apps/web/src/features/ear-training/tone-map-model";
import {
  createToneMapSession,
  reduceToneMapSession,
} from "../apps/web/src/features/ear-training/tone-map-session";

describe("Tone Map accepted-attempt history", () => {
  it("derives one stable record only from the reducer-accepted commitment", () => {
    const initial = createToneMapSession(createToneMapCourse("history"), "keyboard", "first");
    expect(toneMapAcceptedAttempt(initial)).toBeNull();

    const action = {
      type: "answer-midi" as const,
      midi: initial.task!.midi,
      trialOrdinal: initial.trialOrdinal,
      attemptId: "accepted-attempt-id",
      committedAt: "2026-08-25T12:34:56.000Z",
    };
    const accepted = reduceToneMapSession(initial, action);
    const first = toneMapAcceptedAttempt(accepted);

    expect(toneMapAcceptedAttempt(accepted)).toEqual(first);
    expect(first).toMatchObject({
      id: "accepted-attempt-id",
      exerciseType: "pitch.absolute.identification.tone_map",
      metrics: { correct: 1 },
      startedAt: action.committedAt,
      completedAt: action.committedAt,
    });
  });

  it("cannot turn a rejected duplicate action into a second history id", () => {
    const initial = createToneMapSession(createToneMapCourse("history-duplicate"), "keyboard", "first");
    const accepted = reduceToneMapSession(initial, {
      type: "answer-midi",
      midi: initial.task!.midi,
      trialOrdinal: initial.trialOrdinal,
      attemptId: "first-id",
      committedAt: "2026-08-25T12:00:00.000Z",
    });
    const duplicate = reduceToneMapSession(accepted, {
      type: "answer-midi",
      midi: initial.task!.midi,
      trialOrdinal: initial.trialOrdinal,
      attemptId: "duplicate-id",
      committedAt: "2026-08-25T12:00:01.000Z",
    });

    expect(duplicate).toBe(accepted);
    expect(toneMapAcceptedAttempt(duplicate)?.id).toBe("first-id");
  });
});
