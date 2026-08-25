import { describe, expect, it } from "vitest";

import {
  TONE_MAP_BLIND_CORRECT_REQUIRED,
  TONE_MAP_GUIDED_CORRECT_REQUIRED,
  TONE_MAP_KEYBOARD_SKILLS,
  TONE_MAP_LEVEL_COUNT,
  TONE_MAP_LEVEL_SIZE,
  TONE_MAP_MAX_MIDI,
  TONE_MAP_MIN_MIDI,
  TONE_MAP_MIXED_SKILLS,
  TONE_MAP_TONE_COUNT,
  TONE_MAP_VOICE_SKILLS,
  advanceToneMapLevel,
  chooseToneMapTask,
  createToneMapCourse,
  createToneMapSimonSequence,
  recordToneMapTaskResult,
  restoreToneMapCourse,
  setToneMapProductionEligibility,
  summarizeToneMapLevel,
  toneMapActiveMidis,
  toneMapCueVisibility,
  toneMapLevelMidis,
  validateToneMapCourseOrder,
  type ToneMapChallengeKind,
  type ToneMapCourseState,
  type ToneMapCueVisibility,
  type ToneMapSkill,
  type ToneMapTask,
  type ToneMapTaskResult,
} from "../apps/web/src/features/ear-training/tone-map-model";
import { isToneMapProductionMidiSupported } from "../apps/web/src/features/ear-training/tone-map-production-range";
import {
  appendToneMapSimonAnswer,
  createToneMapSimonRound,
  gradeToneMapSimonRound,
  reduceToneMapSimonRound,
} from "../apps/web/src/features/ear-training/tone-map-simon-model";

function task(
  midi: number,
  skill: ToneMapSkill,
  cueVisibility: ToneMapCueVisibility,
  challengeKind?: ToneMapChallengeKind,
): ToneMapTask {
  return {
    midi,
    skill,
    cueVisibility,
    challengeKind: challengeKind ?? (skill === "identification" ? "keyboard-identification" : "voice-production"),
  };
}

function answer(
  course: ToneMapCourseState,
  midi: number,
  skill: ToneMapSkill,
  cueVisibility: ToneMapCueVisibility,
  result: ToneMapTaskResult,
): ToneMapCourseState {
  return recordToneMapTaskResult(course, task(midi, skill, cueVisibility), result);
}

function stabilize(
  course: ToneMapCourseState,
  midi: number,
  skill: ToneMapSkill,
): ToneMapCourseState {
  let next = course;
  for (let index = 0; index < TONE_MAP_GUIDED_CORRECT_REQUIRED; index += 1) {
    next = answer(next, midi, skill, "guided", "correct");
  }
  for (let index = 0; index < TONE_MAP_BLIND_CORRECT_REQUIRED; index += 1) {
    next = answer(next, midi, skill, "blind", "correct");
  }
  return next;
}

function stabilizeAll(
  course: ToneMapCourseState,
  midis: readonly number[],
  skill: ToneMapSkill,
): ToneMapCourseState {
  return midis.reduce((next, midi) => stabilize(next, midi, skill), course);
}

describe("tone-map course order and levels", () => {
  it("creates one deterministic shuffled permutation of the physical piano", () => {
    const first = createToneMapCourse("learner-42");
    const second = createToneMapCourse("learner-42");
    const chromatic = Array.from({ length: 88 }, (_, index) => 21 + index);

    expect(first.order).toEqual(second.order);
    expect(first.order).not.toEqual(chromatic);
    expect(first.order).toHaveLength(TONE_MAP_TONE_COUNT);
    expect([...first.order].sort((left, right) => left - right)).toEqual(chromatic);
    expect(Math.min(...first.order)).toBe(TONE_MAP_MIN_MIDI);
    expect(Math.max(...first.order)).toBe(TONE_MAP_MAX_MIDI);
  });

  it("strictly restores the persisted order instead of reshuffling it", () => {
    const original = createToneMapCourse("persistent-course");
    const serialized = JSON.stringify(original);
    const restored = restoreToneMapCourse(JSON.parse(serialized));

    expect(restored).toEqual(original);
    expect(restored.order).toEqual(original.order);
    expect(validateToneMapCourseOrder(restored.order)).toEqual(original.order);
  });

  it("rejects incomplete, duplicate, out-of-range, and fixed course orders", () => {
    const chromatic = Array.from({ length: TONE_MAP_TONE_COUNT }, (_, index) => TONE_MAP_MIN_MIDI + index);
    const duplicate = [...createToneMapCourse("duplicate").order];
    duplicate[1] = duplicate[0]!;
    const outOfRange = [...createToneMapCourse("range").order];
    outOfRange[0] = 109;

    expect(() => validateToneMapCourseOrder(chromatic.slice(1))).toThrow();
    expect(() => validateToneMapCourseOrder(duplicate)).toThrow(/repeat/i);
    expect(() => validateToneMapCourseOrder(outOfRange)).toThrow(/MIDI/i);
    expect(() => validateToneMapCourseOrder(chromatic)).toThrow(/shuffled/i);
  });

  it("chunks six new tones per level and keeps a cumulative active pool", () => {
    const course = createToneMapCourse("levels");
    const levelTwo = { ...course, currentLevel: 2 };
    const final = { ...course, currentLevel: TONE_MAP_LEVEL_COUNT };

    expect(TONE_MAP_LEVEL_SIZE).toBe(6);
    expect(TONE_MAP_LEVEL_COUNT).toBe(15);
    expect(toneMapLevelMidis(course)).toEqual(course.order.slice(0, 6));
    expect(toneMapLevelMidis(levelTwo)).toEqual(course.order.slice(6, 12));
    expect(toneMapActiveMidis(levelTwo)).toEqual(course.order.slice(0, 12));
    expect(toneMapLevelMidis(final)).toEqual(course.order.slice(84, 88));
    expect(toneMapActiveMidis(final)).toHaveLength(88);
  });
});

describe("guided, blind, and independent evidence", () => {
  it("requires two consecutive guided answers before ordinary scheduling becomes blind", () => {
    let course = createToneMapCourse("guided");
    const midi = course.order[0]!;

    expect(toneMapCueVisibility(course.tones[midi]!.identification)).toBe("guided");
    course = answer(course, midi, "identification", "guided", "correct");
    expect(toneMapCueVisibility(course.tones[midi]!.identification)).toBe("guided");
    course = answer(course, midi, "identification", "guided", "incorrect");
    expect(course.tones[midi]!.identification.guidedStreak).toBe(0);
    course = answer(course, midi, "identification", "guided", "correct");
    course = answer(course, midi, "identification", "guided", "correct");

    expect(toneMapCueVisibility(course.tones[midi]!.identification)).toBe("blind");
    expect(course.tones[midi]!.identification).toMatchObject({
      guidedAttempts: 4,
      guidedCorrect: 3,
      guidedStreak: 2,
      bestGuidedStreak: 2,
      stable: false,
    });
  });

  it("requires three consecutive blind answers and retains lifetime totals and bests", () => {
    let course = createToneMapCourse("blind");
    const midi = course.order[0]!;
    course = answer(course, midi, "identification", "guided", "correct");
    course = answer(course, midi, "identification", "guided", "correct");
    course = answer(course, midi, "identification", "blind", "correct");
    course = answer(course, midi, "identification", "blind", "correct");

    expect(course.tones[midi]!.identification.stable).toBe(false);
    course = answer(course, midi, "identification", "blind", "correct");
    expect(course.tones[midi]!.identification).toMatchObject({
      attempts: 5,
      correct: 5,
      correctStreak: 5,
      bestCorrectStreak: 5,
      blindAttempts: 3,
      blindCorrect: 3,
      blindStreak: 3,
      bestBlindStreak: 3,
      stable: true,
      lastBlindConfirmedLevel: 1,
    });
  });

  it("a blind miss reopens one guided recovery and resets only that skill and tone", () => {
    let course = createToneMapCourse("lapse");
    const [targetMidi, neighborMidi] = course.order;
    course = stabilize(course, targetMidi!, "identification");
    course = stabilize(course, targetMidi!, "production");
    course = stabilize(course, neighborMidi!, "identification");
    const productionBefore = course.tones[targetMidi!]!.production;
    const neighborBefore = course.tones[neighborMidi!]!.identification;
    course = answer(course, targetMidi!, "identification", "blind", "incorrect");
    const lapsed = course.tones[targetMidi!]!.identification;

    expect(lapsed).toMatchObject({
      blindStreak: 0,
      bestBlindStreak: 3,
      stable: false,
      lapses: 1,
      guidedRecoveryRemaining: 1,
      correct: 5,
      attempts: 6,
    });
    expect(toneMapCueVisibility(lapsed)).toBe("guided");
    expect(course.tones[targetMidi!]!.production).toEqual(productionBefore);
    expect(course.tones[neighborMidi!]!.identification).toEqual(neighborBefore);

    course = answer(course, targetMidi!, "identification", "blind", "correct");
    course = answer(course, targetMidi!, "identification", "blind", "correct");
    course = answer(course, targetMidi!, "identification", "blind", "correct");
    expect(course.tones[targetMidi!]!.identification.stable).toBe(false);
    expect(course.tones[targetMidi!]!.identification.guidedRecoveryRemaining).toBe(1);
    course = answer(course, targetMidi!, "identification", "guided", "correct");
    expect(course.tones[targetMidi!]!.identification.guidedRecoveryRemaining).toBe(0);
    expect(toneMapCueVisibility(course.tones[targetMidi!]!.identification)).toBe("blind");
    expect(course.tones[targetMidi!]!.identification.stable).toBe(false);
    course = answer(course, targetMidi!, "identification", "blind", "correct");
    course = answer(course, targetMidi!, "identification", "blind", "correct");
    course = answer(course, targetMidi!, "identification", "blind", "correct");
    expect(course.tones[targetMidi!]!.identification.stable).toBe(true);
    expect(course.tones[targetMidi!]!.identification.bestBlindStreak).toBe(3);
  });

  it("keeps keyboard identification and voice production evidence independent", () => {
    let course = createToneMapCourse("independent");
    const midi = course.order[0]!;
    course = stabilize(course, midi, "identification");

    expect(course.tones[midi]!.identification.stable).toBe(true);
    expect(course.tones[midi]!.production).toMatchObject({ attempts: 0, correct: 0, stable: false });
  });

  it("does not let blind Simon evidence bypass guided association", () => {
    let course = createToneMapCourse("blind-before-guidance");
    const midi = course.order[0]!;
    for (let index = 0; index < TONE_MAP_BLIND_CORRECT_REQUIRED; index += 1) {
      course = answer(course, midi, "identification", "blind", "correct");
    }
    expect(course.tones[midi]!.identification).toMatchObject({
      guidedStreak: 0,
      blindAttempts: 3,
      blindCorrect: 3,
      blindStreak: 0,
      blindConfirmedAfterGuidance: false,
      stable: false,
    });

    course = answer(course, midi, "identification", "guided", "correct");
    course = answer(course, midi, "identification", "guided", "correct");
    expect(course.tones[midi]!.identification).toMatchObject({
      blindAttempts: 3,
      blindCorrect: 3,
      blindStreak: 0,
      stable: false,
    });
    expect(restoreToneMapCourse(JSON.parse(JSON.stringify(course))).tones[midi]!.identification.stable)
      .toBe(false);
    course = answer(course, midi, "identification", "blind", "correct");
    expect(course.tones[midi]!.identification).toMatchObject({
      blindStreak: 1,
      blindConfirmedAfterGuidance: true,
      stable: false,
    });
    course = answer(course, midi, "identification", "blind", "correct");
    course = answer(course, midi, "identification", "blind", "correct");
    expect(course.tones[midi]!.identification).toMatchObject({ blindStreak: 3, stable: true });
  });
});

describe("production reachability", () => {
  it("treats unreachable as neutral evidence, reversible eligibility, and no keyboard mutation", () => {
    let course = createToneMapCourse("reachability");
    const midi = course.order[0]!;
    const keyboardBefore = course.tones[midi]!.identification;
    const productionBefore = course.tones[midi]!.production;
    course = recordToneMapTaskResult(course, task(midi, "production", "guided"), "production-unreachable");

    expect(course.tones[midi]!.productionEligibility).toBe("unreachable");
    expect(course.tones[midi]!.production).toEqual(productionBefore);
    expect(course.tones[midi]!.identification).toEqual(keyboardBefore);

    course = setToneMapProductionEligibility(course, midi, "reachable");
    expect(course.tones[midi]!.productionEligibility).toBe("reachable");
    expect(course.tones[midi]!.production).toEqual(productionBefore);
  });

  it("excludes unreachable tones from voice scheduling and gating without calling them mastered", () => {
    let course = createToneMapCourse("excluded");
    const active = toneMapActiveMidis(course);
    for (const midi of active) course = setToneMapProductionEligibility(course, midi, "unreachable");

    const summary = summarizeToneMapLevel(course, TONE_MAP_VOICE_SKILLS);
    expect(chooseToneMapTask(course, { requiredSkills: TONE_MAP_VOICE_SKILLS, seed: 1 })).toBeNull();
    expect(summary.production.excludedMidis).toEqual(active);
    expect(summary.production.eligibleMidis).toEqual([]);
    expect(summary.production.stableMidis).toEqual([]);
    expect(summary.production.allStable).toBe(true);
    expect(summary.canAdvance).toBe(true);
    expect(summary.identification.excludedMidis).toEqual([]);

    course = setToneMapProductionEligibility(course, active[2]!, "reachable");
    expect(chooseToneMapTask(course, { requiredSkills: TONE_MAP_VOICE_SKILLS, seed: 1 })?.midi).toBe(active[2]);
    expect(summarizeToneMapLevel(course, TONE_MAP_VOICE_SKILLS).canAdvance).toBe(false);
  });
});

describe("weakest-first randomized scheduling", () => {
  it("is seeded, avoids immediate MIDI repeats, and does not follow fixed course order", () => {
    const course = createToneMapCourse("scheduler");
    const first = chooseToneMapTask(course, { requiredSkills: TONE_MAP_KEYBOARD_SKILLS, seed: "same" })!;
    const repeated = chooseToneMapTask(course, { requiredSkills: TONE_MAP_KEYBOARD_SKILLS, seed: "same" })!;
    const next = chooseToneMapTask(course, {
      requiredSkills: TONE_MAP_KEYBOARD_SKILLS,
      seed: "same",
      previousTask: first,
    })!;
    const selected = new Set(Array.from({ length: 24 }, (_, seed) => (
      chooseToneMapTask(course, { requiredSkills: TONE_MAP_KEYBOARD_SKILLS, seed })!.midi
    )));

    expect(repeated).toEqual(first);
    expect(next.midi).not.toBe(first.midi);
    expect(selected.size).toBeGreaterThan(1);
    expect(selected).not.toEqual(new Set([course.order[0]]));
  });

  it("chooses among the weakest tasks and can request voice imitation explicitly", () => {
    let course = createToneMapCourse("weakness");
    const active = toneMapActiveMidis(course);
    const weakestMidi = active[active.length - 1]!;
    for (const midi of active.slice(0, -1)) {
      course = answer(course, midi, "identification", "guided", "correct");
    }

    expect(chooseToneMapTask(course, { requiredSkills: TONE_MAP_KEYBOARD_SKILLS, seed: 99 })?.midi)
      .toBe(weakestMidi);
    const imitation = chooseToneMapTask(course, {
      requiredSkills: TONE_MAP_VOICE_SKILLS,
      productionChallengeKind: "voice-imitation",
      seed: 99,
    });
    expect(imitation).toMatchObject({ skill: "production", challengeKind: "voice-imitation" });
  });

  it("schedules both independent skills in mixed mode", () => {
    const course = createToneMapCourse("mixed-scheduler");
    const skills = new Set(Array.from({ length: 40 }, (_, seed) => (
      chooseToneMapTask(course, { requiredSkills: TONE_MAP_MIXED_SKILLS, seed })!.skill
    )));
    expect(skills).toEqual(new Set(["identification", "production"]));
  });
});

describe("cumulative level gates", () => {
  it("requires every cumulative active tone stable and a current-level blind confirmation", () => {
    let course = createToneMapCourse("gates");
    const firstLevel = toneMapActiveMidis(course);
    course = stabilizeAll(course, firstLevel, "identification");
    expect(summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS).canAdvance).toBe(true);

    const noConfirmationTones = { ...course.tones };
    for (const midi of firstLevel) {
      const toneState = noConfirmationTones[midi]!;
      noConfirmationTones[midi] = {
        ...toneState,
        identification: { ...toneState.identification, lastBlindConfirmedLevel: null },
      };
    }
    const noConfirmation = { ...course, tones: noConfirmationTones };
    const blocked = summarizeToneMapLevel(noConfirmation, TONE_MAP_KEYBOARD_SKILLS);
    expect(blocked.identification.allStable).toBe(true);
    expect(blocked.identification.hasCurrentLevelBlindConfirmation).toBe(false);
    expect(blocked.canAdvance).toBe(false);

    course = advanceToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS);
    expect(course.currentLevel).toBe(2);
    expect(toneMapActiveMidis(course)).toHaveLength(12);
    expect(summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS).canAdvance).toBe(false);
    course = stabilizeAll(course, toneMapLevelMidis(course), "identification");
    course = answer(course, firstLevel[0]!, "identification", "blind", "incorrect");
    expect(summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS).canAdvance).toBe(false);
  });

  it("mixed mode requires identification plus every eligible production tone", () => {
    let course = createToneMapCourse("mixed-gate");
    const active = toneMapActiveMidis(course);
    course = stabilizeAll(course, active, "identification");
    expect(summarizeToneMapLevel(course, TONE_MAP_MIXED_SKILLS).canAdvance).toBe(false);

    const supported = active.filter(isToneMapProductionMidiSupported);
    const excluded = supported[supported.length - 1]!;
    course = setToneMapProductionEligibility(course, excluded, "unreachable");
    course = stabilizeAll(course, supported.filter((midi) => midi !== excluded), "production");
    const summary = summarizeToneMapLevel(course, TONE_MAP_MIXED_SKILLS);

    expect(summary.canAdvance).toBe(true);
    expect(summary.production.excludedMidis).toEqual(
      active.filter((midi) => !isToneMapProductionMidiSupported(midi) || midi === excluded),
    );
    expect(summary.production.stableMidis).not.toContain(excluded);
  });
});

describe("untimed Simon sequence memory", () => {
  it("generates seeded sequences from the active pool, distinct where possible", () => {
    const course = createToneMapCourse("simon");
    const first = createToneMapSimonSequence(course, { seed: "round", length: 6 });
    const second = createToneMapSimonSequence(course, { seed: "round", length: 6 });
    const longer = createToneMapSimonSequence(course, { seed: "long", length: 8 });

    expect(second).toEqual(first);
    expect(new Set(first)).toHaveLength(6);
    expect(first.every((midi) => toneMapActiveMidis(course).includes(midi))).toBe(true);
    for (let index = 1; index < longer.length; index += 1) {
      expect(longer[index]).not.toBe(longer[index - 1]);
    }
  });

  it("collects answers without a clock and grades only after the full sequence", () => {
    const course = createToneMapCourse("simon-grade");
    const [first, second, third] = toneMapActiveMidis(course);
    let round = createToneMapSimonRound([first!, second!, third!]);
    round = reduceToneMapSimonRound(round, { type: "play" });
    round = reduceToneMapSimonRound(round, { type: "playback-completed" });
    round = appendToneMapSimonAnswer(round, first!);

    expect(round.answers).toEqual([first]);
    expect(() => gradeToneMapSimonRound(course, round)).toThrow(/incomplete/i);
    expect(course.tones[first!]!.identification.attempts).toBe(0);

    round = appendToneMapSimonAnswer(round, first!);
    round = appendToneMapSimonAnswer(round, third!);
    const grade = gradeToneMapSimonRound(course, round);

    expect(grade.positions.map((position) => position.correct)).toEqual([true, false, true]);
    expect(grade.course.tones[first!]!.identification.blindCorrect).toBe(1);
    expect(grade.course.tones[second!]!.identification).toMatchObject({
      blindAttempts: 1,
      blindCorrect: 0,
      lapses: 1,
      guidedRecoveryRemaining: 1,
    });
    expect(grade.course.tones[third!]!.identification.blindCorrect).toBe(1);
    expect(grade.course.tones[first!]!.production.attempts).toBe(0);
    expect(appendToneMapSimonAnswer(round, third!)).toBe(round);
  });

  it("rejects answers before Play and throughout authored playback", () => {
    const course = createToneMapCourse("simon-transport-lock");
    const [first, second] = toneMapActiveMidis(course);
    const ready = createToneMapSimonRound([first!, second!]);
    const beforePlay = appendToneMapSimonAnswer(ready, first!);
    const playing = reduceToneMapSimonRound(ready, { type: "play" });
    const duringPlayback = appendToneMapSimonAnswer(playing, first!);

    expect(ready.phase).toBe("ready-to-play");
    expect(beforePlay).toBe(ready);
    expect(playing.phase).toBe("playing");
    expect(duringPlayback).toBe(playing);
    expect(duringPlayback.answers).toEqual([]);
  });

  it("opens untimed answering only on natural completion and reviews on the exact final answer", () => {
    const course = createToneMapCourse("simon-transport-complete");
    const [first, second, third] = toneMapActiveMidis(course);
    let round = createToneMapSimonRound([first!, second!, third!]);
    round = reduceToneMapSimonRound(round, { type: "play" });
    round = reduceToneMapSimonRound(round, { type: "playback-completed" });

    expect(round.phase).toBe("answering");
    for (let elapsedHours = 1; elapsedHours <= 24; elapsedHours += 1) {
      expect(round.phase).toBe("answering");
      expect(round.answers).toEqual([]);
    }

    round = appendToneMapSimonAnswer(round, first!);
    expect(round).toMatchObject({ phase: "answering", answers: [first] });
    round = appendToneMapSimonAnswer(round, second!);
    expect(round).toMatchObject({ phase: "answering", answers: [first, second] });
    expect(() => gradeToneMapSimonRound(course, round)).toThrow(/incomplete/i);
    round = appendToneMapSimonAnswer(round, third!);
    expect(round).toMatchObject({ phase: "review", answers: [first, second, third] });
    expect(gradeToneMapSimonRound(course, round).positions).toHaveLength(3);
  });

  it("requires a complete replay after explicit Stop without revoking an unlocked answer", () => {
    const course = createToneMapCourse("simon-transport-stop");
    const [first, second] = toneMapActiveMidis(course);
    let round = createToneMapSimonRound([first!, second!]);
    round = reduceToneMapSimonRound(round, { type: "play" });
    round = reduceToneMapSimonRound(round, { type: "stop-playback" });
    expect(round.phase).toBe("ready-to-play");
    expect(appendToneMapSimonAnswer(round, first!)).toBe(round);

    round = reduceToneMapSimonRound(round, { type: "play" });
    round = reduceToneMapSimonRound(round, { type: "playback-completed" });
    round = appendToneMapSimonAnswer(round, first!);
    round = reduceToneMapSimonRound(round, { type: "play" });
    expect(round.phase).toBe("playing");
    round = reduceToneMapSimonRound(round, { type: "stop-playback" });
    expect(round).toMatchObject({ phase: "answering", answers: [first] });
  });
});
