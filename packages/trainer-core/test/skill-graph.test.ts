import { describe, expect, it } from "vitest";

import {
  getPrerequisiteClosure,
  getUnlockedSkillDefinitions,
  SKILL_CATALOG,
  SKILL_GRAPH,
  validateSkillGraph,
  type SkillDefinition,
} from "../src";

describe("default skill graph", () => {
  it("covers every requested perception, production, symbolic, and spatial primitive", () => {
    expect(SKILL_CATALOG).toHaveLength(38);
    expect(SKILL_CATALOG.filter((entry) => entry.domain === "perception")).toHaveLength(14);
    expect(SKILL_CATALOG.filter((entry) => entry.domain === "production")).toHaveLength(15);
    expect(SKILL_CATALOG.filter((entry) => entry.domain === "symbolic")).toHaveLength(6);
    expect(SKILL_CATALOG.filter((entry) => entry.domain === "spatial")).toHaveLength(3);

    const ids = new Set(SKILL_CATALOG.map((entry) => entry.skillId));
    for (const requiredId of [
      "pitch.same_different",
      "hum.anchor.discover",
      "hum.target.match",
      "hum.sustain.control",
      "pitch.match.glide",
      "pitch.match.cold_attack",
      "pitch.hold.stability",
      "interval.recognize",
      "interval.produce",
      "scale_degree.recognize",
      "scale_degree.produce",
      "chord_tone.recognize",
      "chord_tone.produce",
      "harmony.follow",
      "melody.echo",
      "pitch.microtonal.produce",
      "mapping.frequency",
      "mapping.keyboard_position",
      "mapping.guitar_position",
      "mapping.bass_position",
    ]) {
      expect(ids.has(requiredId), requiredId).toBe(true);
    }
    expect(validateSkillGraph()).toEqual({ valid: true, errors: [] });
  });

  it("exposes graph relationships and transitive prerequisites", () => {
    expect(SKILL_GRAPH["pitch.match.glide"].dependents).toContain("pitch.match.cold_attack");
    expect(SKILL_GRAPH["pitch.same_different"].dependents).toContain("hum.anchor.discover");
    expect(SKILL_GRAPH["hum.anchor.discover"].dependents).toContain("hum.target.match");
    expect(SKILL_GRAPH["hum.target.match"].dependents).toContain("hum.sustain.control");
    expect(Object.isFrozen(SKILL_GRAPH)).toBe(true);
    expect(Object.isFrozen(SKILL_GRAPH["pitch.match.glide"].dependents)).toBe(true);
    expect(Object.isFrozen(SKILL_CATALOG)).toBe(true);
    expect(Object.isFrozen(SKILL_CATALOG[0])).toBe(true);
    expect(Object.isFrozen(SKILL_CATALOG[0].prerequisites)).toBe(true);

    const humPrerequisites = getPrerequisiteClosure("hum.sustain.control");
    expect(humPrerequisites).toEqual(
      expect.arrayContaining([
        "hum.target.match",
        "hum.anchor.discover",
        "pitch.hold.stability",
        "pitch.match.glide",
        "pitch.direction",
        "pitch.same_different",
      ]),
    );

    const prerequisites = getPrerequisiteClosure("harmony.improvise");
    expect(prerequisites).toContain("harmony.follow");
    expect(prerequisites).toContain("pitch.same_different");
  });

  it("detects missing prerequisites and cycles in a supplied graph", () => {
    const definitions: SkillDefinition[] = [
      {
        skillId: "a",
        label: "A",
        description: "A",
        domain: "perception",
        representations: ["heard-sound"],
        prerequisites: ["b"],
        difficulty: 0,
        tags: [],
      },
      {
        skillId: "b",
        label: "B",
        description: "B",
        domain: "perception",
        representations: ["heard-sound"],
        prerequisites: ["a", "missing"],
        difficulty: 0,
        tags: [],
      },
    ];
    const validation = validateSkillGraph(definitions);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.includes("Unknown prerequisite missing"))).toBe(true);
    expect(validation.errors.some((error) => error.includes("cycle"))).toBe(true);
  });

  it("rejects non-finite difficulty, duplicate prerequisites, and invalid mastery thresholds", () => {
    const invalid: SkillDefinition = {
      skillId: "invalid",
      label: "Invalid",
      description: "Invalid graph fixture",
      domain: "perception",
      representations: ["heard-sound"],
      prerequisites: ["missing", "missing"],
      difficulty: Number.NaN,
      tags: [],
    };

    const validation = validateSkillGraph([invalid]);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Difficulty"),
      expect.stringContaining("duplicate prerequisites"),
      expect.stringContaining("Unknown prerequisite"),
    ]));
    expect(() => getUnlockedSkillDefinitions({}, SKILL_CATALOG, Number.NaN))
      .toThrow(/masteryThreshold/);
  });
});
