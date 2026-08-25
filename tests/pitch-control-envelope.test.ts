import { describe, expect, it } from "vitest";

import {
  ENVELOPE_CYCLE_SECONDS,
  pitchControlEnvelopeDisplayLevels,
  scoreEnvelope,
} from "../apps/web/src/features/pitch-control/pitch-control-model";

const points = [0, 0.5, 1, 0.5, 0] as const;

function frames(levels: readonly number[]) {
  return levels.map((rms) => ({ rms }));
}

describe("Pitch Control's non-terminating target phase", () => {
  it("keeps historical RMS coordinates fixed when louder and quieter evidence arrives", () => {
    const historicalFrames = frames([0.001, 0.01, 0.1]);
    const historicalCoordinates = pitchControlEnvelopeDisplayLevels(historicalFrames);
    const afterLouderFrame = pitchControlEnvelopeDisplayLevels([
      ...historicalFrames,
      { rms: 1 },
    ]);
    const afterQuieterFrame = pitchControlEnvelopeDisplayLevels([
      ...historicalFrames,
      { rms: 1e-6 },
    ]);

    expect(afterLouderFrame.slice(0, historicalFrames.length))
      .toEqual(historicalCoordinates);
    expect(afterQuieterFrame.slice(0, historicalFrames.length))
      .toEqual(historicalCoordinates);
    expect(historicalCoordinates[0]).toBeLessThan(historicalCoordinates[1]!);
    expect(historicalCoordinates[1]).toBeLessThan(historicalCoordinates[2]!);
  });

  it("scores repeated target cycles without treating a cycle as session lifetime", () => {
    const elapsed = [0, 2, 4, 6, 8, 10, 12, 14, 16];
    const levels = [0, 0.5, 1, 0.5, 0, 0.5, 1, 0.5, 0];
    expect(scoreEnvelope(
      frames(levels),
      elapsed,
      points,
      ENVELOPE_CYCLE_SECONDS,
      -1,
    )).toBeCloseTo(100, 8);
  });

  it("keeps prior target phases stable when the user continues another cycle", () => {
    const firstCycle = scoreEnvelope(
      frames([0, 0.5, 1, 0.5]),
      [0, 2, 4, 6],
      points,
      ENVELOPE_CYCLE_SECONDS,
      -1,
    );
    const continued = scoreEnvelope(
      frames([0, 0.5, 1, 0.5, 0, 0.5, 1, 0.5]),
      [0, 2, 4, 6, 8, 10, 12, 14],
      points,
      ENVELOPE_CYCLE_SECONDS,
      -1,
    );
    expect(firstCycle).toBeCloseTo(100, 8);
    expect(continued).toBeCloseTo(firstCycle!, 8);
  });

  it("rejects an invalid target cycle without inventing a trace cutoff", () => {
    expect(() => scoreEnvelope(frames([0, 1, 0, 1]), [0, 1, 2, 3], points, 0, -1))
      .toThrow(RangeError);
  });
});
