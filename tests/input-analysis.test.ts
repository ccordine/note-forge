import { describe, expect, it } from "vitest";

import { amplitudeToDbfs } from "../apps/web/src/audio/input-analysis";

describe("amplitudeToDbfs", () => {
  it("converts known linear amplitudes without clamping over-scale input", () => {
    expect(amplitudeToDbfs(1)).toBeCloseTo(0, 10);
    expect(amplitudeToDbfs(0.5)).toBeCloseTo(-6.0206, 4);
    expect(amplitudeToDbfs(-0.1)).toBeCloseTo(-20, 10);
    expect(amplitudeToDbfs(2)).toBeCloseTo(6.0206, 4);
  });

  it("uses the configured floor for silence, non-finite input, and tiny amplitudes", () => {
    expect(amplitudeToDbfs(0, -96)).toBe(-96);
    expect(amplitudeToDbfs(Number.NaN, -96)).toBe(-96);
    expect(amplitudeToDbfs(Number.POSITIVE_INFINITY, -96)).toBe(-96);
    expect(amplitudeToDbfs(1e-12, -96)).toBe(-96);
  });

  it("rejects invalid dBFS floors", () => {
    expect(() => amplitudeToDbfs(0.5, 1)).toThrow(RangeError);
    expect(() => amplitudeToDbfs(0.5, Number.NaN)).toThrow(RangeError);
    expect(() => amplitudeToDbfs(0.5, Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });
});
