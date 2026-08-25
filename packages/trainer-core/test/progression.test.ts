import { describe, expect, it } from "vitest";

import {
  calculateNextDueDate,
  confusionKeyFor,
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

  it("rejects corrupt identifiers, counters, dates, and confusion evidence", () => {
    expect(() => createInitialSkillState(" ")).toThrow(/skillId/);
    expect(() => createInitialSkillState("constructor")).toThrow(/prototype/);
    expect(() => createInitialSkillState("x".repeat(129))).toThrow(/128/);
    expect(() => createInitialSkillState("pitch.direction", Number.NaN)).toThrow(/difficulty/);
    expect(() => createInitialSkillState("pitch.direction", 1.01)).toThrow(/difficulty/);

    const initial = createInitialSkillState("pitch.direction");
    expect(() => recordSkillConfusion(initial, "", 1)).toThrow(/confusionKey/);
    expect(() => recordSkillConfusion(initial, "up → down", 0)).toThrow(/positive/);
    expect(() => recordSkillConfusion(initial, "up → down", 0.5)).toThrow(/increment/);
    expect(() => recordSkillConfusion(initial, "constructor", 1)).toThrow(/prototype/);
    expect(() => recordSkillConfusion(initial, "x".repeat(257), 1)).toThrow(/256/);
    expect(() => confusionKeyFor("x".repeat(257), "y")).toThrow(/256/);
    expect(() => calculateNextDueDate({
      accuracy: 1,
      mastery: 0.5,
      attemptCount: -1,
      practicedAt: new Date("2026-08-22T12:00:00.000Z"),
    })).toThrow(/attemptCount/);
    expect(() => calculateNextDueDate({
      accuracy: Number.NaN,
      mastery: 0.5,
      attemptCount: 1,
      practicedAt: new Date("2026-08-22T12:00:00.000Z"),
    })).toThrow(/accuracy/);
    expect(() => calculateNextDueDate({
      accuracy: 1,
      mastery: 0.5,
      attemptCount: 1,
      practicedAt: new Date("2026-08-22T12:00:00.000Z"),
    }, { baseIntervalDays: 2, maximumIntervalDays: 1 })).toThrow(/maximumIntervalDays/);
    expect(() => calculateNextDueDate({
      accuracy: 1,
      mastery: 1,
      attemptCount: 1,
      practicedAt: new Date("2026-08-22T12:00:00.000Z"),
    }, {
      baseIntervalDays: Number.MAX_VALUE,
      maximumIntervalDays: Number.MAX_VALUE,
    })).toThrow(/representable date range/);
    expect(() => updateSkillState({ ...initial, attemptCount: Number.NaN }, initial.skillId, {
      accuracy: 1,
    })).toThrow(/attemptCount/);
    expect(() => updateSkillState({
      ...initial,
      attemptCount: Number.MAX_SAFE_INTEGER,
    }, initial.skillId, { accuracy: 1 })).toThrow(/safe-integer range/);
    expect(() => updateSkillState({ ...initial, mastery: Number.NaN }, initial.skillId, {
      accuracy: 1,
    })).toThrow(/mastery/);
    expect(() => updateSkillState(initial, initial.skillId, { accuracy: 1.01 }))
      .toThrow(/accuracy/);
    expect(() => updateSkillState(initial, initial.skillId, {
      accuracy: 1,
      responseTimeMs: -1,
    })).toThrow(/responseTimeMs/);
    expect(() => updateSkillState(initial, initial.skillId, {
      accuracy: 1,
      confusionKey: " ",
    })).toThrow(/confusionKey/);
    expect(() => updateSkillState(initial, initial.skillId, { accuracy: 1 }, {
      masteryAlpha: Number.NaN,
    })).toThrow(/masteryAlpha/);
    expect(() => recordSkillConfusion({
      ...initial,
      commonConfusions: { "up → down": Number.NaN },
    }, "up → down")).toThrow(/commonConfusions/);
    expect(() => recordSkillConfusion({
      ...initial,
      commonConfusions: { "up → down": Number.MAX_SAFE_INTEGER },
    }, "up → down")).toThrow(/safe-integer range/);
    const manyConfusions = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`confusion-${index}`, 1]),
    );
    const extendedConfusions = recordSkillConfusion({
      ...initial,
      commonConfusions: manyConfusions,
    }, "another");
    expect(extendedConfusions.commonConfusions).toHaveProperty("another", 1);
    expect(Object.keys(extendedConfusions.commonConfusions)).toHaveLength(130);
    expect(Object.keys(manyConfusions)).toHaveLength(129);
    expect(() => recordSkillConfusion({
      ...initial,
      commonConfusions: JSON.parse('{"__proto__":1}') as Record<string, number>,
    }, "up → down")).toThrow(/prototype/);
    expect(() => recordSkillConfusion({
      ...initial,
      commonConfusions: [] as unknown as Record<string, number>,
    }, "up → down")).toThrow(/plain record/);
    expect(() => updateSkillStates({ alias: initial }, [])).toThrow(/stored under/);
  });
});
