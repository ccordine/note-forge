import { describe, expect, it } from "vitest";
import {
  TONE_MAP_BLIND_CORRECT_REQUIRED,
  TONE_MAP_GUIDED_CORRECT_REQUIRED,
  TONE_MAP_KEYBOARD_SKILLS,
  advanceToneMapLevel,
  createToneMapCourse,
  createToneMapSimonSequence,
  recordToneMapTaskResult,
  restoreToneMapCourse,
  setToneMapProductionEligibility,
  summarizeToneMapLevel,
  toneMapActiveMidis,
  toneMapLevelMidis,
  type ToneMapCourseState,
  type ToneMapCueVisibility,
} from "../apps/web/src/features/ear-training/tone-map-model";
import { isToneMapProductionMidiSupported } from "../apps/web/src/features/ear-training/tone-map-production-range";

function answer(
  course: ToneMapCourseState,
  midi: number,
  cueVisibility: ToneMapCueVisibility,
): ToneMapCourseState {
  return recordToneMapTaskResult(course, {
    midi,
    skill: "identification",
    challengeKind: "keyboard-identification",
    cueVisibility,
  }, "correct");
}

function stabilize(course: ToneMapCourseState, midis: readonly number[]): ToneMapCourseState {
  let next = course;
  for (const midi of midis) {
    for (let count = 0; count < TONE_MAP_GUIDED_CORRECT_REQUIRED; count += 1) {
      next = answer(next, midi, "guided");
    }
    for (let count = 0; count < TONE_MAP_BLIND_CORRECT_REQUIRED; count += 1) {
      next = answer(next, midi, "blind");
    }
  }
  return next;
}

describe("tone-map strict course validation", () => {
  it("hard-excludes unsupported production MIDI in every new course and restored course", () => {
    const course = createToneMapCourse("production-defaults");
    for (let midi = 21; midi <= 108; midi += 1) {
      expect(course.tones[midi]!.productionEligibility).toBe(
        isToneMapProductionMidiSupported(midi) ? "unassessed" : "unreachable",
      );
    }
    expect(restoreToneMapCourse(JSON.parse(JSON.stringify(course)))).toEqual(course);
    expect(() => setToneMapProductionEligibility(course, 29, "reachable")).toThrow(/supported/i);
    expect(() => setToneMapProductionEligibility(course, 87, "unassessed")).toThrow(/supported/i);
  });

  it("preserves explicit in-range eligibility, including preclassified future tones", () => {
    let course = createToneMapCourse("eligibility-restore");
    const futureSupported = course.order
      .slice(6)
      .filter(isToneMapProductionMidiSupported)
      .slice(0, 2);
    expect(futureSupported).toHaveLength(2);
    course = setToneMapProductionEligibility(course, futureSupported[0]!, "reachable");
    course = setToneMapProductionEligibility(course, futureSupported[1]!, "unreachable");

    const restored = restoreToneMapCourse(JSON.parse(JSON.stringify(course)));
    expect(restored.tones[futureSupported[0]!]!.productionEligibility).toBe("reachable");
    expect(restored.tones[futureSupported[1]!]!.productionEligibility).toBe("unreachable");
  });

  it("rejects learning evidence before a tone is introduced", () => {
    let course = createToneMapCourse("future-evidence");
    const activeMidi = course.order[0]!;
    const futureMidi = course.order[6]!;
    course = answer(course, activeMidi, "guided");
    const candidate = JSON.parse(JSON.stringify(course));
    candidate.tones[futureMidi].identification = candidate.tones[activeMidi].identification;

    expect(() => restoreToneMapCourse(candidate)).toThrow(/before its course level/i);
  });

  it("rejects confirmation attributed to a level beyond the restored course", () => {
    const course = createToneMapCourse("future-confirmation");
    const candidate = JSON.parse(JSON.stringify(course));
    candidate.tones[course.order[0]!].identification.lastBlindConfirmedLevel = 2;

    expect(() => restoreToneMapCourse(candidate)).toThrow(/future-level confirmation/i);
  });

  it("rejects a stable flag without a completed current-level blind proof", () => {
    let course = createToneMapCourse("unproved-stability");
    const midi = course.order[0]!;
    course = stabilize(course, [midi]);
    const candidate = JSON.parse(JSON.stringify(course));
    candidate.tones[midi].identification.lastBlindConfirmedLevel = null;

    expect(() => restoreToneMapCourse(candidate)).toThrow(/completed current-level blind proof/i);
  });

  it("requires a fresh three-answer blind proof for every retained active tone", () => {
    let course = createToneMapCourse("retention-gate");
    const firstLevel = toneMapActiveMidis(course);
    course = stabilize(course, firstLevel);
    course = advanceToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS);
    expect(course.currentLevel).toBe(2);

    course = stabilize(course, toneMapLevelMidis(course));
    const beforeRetention = summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS);
    expect(beforeRetention.identification.allStable).toBe(false);
    expect(beforeRetention.identification.stableMidis).toHaveLength(6);
    expect(beforeRetention.identification.blindConfirmedMidis).toHaveLength(6);
    expect(beforeRetention.identification.hasCurrentLevelBlindConfirmation).toBe(false);
    expect(beforeRetention.canAdvance).toBe(false);

    for (const midi of firstLevel) course = answer(course, midi, "blind");
    const afterOneCorrect = summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS);
    expect(afterOneCorrect.identification.stableMidis).toHaveLength(6);
    expect(afterOneCorrect.identification.blindConfirmedMidis).toHaveLength(6);
    expect(afterOneCorrect.canAdvance).toBe(false);

    for (const midi of firstLevel) course = answer(course, midi, "blind");
    for (const midi of firstLevel) course = answer(course, midi, "blind");
    const retained = summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS);
    expect(retained.identification.blindConfirmedMidis).toHaveLength(12);
    expect(retained.identification.hasCurrentLevelBlindConfirmation).toBe(true);
    expect(retained.canAdvance).toBe(true);
  });

  it.each([0, 1, 9, 2.5])("rejects out-of-contract Simon length %s", (length) => {
    expect(() => createToneMapSimonSequence(createToneMapCourse("length"), {
      seed: "sequence",
      length,
    })).toThrow(/2 through 8/i);
  });
});
