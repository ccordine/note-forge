import { describe, expect, it } from "vitest";

import {
  ARCADE_CURRICULUM_STAGES,
  ARCADE_MODE_CURRICULUM_COPY,
  ARCADE_STAGE_FEEDBACK,
  ARCADE_STAGE_MASTERY_REQUIREMENTS,
  getArcadeCurriculumStage,
  getArcadeStageMasteryRequirement,
  resolveArcadeCurriculum,
} from "../apps/web/src/features/voice-arcade/curriculum";
import {
  applyArcadeOutcome,
  createDefaultArcadeProgress,
  hasArcadeStageMastery,
  normalizeArcadeProgress,
  recommendArcadeStage,
  type ArcadeProgress,
} from "../apps/web/src/features/voice-arcade/arcade-progress";
import {
  ARCADE_MODES,
  type ArcadeCurriculumStage,
  type ArcadeMode,
  type ArcadeOutcome,
} from "../apps/web/src/features/voice-arcade/types";

function outcome(overrides: Partial<ArcadeOutcome> = {}): ArcadeOutcome {
  return {
    mode: "pattern",
    curriculumStage: "deliberate",
    variant: "ddr",
    score: 80,
    grade: "B",
    xp: 108,
    accuracy: 82,
    bestCombo: 4,
    durationMs: 12_000,
    ...overrides,
  };
}

function recordQualifyingRuns(
  initial: ArcadeProgress,
  mode: ArcadeMode,
  stage: ArcadeCurriculumStage,
  timestampOffset = 0,
): ArcadeProgress {
  const requirement = getArcadeStageMasteryRequirement(mode, stage);
  let progress = initial;
  for (let index = 0; index < requirement.requiredRuns; index += 1) {
    progress = applyArcadeOutcome(
      progress,
      outcome({
        mode,
        curriculumStage: stage,
        score: requirement.minimumScore,
        xp: 10,
      }),
      new Date(Date.UTC(2026, 7, 23, 12, 0, timestampOffset + index)).toISOString(),
    );
  }
  return progress;
}

describe("Voice Arcade curriculum contracts", () => {
  it("defines the three learning stages in stable order", () => {
    expect(ARCADE_CURRICULUM_STAGES).toEqual(["deliberate", "reflex", "background"]);
    expect(getArcadeCurriculumStage("deliberate")).toBe("deliberate");
    expect(() => getArcadeCurriculumStage("expert")).toThrow(RangeError);
  });

  it("reduces feedback monotonically without encoding mechanical difficulty", () => {
    expect(ARCADE_STAGE_FEEDBACK.deliberate).toEqual({
      level: "full",
      showLiveNote: true,
      showCents: true,
      showUpcomingCue: true,
      showPreviewLabels: true,
      rangeLabelDensity: "full",
      allowReferenceReplay: true,
    });
    expect(ARCADE_STAGE_FEEDBACK.reflex).toEqual({
      level: "reduced",
      showLiveNote: true,
      showCents: false,
      showUpcomingCue: false,
      showPreviewLabels: false,
      rangeLabelDensity: "anchors",
      allowReferenceReplay: false,
    });
    expect(ARCADE_STAGE_FEEDBACK.background).toEqual({
      level: "gameplay",
      showLiveNote: false,
      showCents: false,
      showUpcomingCue: false,
      showPreviewLabels: false,
      rangeLabelDensity: "none",
      allowReferenceReplay: false,
    });

    for (const mode of ARCADE_MODES) {
      for (const stage of ARCADE_CURRICULUM_STAGES) {
        const resolved = resolveArcadeCurriculum(mode, stage);
        expect(resolved.stage).toBe(stage);
        expect(resolved.feedback).toBe(ARCADE_STAGE_FEEDBACK[stage]);
        expect("difficulty" in resolved).toBe(false);
      }
    }
  });

  it("resolves stable mode-specific focus and cognitive-load copy", () => {
    for (const mode of ARCADE_MODES) {
      const first = resolveArcadeCurriculum(mode, "background");
      const replay = resolveArcadeCurriculum(mode, "background");
      expect(first).toEqual(replay);
      expect(first.focus).toBe(ARCADE_MODE_CURRICULUM_COPY[mode].focus);
      expect(first.cognitiveLoad).toBe(ARCADE_MODE_CURRICULUM_COPY[mode].cognitiveLoad);
      expect(first.focus.length).toBeGreaterThan(20);
      expect(first.cognitiveLoad.length).toBeGreaterThan(20);
    }
    expect(new Set(ARCADE_MODES.map((mode) => ARCADE_MODE_CURRICULUM_COPY[mode].focus)).size)
      .toBe(ARCADE_MODES.length);
    expect(() => resolveArcadeCurriculum("bullet" as never, "deliberate")).toThrow(RangeError);
  });

  it("publishes explicit, valid score and qualifying-run requirements for every mode and stage", () => {
    for (const mode of ARCADE_MODES) {
      for (const stage of ARCADE_CURRICULUM_STAGES) {
        const requirement = ARCADE_STAGE_MASTERY_REQUIREMENTS[mode][stage];
        expect(requirement.requiredRuns).toBeGreaterThan(0);
        expect(Number.isInteger(requirement.requiredRuns)).toBe(true);
        expect(requirement.minimumScore).toBeGreaterThanOrEqual(0);
        expect(requirement.minimumScore).toBeLessThanOrEqual(100);
        expect(getArcadeStageMasteryRequirement(mode, stage)).toBe(requirement);
      }
    }
    expect(ARCADE_STAGE_MASTERY_REQUIREMENTS.pattern.deliberate)
      .not.toEqual(ARCADE_STAGE_MASTERY_REQUIREMENTS.maze.deliberate);
  });
});

describe("Voice Arcade current progress schema and evidence", () => {
  it("normalizes a pre-drawing progress document and adds empty drawing evidence", () => {
    const current = {
      totalXp: 1_234,
      gamesPlayed: 17,
      bestByMode: { pattern: 88, pong: 76, song: 91, maze: 83, resonance: 79 },
      masteryByMode: {
        maze: {
          deliberate: {
            runs: 2,
            qualifyingRuns: 1,
            bestScore: 83,
            averageScore: 79.5,
            lastScore: 83,
            lastPlayedAt: "2026-08-20T14:30:00-04:00",
          },
        },
      },
      lastPlayedAt: "2026-08-20T14:30:00-04:00",
    };
    const normalized = normalizeArcadeProgress(current);

    expect(normalized).toMatchObject({
      totalXp: 1_234,
      gamesPlayed: 17,
      bestByMode: { pattern: 88, pong: 76, song: 91, maze: 83, resonance: 79, draw: 0 },
      lastPlayedAt: "2026-08-20T18:30:00.000Z",
    });
    for (const mode of ARCADE_MODES) {
      for (const stage of ARCADE_CURRICULUM_STAGES) {
        if (mode === "maze" && stage === "deliberate") {
          expect(normalized.masteryByMode[mode][stage]).toEqual({
            runs: 2,
            qualifyingRuns: 1,
            bestScore: 83,
            averageScore: 79.5,
            lastScore: 83,
            lastPlayedAt: "2026-08-20T18:30:00.000Z",
          });
          continue;
        }
        expect(normalized.masteryByMode[mode][stage]).toEqual({
          runs: 0,
          qualifyingRuns: 0,
          bestScore: 0,
          averageScore: 0,
          lastScore: null,
          lastPlayedAt: null,
        });
      }
    }
  });

  it("defaults omitted or corrupt current-schema fields without inventing evidence", () => {
    const normalized = normalizeArcadeProgress({
      totalXp: 640,
      gamesPlayed: 6,
      bestByMode: { pong: 82, maze: 77 },
      masteryByMode: {
        maze: {
          deliberate: {
            runs: 2,
            qualifyingRuns: 1,
            bestScore: 77,
            averageScore: 72,
            lastScore: 77,
            lastPlayedAt: "2026-08-22T16:00:00Z",
          },
        },
      },
      lastPlayedAt: "2026-08-22T16:00:00Z",
    });

    expect(normalized).toMatchObject({
      totalXp: 640,
      gamesPlayed: 6,
      bestByMode: { pong: 82, maze: 77, resonance: 0, draw: 0 },
    });
    expect(normalized.masteryByMode.maze.deliberate).toMatchObject({
      runs: 2,
      qualifyingRuns: 1,
      bestScore: 77,
    });
    for (const stage of ARCADE_CURRICULUM_STAGES) {
      expect(normalized.masteryByMode.resonance[stage]).toEqual({
        runs: 0,
        qualifyingRuns: 0,
        bestScore: 0,
        averageScore: 0,
        lastScore: null,
        lastPlayedAt: null,
      });
      expect(normalized.masteryByMode.draw[stage]).toEqual({
        runs: 0,
        qualifyingRuns: 0,
        bestScore: 0,
        averageScore: 0,
        lastScore: null,
        lastPlayedAt: null,
      });
    }
  });

  it("normalizes malformed current evidence conservatively", () => {
    const normalized = normalizeArcadeProgress({
      totalXp: -4,
      gamesPlayed: 2.9,
      bestByMode: { pattern: Number.NaN, maze: 74.6 },
      masteryByMode: {
        maze: {
          reflex: {
            runs: 2.8,
            qualifyingRuns: 99,
            bestScore: 180,
            averageScore: 78,
            lastScore: 77,
            lastPlayedAt: "not-a-date",
          },
        },
      },
      lastPlayedAt: "invalid",
    });

    expect(normalized.totalXp).toBe(0);
    expect(normalized.gamesPlayed).toBe(2);
    expect(normalized.bestByMode).toEqual({
      pattern: 0,
      pong: 0,
      song: 0,
      maze: 75,
      resonance: 0,
      draw: 0,
    });
    expect(normalized.masteryByMode.maze.reflex).toEqual({
      runs: 2,
      qualifyingRuns: 2,
      bestScore: 100,
      averageScore: 78,
      lastScore: 77,
      lastPlayedAt: null,
    });
    expect(normalized.lastPlayedAt).toBeNull();
  });

  it("applies outcomes immutably to exactly one mode and stage", () => {
    const initial = createDefaultArcadeProgress();
    const first = applyArcadeOutcome(
      initial,
      outcome({ score: 80, xp: 108 }),
      "2026-08-23T12:00:00.000Z",
    );
    const second = applyArcadeOutcome(
      first,
      outcome({ score: 50, xp: 40 }),
      "2026-08-23T12:01:00.000Z",
    );

    expect(initial).toEqual(createDefaultArcadeProgress());
    expect(second).toMatchObject({
      totalXp: 148,
      gamesPlayed: 2,
      bestByMode: { pattern: 80 },
      lastPlayedAt: "2026-08-23T12:01:00.000Z",
    });
    expect(second.masteryByMode.pattern.deliberate).toEqual({
      runs: 2,
      qualifyingRuns: 1,
      bestScore: 80,
      averageScore: 65,
      lastScore: 50,
      lastPlayedAt: "2026-08-23T12:01:00.000Z",
    });
    expect(second.masteryByMode.pattern.reflex.runs).toBe(0);
    expect(second.masteryByMode.pong.deliberate.runs).toBe(0);
  });

  it("records manually selected advanced stages without treating recommendations as locks", () => {
    const progress = applyArcadeOutcome(
      createDefaultArcadeProgress(),
      outcome({ mode: "maze", curriculumStage: "background", score: 90, variant: "random" }),
      "2026-08-23T12:00:00.000Z",
    );

    expect(progress.masteryByMode.maze.background).toMatchObject({
      runs: 1,
      qualifyingRuns: 1,
      bestScore: 90,
    });
    expect(progress.masteryByMode.maze.deliberate.runs).toBe(0);
    expect(recommendArcadeStage(progress, "maze")).toBe("deliberate");
  });

  it("records Resonance outcomes without changing another cabinet's evidence", () => {
    const progress = applyArcadeOutcome(
      createDefaultArcadeProgress(),
      outcome({ mode: "resonance", curriculumStage: "deliberate", score: 84, variant: "resonator-room" }),
      "2026-08-23T12:00:00.000Z",
    );

    expect(progress.bestByMode.resonance).toBe(84);
    expect(progress.masteryByMode.resonance.deliberate).toMatchObject({
      runs: 1,
      qualifyingRuns: 1,
      bestScore: 84,
    });
    expect(progress.masteryByMode.maze.deliberate.runs).toBe(0);
  });

  it("persists drawing outcomes without changing another cabinet's evidence", () => {
    const recorded = applyArcadeOutcome(
      createDefaultArcadeProgress(),
      outcome({ mode: "draw", curriculumStage: "reflex", score: 87, xp: 144, variant: "trace-square" }),
      "2026-08-24T15:30:00.000Z",
    );
    const progress = normalizeArcadeProgress(JSON.parse(JSON.stringify(recorded)));

    expect(progress).toMatchObject({
      totalXp: 144,
      gamesPlayed: 1,
      bestByMode: { draw: 87 },
      lastPlayedAt: "2026-08-24T15:30:00.000Z",
    });
    expect(progress.masteryByMode.draw.reflex).toMatchObject({
      runs: 1,
      qualifyingRuns: 1,
      bestScore: 87,
      averageScore: 87,
      lastScore: 87,
      lastPlayedAt: "2026-08-24T15:30:00.000Z",
    });
    expect(progress.masteryByMode.pattern.reflex.runs).toBe(0);
  });

  it("rejects invalid outcome evidence instead of silently granting mastery", () => {
    const progress = createDefaultArcadeProgress();
    expect(() => applyArcadeOutcome(progress, outcome({ score: 101 }), "2026-08-23T12:00:00Z"))
      .toThrow(RangeError);
    expect(() => applyArcadeOutcome(progress, outcome({ xp: Number.NaN }), "2026-08-23T12:00:00Z"))
      .toThrow(RangeError);
    expect(() => applyArcadeOutcome(progress, outcome(), "not-a-time"))
      .toThrow(RangeError);
    expect(() => applyArcadeOutcome(progress, outcome({ curriculumStage: "expert" as never }), "2026-08-23T12:00:00Z"))
      .toThrow(RangeError);
  });
});

describe("Voice Arcade stage recommendations", () => {
  it("requires the published number of qualifying runs, not XP or failed attempts", () => {
    const requirement = getArcadeStageMasteryRequirement("pong", "deliberate");
    let progress = createDefaultArcadeProgress();
    for (let index = 0; index < requirement.requiredRuns + 3; index += 1) {
      progress = applyArcadeOutcome(
        progress,
        outcome({
          mode: "pong",
          curriculumStage: "deliberate",
          score: requirement.minimumScore - 1,
          xp: 10_000,
        }),
        new Date(Date.UTC(2026, 7, 23, 12, 0, index)).toISOString(),
      );
    }
    expect(progress.totalXp).toBeGreaterThan(10_000);
    expect(hasArcadeStageMastery(progress, "pong", "deliberate")).toBe(false);
    expect(recommendArcadeStage(progress, "pong")).toBe("deliberate");
  });

  it("recommends deliberate, then reflex, then background from sequential evidence", () => {
    let progress = createDefaultArcadeProgress();
    expect(recommendArcadeStage(progress, "pattern")).toBe("deliberate");

    progress = recordQualifyingRuns(progress, "pattern", "deliberate");
    expect(hasArcadeStageMastery(progress, "pattern", "deliberate")).toBe(true);
    expect(recommendArcadeStage(progress, "pattern")).toBe("reflex");

    progress = recordQualifyingRuns(progress, "pattern", "reflex", 10);
    expect(hasArcadeStageMastery(progress, "pattern", "reflex")).toBe(true);
    expect(recommendArcadeStage(progress, "pattern")).toBe("background");
  });

  it("keeps mastery evidence isolated by mode", () => {
    const progress = recordQualifyingRuns(createDefaultArcadeProgress(), "maze", "deliberate");
    expect(recommendArcadeStage(progress, "maze")).toBe("reflex");
    expect(recommendArcadeStage(progress, "pattern")).toBe("deliberate");
    expect(recommendArcadeStage(progress, "pong")).toBe("deliberate");
    expect(recommendArcadeStage(progress, "song")).toBe("deliberate");
    expect(recommendArcadeStage(progress, "resonance")).toBe("deliberate");
    expect(recommendArcadeStage(progress, "draw")).toBe("deliberate");
  });
});
