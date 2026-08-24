import { describe, expect, it } from "vitest";

import {
  RESONANCE_TUTORIAL_LESSON_IDS,
} from "../apps/web/src/features/voice-arcade/resonance-tutorial";
import {
  completedResonanceTutorialLessonCount,
  createDefaultResonanceTutorialProgress,
  isResonanceTutorialLessonUnlocked,
  nextResonanceTutorialLessonId,
  normalizeResonanceTutorialProgress,
  recordResonanceTutorialAttempt,
  resonanceCombinedChambersUnlocked,
  resonanceTutorialMechanicIsProven,
} from "../apps/web/src/features/voice-arcade/resonance-tutorial-progress";

function passNext(
  progress: ReturnType<typeof createDefaultResonanceTutorialProgress>,
  index: number,
) {
  return recordResonanceTutorialAttempt(progress, {
    lessonId: RESONANCE_TUTORIAL_LESSON_IDS[index]!,
    passed: true,
    score: 88 + index % 10,
  }, new Date(Date.UTC(2026, 7, 23, 12, index)).toISOString());
}

describe("Resonance tutorial progression", () => {
  it("unlocks exactly one evidence-backed lesson at a time", () => {
    let progress = createDefaultResonanceTutorialProgress();
    expect(nextResonanceTutorialLessonId(progress)).toBe("force-discover");
    expect(isResonanceTutorialLessonUnlocked(progress, "force-discover")).toBe(true);
    expect(isResonanceTutorialLessonUnlocked(progress, "force-control")).toBe(false);

    progress = recordResonanceTutorialAttempt(progress, {
      lessonId: "force-discover",
      passed: false,
      score: 47,
    }, "2026-08-23T12:00:00.000Z");
    expect(nextResonanceTutorialLessonId(progress)).toBe("force-discover");
    expect(isResonanceTutorialLessonUnlocked(progress, "force-control")).toBe(false);

    progress = recordResonanceTutorialAttempt(progress, {
      lessonId: "force-discover",
      passed: true,
      score: 82,
    }, "2026-08-23T12:01:00.000Z");
    expect(nextResonanceTutorialLessonId(progress)).toBe("force-control");
    expect(isResonanceTutorialLessonUnlocked(progress, "force-control")).toBe(true);
    expect(progress.lessons["force-discover"]).toMatchObject({
      attempts: 2,
      passed: true,
      bestScore: 82,
      lastScore: 82,
      firstPassedAt: "2026-08-23T12:01:00.000Z",
    });
  });

  it("does not let locked, malformed, or out-of-range evidence bypass the sequence", () => {
    const progress = createDefaultResonanceTutorialProgress();
    expect(() => recordResonanceTutorialAttempt(progress, {
      lessonId: "pitch-discover",
      passed: true,
      score: 100,
    }, "2026-08-23T12:00:00.000Z")).toThrow(/locked/i);
    expect(() => recordResonanceTutorialAttempt(progress, {
      lessonId: "force-discover",
      passed: true,
      score: 101,
    }, "2026-08-23T12:00:00.000Z")).toThrow(RangeError);
    expect(() => recordResonanceTutorialAttempt(progress, {
      lessonId: "force-discover",
      passed: true,
      score: 80,
    }, "not-a-time")).toThrow(RangeError);

    const malformedLaterPass = normalizeResonanceTutorialProgress({
      lessons: {
        "force-control": {
          attempts: 1,
          passed: true,
          bestScore: 100,
          firstPassedAt: "2026-08-23T12:00:00.000Z",
          lastAttemptAt: "2026-08-23T12:00:00.000Z",
        },
      },
    });
    expect(isResonanceTutorialLessonUnlocked(malformedLaterPass, "force-apply")).toBe(false);
  });

  it("normalizes every authored id and ignores invented completion fields", () => {
    const normalized = normalizeResonanceTutorialProgress({
      lessons: {
        "force-discover": {
          attempts: 2.8,
          passed: true,
          bestScore: 500,
          lastScore: -4,
          firstPassedAt: "2026-08-23T12:00:00Z",
          lastAttemptAt: "invalid",
        },
        "invented-skip": { passed: true },
      },
    });

    expect(Object.keys(normalized.lessons)).toEqual(RESONANCE_TUTORIAL_LESSON_IDS);
    expect(normalized.lessons["force-discover"]).toMatchObject({
      attempts: 2,
      passed: true,
      bestScore: 100,
      lastScore: 0,
      firstPassedAt: "2026-08-23T12:00:00.000Z",
      lastAttemptAt: null,
    });
    expect(completedResonanceTutorialLessonCount(normalized)).toBe(1);
    expect(resonanceCombinedChambersUnlocked(normalized)).toBe(false);
  });

  it("requires all three proofs before a mechanic and all twelve before combination", () => {
    let progress = createDefaultResonanceTutorialProgress();
    for (let index = 0; index < RESONANCE_TUTORIAL_LESSON_IDS.length; index += 1) {
      progress = passNext(progress, index);
      if (index === 1) expect(resonanceTutorialMechanicIsProven(progress, "force")).toBe(false);
      if (index === 2) expect(resonanceTutorialMechanicIsProven(progress, "force")).toBe(true);
    }

    expect(completedResonanceTutorialLessonCount(progress)).toBe(12);
    expect(nextResonanceTutorialLessonId(progress)).toBeNull();
    expect(resonanceCombinedChambersUnlocked(progress)).toBe(true);
  });
});
