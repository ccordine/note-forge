import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToneMapProgress } from "../apps/web/src/features/ear-training/ToneMapProgress";
import {
  TONE_MAP_BLIND_CORRECT_REQUIRED,
  TONE_MAP_GUIDED_CORRECT_REQUIRED,
  TONE_MAP_KEYBOARD_SKILLS,
  advanceToneMapLevel,
  createToneMapCourse,
  recordToneMapTaskResult,
  summarizeToneMapLevel,
  toneMapActiveMidis,
  toneMapLevelMidis,
  type ToneMapCourseState,
} from "../apps/web/src/features/ear-training/tone-map-model";

function stabilizeIdentification(course: ToneMapCourseState, midi: number): ToneMapCourseState {
  let next = course;
  for (let index = 0; index < TONE_MAP_GUIDED_CORRECT_REQUIRED; index += 1) {
    next = recordToneMapTaskResult(next, {
      midi, skill: "identification", challengeKind: "keyboard-identification", cueVisibility: "guided",
    }, "correct");
  }
  for (let index = 0; index < TONE_MAP_BLIND_CORRECT_REQUIRED; index += 1) {
    next = recordToneMapTaskResult(next, {
      midi, skill: "identification", challengeKind: "keyboard-identification", cueVisibility: "blind",
    }, "correct");
  }
  return next;
}

describe("tone-map cumulative progress copy", () => {
  it("reports the actual four-tone final addition instead of promising another six", () => {
    const course = { ...createToneMapCourse("final-count"), currentLevel: 14 };
    const summary = {
      ...summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS),
      canAdvance: true,
    };
    const markup = renderToStaticMarkup(createElement(ToneMapProgress, {
      course,
      summary,
      mayAdvanceNow: true,
      onAdvance: () => undefined,
    }));

    expect(summary.activeMidis).toHaveLength(84);
    expect(markup).toContain("Add the next 4 tones");
    expect(markup).not.toContain("Add the next 6 tones");
  });

  it("shows the repeated stability proof instead of treating one answer as enough", () => {
    let course = createToneMapCourse("visible-requalification");
    for (const midi of toneMapActiveMidis(course)) course = stabilizeIdentification(course, midi);
    course = advanceToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS);
    for (const midi of toneMapLevelMidis(course)) course = stabilizeIdentification(course, midi);
    for (const midi of toneMapActiveMidis(course).slice(0, 6)) {
      course = recordToneMapTaskResult(course, {
        midi, skill: "identification", challengeKind: "keyboard-identification", cueVisibility: "blind",
      }, "correct");
    }
    const summary = summarizeToneMapLevel(course, TONE_MAP_KEYBOARD_SKILLS);
    const markup = renderToStaticMarkup(createElement(ToneMapProgress, {
      course,
      summary,
      mayAdvanceNow: true,
      onAdvance: () => undefined,
    }));

    expect(summary.identification.stableMidis).toHaveLength(6);
    expect(summary.identification.blindConfirmedMidis).toHaveLength(6);
    expect(summary.canAdvance).toBe(false);
    expect(markup).toContain("6/12 stable");
    expect(markup).toContain("6/12 proved this level");
    expect(markup).toContain("same cumulative randomized challenge");
    expect(markup).toContain("fresh three-answer blind streak");
  });
});
