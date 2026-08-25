import { describe, expect, it } from "vitest";
import {
  TONE_MAP_GUIDED_CORRECT_REQUIRED,
  createToneMapCourse,
  recordToneMapTaskResult,
  setToneMapProductionEligibility,
  summarizeToneMapLevel,
  toneMapActiveMidis,
} from "../apps/web/src/features/ear-training/tone-map-model";
import {
  createToneMapSession,
  reduceToneMapSession,
  toneMapRequiredSkills,
  type ToneMapSessionState,
} from "../apps/web/src/features/ear-training/tone-map-session";

let answerSequence = 0;

function answerAction(state: ToneMapSessionState, midi: number) {
  answerSequence += 1;
  return {
    type: "answer-midi" as const,
    midi,
    trialOrdinal: state.trialOrdinal,
    attemptId: `attempt-${answerSequence}`,
    committedAt: "2026-08-25T12:00:00.000Z",
  };
}

describe("tone-map single-trial session", () => {
  it("requires an explicit answer before Next and avoids an immediate MIDI repeat", () => {
    const initial = createToneMapSession(createToneMapCourse("session"), "keyboard", "first");
    const ignored = reduceToneMapSession(initial, { type: "next", seed: "ignored" });
    expect(ignored).toBe(initial);

    const answered = reduceToneMapSession(initial, answerAction(initial, initial.task!.midi));
    expect(answered.answer).toMatchObject({ kind: "midi", correct: true });
    const next = reduceToneMapSession(answered, { type: "next", seed: "next" });
    expect(next.answer).toBeNull();
    expect(next.task?.midi).not.toBe(initial.task?.midi);
    expect(next.trialOrdinal).toBe(2);
  });

  it("records a miss only against the requested tone and requested skill", () => {
    const initial = createToneMapSession(createToneMapCourse("miss"), "keyboard", "first");
    const target = initial.task!.midi;
    const neighbor = toneMapActiveMidis(initial.course).find((midi) => midi !== target)!;
    const beforeNeighbor = initial.course.tones[neighbor];
    const wrongMidi = target === 21 ? 22 : 21;
    const missed = reduceToneMapSession(initial, answerAction(initial, wrongMidi));

    expect(missed.course.tones[target]!.identification).toMatchObject({
      attempts: 1,
      correct: 0,
      guidedStreak: 0,
    });
    expect(missed.course.tones[target]!.production.attempts).toBe(0);
    expect(missed.course.tones[neighbor]).toEqual(beforeNeighbor);
  });

  it("changes answer authority only by explicit mode selection", () => {
    const initial = createToneMapSession(createToneMapCourse("modes"), "keyboard", "first");
    const voice = reduceToneMapSession(initial, {
      type: "change-response-mode",
      responseMode: "voice",
      seed: "voice",
    });
    expect(voice.responseMode).toBe("voice");
    expect(voice.task?.skill).toBe("production");
    expect(voice.task?.challengeKind).toBe("voice-imitation");

    const answered = reduceToneMapSession(voice, answerAction(voice, voice.task!.midi));
    expect(reduceToneMapSession(answered, {
      type: "change-response-mode",
      responseMode: "keyboard",
      seed: "blocked-during-review",
    })).toBe(answered);
  });

  it("treats out-of-range production as neutral and supports explicit reconsideration", () => {
    const initial = createToneMapSession(createToneMapCourse("range"), "voice", "first");
    const target = initial.task!.midi;
    const excluded = reduceToneMapSession(initial, {
      type: "production-unreachable",
      trialOrdinal: initial.trialOrdinal,
    });
    expect(excluded.answer).toEqual({ kind: "production-unreachable" });
    expect(excluded.course.tones[target]!.productionEligibility).toBe("unreachable");
    expect(excluded.course.tones[target]!.production.attempts).toBe(0);
    expect(excluded.course.tones[target]!.identification.attempts).toBe(0);

    const retried = reduceToneMapSession(excluded, {
      type: "retry-excluded-production",
      seed: "retry",
    });
    expect(retried.course.tones[target]!.productionEligibility).toBe("reachable");
    expect(retried.answer).toBeNull();
  });

  it("promotes demonstrated correct production to persisted reachable eligibility", () => {
    let course = createToneMapCourse("demonstrated-range");
    const initialTask = createToneMapSession(course, "voice", "locate-target").task!;
    course = setToneMapProductionEligibility(course, initialTask.midi, "unassessed");
    const initial = createToneMapSession(course, "voice", "locate-target");
    const answered = reduceToneMapSession(initial, answerAction(initial, initial.task!.midi));

    expect(answered.answer).toMatchObject({ kind: "midi", correct: true });
    expect(answered.course.tones[initial.task!.midi]!.productionEligibility).toBe("reachable");
  });

  it("never retries production outside the shared detector's supported range", () => {
    let course = { ...createToneMapCourse("hard-range"), currentLevel: 15 };
    for (const midi of [21, 60, 108]) {
      course = setToneMapProductionEligibility(course, midi, "unreachable");
    }
    const initial = createToneMapSession(course, "voice", "first");
    const retried = reduceToneMapSession(initial, {
      type: "retry-excluded-production",
      seed: "retry-supported-only",
    });

    expect(retried.course.tones[21]!.productionEligibility).toBe("unreachable");
    expect(retried.course.tones[60]!.productionEligibility).toBe("reachable");
    expect(retried.course.tones[108]!.productionEligibility).toBe("unreachable");
  });

  it("advances a completed cumulative gate only through the explicit level action", () => {
    let course = createToneMapCourse("advance");
    for (const midi of toneMapActiveMidis(course)) {
      for (let count = 0; count < TONE_MAP_GUIDED_CORRECT_REQUIRED; count += 1) {
        const task = { midi, skill: "identification" as const, challengeKind: "keyboard-identification" as const, cueVisibility: "guided" as const };
        course = recordToneMapTaskResult(course, task, "correct");
      }
      for (let count = 0; count < 3; count += 1) {
        const task = { midi, skill: "identification" as const, challengeKind: "keyboard-identification" as const, cueVisibility: "blind" as const };
        course = recordToneMapTaskResult(course, task, "correct");
      }
    }
    expect(summarizeToneMapLevel(course, toneMapRequiredSkills("keyboard")).canAdvance).toBe(true);
    const session = createToneMapSession(course, "keyboard", "ready");
    expect(session.course.currentLevel).toBe(1);
    const advanced = reduceToneMapSession(session, { type: "advance-level", seed: "level-two" });
    expect(advanced.course.currentLevel).toBe(2);
    expect(advanced.task).not.toBeNull();
  });

  it("accepts one identified commitment per trial and rejects stale actions", () => {
    const initial = createToneMapSession(createToneMapCourse("identity"), "keyboard", "first");
    const firstAction = answerAction(initial, initial.task!.midi);
    const duplicateAction = answerAction(initial, initial.task!.midi);
    const accepted = reduceToneMapSession(initial, firstAction);

    expect(reduceToneMapSession(accepted, duplicateAction)).toBe(accepted);
    expect(accepted.answer).toMatchObject({
      kind: "midi",
      attemptId: firstAction.attemptId,
    });

    const next = reduceToneMapSession(accepted, { type: "next", seed: "next" });
    expect(reduceToneMapSession(next, duplicateAction)).toBe(next);
    expect(reduceToneMapSession(next, {
      type: "production-unreachable",
      trialOrdinal: initial.trialOrdinal,
    })).toBe(next);
  });
});
