import { describe, expect, it, vi } from "vitest";

import { evaluateExerciseObservation } from "../src";

const validObservation = {
  id: "attempt-1",
  exerciseType: "pitch-match",
  target: { midi: 60 },
  startedAt: new Date("2026-08-24T12:00:00.000Z"),
  completedAt: new Date("2026-08-24T12:00:01.000Z"),
};

describe("exercise observation materialization", () => {
  it("evaluates one valid observation and returns storage-safe timestamps", () => {
    const evaluator = vi.fn(() => ({ inToleranceRatio: 1 }));
    const attempt = evaluateExerciseObservation(validObservation, evaluator);

    expect(evaluator).toHaveBeenCalledOnce();
    expect(attempt).toMatchObject({
      id: "attempt-1",
      exerciseType: "pitch-match",
      startedAt: "2026-08-24T12:00:00.000Z",
      completedAt: "2026-08-24T12:00:01.000Z",
      metrics: { inToleranceRatio: 1 },
    });
  });

  it("rejects invalid identity and time evidence before invoking the evaluator", () => {
    const evaluator = vi.fn(() => ({}));

    expect(() => evaluateExerciseObservation({ ...validObservation, id: "" }, evaluator))
      .toThrow(/id/);
    expect(() => evaluateExerciseObservation({
      ...validObservation,
      startedAt: new Date("invalid"),
    }, evaluator)).toThrow(/valid dates/);
    expect(() => evaluateExerciseObservation({
      ...validObservation,
      completedAt: new Date("2026-08-24T11:59:59.000Z"),
    }, evaluator)).toThrow(/precede/);
    expect(evaluator).not.toHaveBeenCalled();
  });
});
