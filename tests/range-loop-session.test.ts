import { describe, expect, it } from "vitest";
import { emptyLoopProgress } from "../apps/web/src/features/range-loop/progress";
import {
  completeRangeLoopFamily,
  firstRangeLoopTarget,
  hydrateRangeLoopState,
  isRangeLoopFamily,
  isRangeLoopHold,
  isRangeLoopNoteSet,
  isRangeLoopOrder,
  isRangeLoopTolerance,
  markRangeLoopTargetPassed,
  rangeLoopTargetSequence,
} from "../apps/web/src/features/range-loop/range-loop-session";

describe("Range Loop session projection", () => {
  it("normalizes stored settings into one complete session snapshot", () => {
    const progress = emptyLoopProgress();
    progress.chromatic.upper.passedMidis = [84, 85];
    const hydrated = hydrateRangeLoopState(
      {
        activeFamilyId: "upper",
        noteSet: "chromatic",
        order: "descending",
        holdSeconds: 5,
        toleranceCents: 15,
        targetMidi: 86,
        progress,
      },
      { baseline: { midi: 72, source: "manual", updatedAt: null } },
      null,
      30,
      "2026-01-01T00:00:00.000Z",
    );

    expect(hydrated).toMatchObject({
      activeFamilyId: "upper",
      noteSet: "chromatic",
      order: "descending",
      holdSeconds: 5,
      toleranceCents: 15,
      targetMidi: 86,
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
      { activeFamilyId: "high", noteSet: "natural", progress },
      undefined,
      49,
      20,
      updatedAt,
    );

    expect(hydrated).toMatchObject({
      activeFamilyId: "low",
      noteSet: "chromatic",
      targetMidi: 49,
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
      30,
      "2026-01-01T00:00:00.000Z",
    );

    expect(hydrated).toMatchObject({
      activeFamilyId: "foundation",
      noteSet: "natural",
      targetMidi: 31,
      toleranceCents: 30,
    });
  });

  it("validates only settings represented by the single-surface controls", () => {
    expect(isRangeLoopFamily("low")).toBe(true);
    expect(isRangeLoopFamily("legacy")).toBe(false);
    expect(isRangeLoopNoteSet("chromatic")).toBe(true);
    expect(isRangeLoopNoteSet("pentatonic")).toBe(false);
    expect(isRangeLoopOrder("ascending")).toBe(true);
    expect(isRangeLoopOrder("shuffled")).toBe(false);
    expect(isRangeLoopHold(3)).toBe(true);
    expect(isRangeLoopHold(4)).toBe(false);
    expect(isRangeLoopTolerance(20)).toBe(true);
    expect(isRangeLoopTolerance(21)).toBe(false);
  });

  it("builds stable ascending and descending family sequences", () => {
    expect(rangeLoopTargetSequence("low", "natural", "ascending"))
      .toEqual([48, 50, 52, 53, 55, 57, 59]);
    expect(rangeLoopTargetSequence("low", "natural", "descending"))
      .toEqual([59, 57, 55, 53, 52, 50, 48]);
  });

  it("chooses the first unearned target and starts over after a full lap", () => {
    let progress = emptyLoopProgress();
    progress = markRangeLoopTargetPassed(progress, "low", "natural", 48);
    progress = markRangeLoopTargetPassed(progress, "low", "natural", 50);
    expect(firstRangeLoopTarget(progress, "low", "natural", "ascending")).toBe(52);

    for (const midi of [52, 53, 55, 57, 59]) {
      progress = markRangeLoopTargetPassed(progress, "low", "natural", midi);
    }
    expect(firstRangeLoopTarget(progress, "low", "natural", "ascending")).toBe(48);
  });

  it("records one immutable pass, restores a formerly parked target, and is idempotent", () => {
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
