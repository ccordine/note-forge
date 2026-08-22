import { describe, expect, it } from "vitest";

import {
  createInitialSkillState,
  recordSkillConfusion,
  updateSkillState,
  updateSkillStates,
} from "../src";

describe("skill progression", () => {
  it("tracks distinct recent/long-term accuracy, timing, due date, and confusion", () => {
    const practicedAt = new Date("2026-08-22T12:00:00.000Z");
    const initial = createInitialSkillState("interval.recognize.m3.ascending", 0.6);
    const updated = updateSkillState(initial, initial.skillId, {
      accuracy: 0.2,
      correct: false,
      expectedAnswer: "m3",
      givenAnswer: "M3",
      responseTimeMs: 1_200,
      confidence: 0.8,
      practicedAt,
    });

    expect(initial.attemptCount).toBe(0);
    expect(updated.attemptCount).toBe(1);
    expect(updated.recentAccuracy).toBeCloseTo(0.2);
    expect(updated.longTermAccuracy).toBeCloseTo(0.2);
    expect(updated.averageResponseTimeMs).toBe(1_200);
    expect(updated.commonConfusions["m3 → M3"]).toBe(1);
    expect(updated.lastPracticedAt).toBe(practicedAt.toISOString());
    expect(Date.parse(updated.dueAt ?? "")).toBe(practicedAt.getTime() + 10 * 60_000);
  });

  it("uses fast and slow moving accuracy estimates and schedules success later", () => {
    const practicedAt = new Date("2026-08-22T12:00:00.000Z");
    let state = createInitialSkillState("pitch.direction");
    state = updateSkillState(state, state.skillId, { accuracy: 0, practicedAt });
    const lowDueAt = Date.parse(state.dueAt ?? "");
    state = updateSkillState(state, state.skillId, {
      accuracy: 1,
      responseTimeMs: 500,
      practicedAt: new Date(practicedAt.getTime() + 60_000),
    });

    expect(state.recentAccuracy).toBeGreaterThan(state.longTermAccuracy);
    expect(Date.parse(state.dueAt ?? "")).toBeGreaterThan(lowDueAt);
    expect(state.mastery).toBeGreaterThan(0);
  });

  it("supports explicit confusion recording and immutable batch updates", () => {
    const initial = createInitialSkillState("pitch.absolute.pitch_class");
    const confused = recordSkillConfusion(initial, "F# → G", 2);
    expect(initial.commonConfusions).toEqual({});
    expect(confused.commonConfusions).toEqual({ "F# → G": 2 });

    const original = { [initial.skillId]: initial };
    const result = updateSkillStates(original, [
      {
        skillId: initial.skillId,
        observation: { accuracy: 1, practicedAt: new Date("2026-08-22T12:00:00.000Z") },
      },
    ]);
    expect(original[initial.skillId].attemptCount).toBe(0);
    expect(result[initial.skillId].attemptCount).toBe(1);
  });
});
