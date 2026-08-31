import { describe, expect, it } from "vitest";
import {
  emptyLoopProgress,
  profileOrderedTargets,
} from "../apps/web/src/features/range-loop/progress";
import {
  RANGE_LOOP_SCORING_VERSION,
  advanceRangeLoopTarget,
  chooseRangeLoopTarget,
  completeRangeLoopFamily,
  createRangeLoopLiveState,
  hydrateRangeLoopState,
  isRangeLoopFamily,
  isRangeLoopNoteSet,
  isRangeLoopOrder,
  markRangeLoopTargetPassed,
  reduceRangeLoopLiveState,
} from "../apps/web/src/features/range-loop/range-loop-session";

describe("Range Loop session projection", () => {
  it("crosses feature lifetime boundaries only through explicit Start and Finish", () => {
    const idle = createRangeLoopLiveState();
    expect(idle.phase).toBe("idle");

    const tracking = reduceRangeLoopLiveState(idle, { type: "start" });
    expect(tracking.phase).toBe("tracking");
    expect(reduceRangeLoopLiveState(tracking, { type: "start" })).toBe(tracking);

    const complete = reduceRangeLoopLiveState(tracking, { type: "finish" });
    expect(complete.phase).toBe("complete");
    expect(reduceRangeLoopLiveState(complete, { type: "finish" })).toBe(complete);
    expect(reduceRangeLoopLiveState(complete, { type: "start" }).phase).toBe("tracking");
  });

  it("normalizes current-version stored settings into one complete snapshot", () => {
    const progress = emptyLoopProgress();
    progress.chromatic.upper.passedMidis = [84, 85];
    const hydrated = hydrateRangeLoopState(
      {
        scoringVersion: RANGE_LOOP_SCORING_VERSION,
        activeFamilyId: "upper",
        noteSet: "chromatic",
        order: "descending",
        targetMidi: 86,
        progress,
      },
      { baseline: { midi: 72, source: "manual", updatedAt: null } },
      null,
      "2026-01-01T00:00:00.000Z",
    );

    expect(hydrated).toMatchObject({
      activeFamilyId: "upper",
      noteSet: "chromatic",
      order: "descending",
      targetMidi: 86,
      targetAcceptsCredit: true,
    });
    expect(hydrated.progress.chromatic.upper.passedMidis).toEqual([84, 85]);
    expect(hydrated.profile.baseline.midi).toBe(72);
  });

  it("makes an accidental handoff directly trainable without a family lock", () => {
    const progress = emptyLoopProgress();
    progress.chromatic.low.passedMidis = [49];
    progress.chromatic.low.parkedMidis = [49];
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const hydrated = hydrateRangeLoopState(
      {
        scoringVersion: RANGE_LOOP_SCORING_VERSION,
        activeFamilyId: "high",
        noteSet: "natural",
        progress,
      },
      undefined,
      49,
      updatedAt,
    );

    expect(hydrated).toMatchObject({
      activeFamilyId: "low",
      noteSet: "chromatic",
      targetMidi: 49,
      targetAcceptsCredit: true,
      profile: {
        baseline: { midi: 49, source: "manual", updatedAt },
      },
    });
    expect(hydrated.progress.chromatic.low.passedMidis).not.toContain(49);
    expect(hydrated.progress.chromatic.low.parkedMidis).not.toContain(49);
  });

  it("falls back through the complete six-family model", () => {
    const hydrated = hydrateRangeLoopState(
      { activeFamilyId: "locked", noteSet: "unknown", targetMidi: 999 },
      { baseline: { midi: 32, source: "manual", updatedAt: null } },
      null,
      "2026-01-01T00:00:00.000Z",
    );

    expect(hydrated).toMatchObject({
      activeFamilyId: "foundation",
      noteSet: "natural",
      targetMidi: 31,
      targetAcceptsCredit: true,
    });
  });

  it("retires old hold/tolerance settings and invalidates pre-cumulative passes", () => {
    const progress = emptyLoopProgress();
    progress.natural.low.passedMidis = [48, 50];
    progress.natural.low.parkedMidis = [52];
    progress.natural.low.cyclesCompleted = 4;
    const legacy = {
      activeFamilyId: "low",
      targetMidi: 48,
      toleranceCents: 5,
      holdSeconds: 3,
      progress,
    };
    const hydrated = hydrateRangeLoopState(
      legacy,
      undefined,
      null,
      "2026-01-01T00:00:00.000Z",
    );

    expect(hydrated).not.toHaveProperty("toleranceCents");
    expect(hydrated).not.toHaveProperty("holdSeconds");
    expect(hydrated.progress.natural.low).toEqual({
      passedMidis: [],
      parkedMidis: [52],
      cyclesCompleted: 4,
    });
    expect(hydrated.targetMidi).toBe(48);
  });

  it("validates only settings represented by the single-surface controls", () => {
    expect(isRangeLoopFamily("low")).toBe(true);
    expect(isRangeLoopFamily("legacy")).toBe(false);
    expect(isRangeLoopNoteSet("chromatic")).toBe(true);
    expect(isRangeLoopNoteSet("pentatonic")).toBe(false);
    expect(isRangeLoopOrder("ascending")).toBe(true);
    expect(isRangeLoopOrder("shuffled")).toBe(false);
  });

  it("chooses the nearest pending baseline-routed target", () => {
    let progress = emptyLoopProgress();
    progress = markRangeLoopTargetPassed(progress, "deep", "natural", 47);
    progress.natural.deep.parkedMidis = [45];

    expect(chooseRangeLoopTarget(
      progress,
      "deep",
      "natural",
      "ascending",
      48,
    )).toEqual({ targetMidi: 43, acceptingCredit: true });
  });

  it("enters Deep at B2 from a C3 baseline instead of jumping to C2", () => {
    expect(profileOrderedTargets("natural", "deep", "ascending", 48))
      .toEqual([47, 45, 43, 41, 40, 38, 36]);

    let progress = emptyLoopProgress();
    for (const midi of profileOrderedTargets("natural", "low", "ascending", 48)) {
      const next = advanceRangeLoopTarget(
        progress,
        "low",
        "natural",
        "ascending",
        48,
        midi,
        "passed",
      );
      progress = next.progress;
      if (midi === 59) {
        expect(next).toMatchObject({
          familyId: "deep",
          targetMidi: 47,
          acceptingCredit: true,
        });
        expect(next.progress.natural.low).toMatchObject({
          passedMidis: [],
          cyclesCompleted: 1,
        });
      }
    }
  });

  it("parks an unreachable note without awarding it and advances nearby", () => {
    const next = advanceRangeLoopTarget(
      emptyLoopProgress(),
      "deep",
      "natural",
      "ascending",
      48,
      47,
      "outside-range",
    );

    expect(next).toMatchObject({
      familyId: "deep",
      targetMidi: 45,
      acceptingCredit: true,
    });
    expect(next.progress.natural.deep).toMatchObject({
      passedMidis: [],
      parkedMidis: [47],
    });
    expect(next.progress.chromatic.deep.parkedMidis).toEqual([47]);
  });

  it("records one immutable pass and is idempotent", () => {
    const initial = emptyLoopProgress();
    initial.natural.low.parkedMidis = [48];
    const passed = markRangeLoopTargetPassed(initial, "low", "natural", 48);
    expect(passed).not.toBe(initial);
    expect(passed.natural.low).toMatchObject({ passedMidis: [48], parkedMidis: [] });
    expect(initial.natural.low).toMatchObject({ passedMidis: [], parkedMidis: [48] });
    expect(markRangeLoopTargetPassed(passed, "low", "natural", 48)).toBe(passed);
  });

  it("closes a family lap without changing another note set or family", () => {
    let progress = emptyLoopProgress();
    progress = markRangeLoopTargetPassed(progress, "low", "natural", 48);
    const middleBefore = progress.natural.middle;
    const chromaticBefore = progress.chromatic;
    const cycled = completeRangeLoopFamily(progress, "low", "natural");
    expect(cycled.natural.low).toEqual({
      passedMidis: [],
      parkedMidis: [],
      cyclesCompleted: 1,
    });
    expect(cycled.natural.middle).toBe(middleBefore);
    expect(cycled.chromatic).toBe(chromaticBefore);
  });
});
