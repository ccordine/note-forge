import { describe, expect, it } from "vitest";

import {
  allocateSessionMix,
  createSeededRng,
  generateAdaptiveSession,
  SKILL_CATALOG,
  type SkillDefinition,
  type SkillState,
} from "../src";

const definition = (skillId: string): SkillDefinition => ({
  skillId,
  label: skillId,
  description: skillId,
  domain: "perception",
  representations: ["heard-sound"],
  prerequisites: [],
  difficulty: 0.5,
  tags: [],
});

const state = (skillId: string, overrides: Partial<SkillState>): SkillState => ({
  skillId,
  mastery: 0.8,
  difficulty: 0.5,
  attemptCount: 5,
  recentAccuracy: 0.9,
  longTermAccuracy: 0.8,
  confidence: 0.9,
  commonConfusions: {},
  ...overrides,
});

describe("adaptive session scheduling", () => {
  it("allocates the default ten-item mix as 60/20/20", () => {
    expect(allocateSessionMix(10)).toEqual({ weak_due: 6, recent: 2, exploration: 2 });
  });

  it("selects weak/due, recent, and exploratory skills deterministically", () => {
    const definitions = Array.from({ length: 10 }, (_, index) => definition(`skill.${index}`));
    const now = new Date("2026-08-22T12:00:00.000Z");
    const states: Record<string, SkillState> = {};
    for (let index = 0; index < 6; index += 1) {
      states[`skill.${index}`] = state(`skill.${index}`, { mastery: 0.3, recentAccuracy: 0.4 });
    }
    for (let index = 6; index < 8; index += 1) {
      states[`skill.${index}`] = state(`skill.${index}`, {
        lastPracticedAt: "2026-08-21T12:00:00.000Z",
        dueAt: "2026-09-01T12:00:00.000Z",
      });
    }
    const schedule = () =>
      generateAdaptiveSession(definitions, states, {
        sessionSize: 10,
        now,
        rng: createSeededRng(42),
      });
    const first = schedule();
    const second = schedule();

    expect(first.map(({ skillId, variation }) => ({ skillId, variation }))).toEqual(
      second.map(({ skillId, variation }) => ({ skillId, variation })),
    );
    expect(first.filter((item) => item.plannedBucket === "weak_due")).toHaveLength(6);
    expect(first.filter((item) => item.plannedBucket === "recent")).toHaveLength(2);
    expect(first.filter((item) => item.plannedBucket === "exploration")).toHaveLength(2);
    expect(first.every((item) => item.bucket === item.plannedBucket)).toBe(true);
    expect(first.every((item) => item.variation.startingMidi >= 36)).toBe(true);
  });

  it("fills a session from an available fallback pool without bypassing prerequisites", () => {
    const schedule = generateAdaptiveSession(SKILL_CATALOG, {}, {
      sessionSize: 8,
      rng: createSeededRng(1),
    });
    expect(schedule).toHaveLength(8);
    expect(new Set(schedule.map((item) => item.skillId))).toEqual(new Set(["pitch.same_different"]));
    expect(schedule.every((item) => item.bucket === "exploration")).toBe(true);
  });
});
