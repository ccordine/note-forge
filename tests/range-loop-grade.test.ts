import { describe, expect, it } from "vitest";

import { gradeRangeAttempt } from "../apps/web/src/features/range-loop/grade";

describe("range-loop attempt grading", () => {
  it("awards a top grade to a centered, stable, immediate hold", () => {
    expect(gradeRangeAttempt({
      medianErrorCents: 0,
      stabilityCents: 0,
      timeToAcquireMs: 0,
      resetCount: 0,
      toleranceCents: 20,
      requiredHoldMs: 3_000,
    })).toMatchObject({ score: 100, letter: "A+", label: "Centered and steady" });
  });

  it("grades center, stability, acquisition, and continuity independently", () => {
    const grade = gradeRangeAttempt({
      medianErrorCents: -10,
      stabilityCents: 8,
      timeToAcquireMs: 2_000,
      resetCount: 2,
      toleranceCents: 20,
      requiredHoldMs: 3_000,
    });

    expect(grade.centerScore).toBeCloseTo(62.96, 1);
    expect(grade.stabilityScore).toBeCloseTo(70.37, 1);
    expect(grade.acquisitionScore).toBeCloseTo(66.67, 1);
    expect(grade.continuityScore).toBeCloseTo(52.63, 1);
    expect(grade.score).toBe(64);
    expect(grade.letter).toBe("D");
  });

  it("uses an explicit low score when pitch metrics are unavailable", () => {
    const grade = gradeRangeAttempt({
      timeToAcquireMs: 0,
      resetCount: 0,
      toleranceCents: 20,
      requiredHoldMs: 1_500,
    });

    expect(grade).toMatchObject({ score: 25, letter: "D" });
  });

  it("rejects invalid grading inputs", () => {
    expect(() => gradeRangeAttempt({ timeToAcquireMs: -1, resetCount: 0, toleranceCents: 20, requiredHoldMs: 1_000 })).toThrow(RangeError);
    expect(() => gradeRangeAttempt({ timeToAcquireMs: 0, resetCount: 0, toleranceCents: 0, requiredHoldMs: 1_000 })).toThrow(RangeError);
    expect(() => gradeRangeAttempt({ timeToAcquireMs: 0, resetCount: 0, toleranceCents: 20, requiredHoldMs: 0 })).toThrow(RangeError);
    expect(() => gradeRangeAttempt({ medianErrorCents: Number.NaN, timeToAcquireMs: 0, resetCount: 0, toleranceCents: 20, requiredHoldMs: 1_000 })).toThrow(RangeError);
    expect(() => gradeRangeAttempt({ stabilityCents: Number.POSITIVE_INFINITY, timeToAcquireMs: 0, resetCount: 0, toleranceCents: 20, requiredHoldMs: 1_000 })).toThrow(RangeError);
    expect(() => gradeRangeAttempt({ timeToAcquireMs: 0, resetCount: 0.5, toleranceCents: 20, requiredHoldMs: 1_000 })).toThrow(RangeError);
  });

  it.each([
    { score: 64, letter: "D", centerError: 23.1428571429 },
    { score: 65, letter: "C", centerError: 22.5 },
    { score: 74, letter: "C", centerError: 16.7142857143 },
    { score: 75, letter: "B", centerError: 16.0714285714 },
    { score: 84, letter: "B", centerError: 10.2857142857 },
    { score: 85, letter: "A", centerError: 9.6428571429 },
    { score: 92, letter: "A", centerError: 5.1428571429 },
    { score: 93, letter: "A+", centerError: 4.5 },
  ] as const)("maps exact score boundary $score to $letter", ({ score, letter, centerError }) => {
    expect(gradeRangeAttempt({
      medianErrorCents: centerError,
      stabilityCents: 0,
      timeToAcquireMs: 0,
      resetCount: 0,
      toleranceCents: 20,
      requiredHoldMs: 3_000,
    })).toMatchObject({ score, letter });
  });
});
