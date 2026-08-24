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

  it("rejects malformed scheduling evidence instead of silently producing a queue", () => {
    expect(() => createSeededRng(Number.NaN)).toThrow(/seed/);
    expect(() => createSeededRng(Number.MAX_SAFE_INTEGER + 1)).toThrow(/seed/);
    expect(() => allocateSessionMix(10_001)).toThrow(/cannot exceed/);
    expect(() => allocateSessionMix(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
    expect(() => allocateSessionMix(10, { weakDue: Number.NaN })).toThrow(/weakDue/);
    expect(() => allocateSessionMix(10, {
      weakDue: Number.MAX_VALUE,
      recent: Number.MAX_VALUE,
      exploration: Number.MAX_VALUE,
    })).toThrow(/total session mix/);
    expect(() => allocateSessionMix(10, { weakDue: 0, recent: 0, exploration: 0 }))
      .toThrow(/positive/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {}, {
      sessionSize: 1,
      now: new Date("invalid"),
    })).toThrow(/valid Date/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {}, {
      sessionSize: 1,
      now: new Date(0),
      recentWindowDays: Number.MAX_VALUE,
    })).toThrow(/finite scheduling range/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {
      "skill.0": state("different-skill", {}),
    }, { sessionSize: 1 })).toThrow(/stored under/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {}, {
      sessionSize: 1,
      variationPools: { amplitudes: [Number.NaN] },
    })).toThrow(/amplitudes/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {}, {
      sessionSize: 1,
      rng: () => 1,
    })).toThrow(/injected RNG/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {
      "skill.0": state("skill.0", { dueAt: "invalid" }),
    }, { sessionSize: 1 })).toThrow(/dueAt/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {
      "skill.0": state("skill.0", { attemptCount: Number.MAX_SAFE_INTEGER + 1 }),
    }, { sessionSize: 1 })).toThrow(/safe integer/);
    expect(() => generateAdaptiveSession([
      { ...definition("skill.0"), prerequisites: ["missing"] },
    ], {}, { sessionSize: 1 })).toThrow(/Invalid skill graph/);
    expect(() => generateAdaptiveSession([
      { ...definition("skill.0"), prerequisites: ["missing"] },
    ], {}, { sessionSize: 0 })).toThrow(/Invalid skill graph/);
    expect(() => generateAdaptiveSession([definition("skill.0")], {}, {
      sessionSize: 0,
      variationPools: { timbres: [] },
    })).toThrow(/timbres/);
  });
});
