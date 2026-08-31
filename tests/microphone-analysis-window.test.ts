import { describe, expect, it } from "vitest";

import { analysisWindowSizes } from "../apps/web/src/audio/microphone";

describe("microphone analysis window sizing", () => {
  it.each([
    { sampleRate: 44_100, windowSize: 4_096, hopSize: 882, meterSize: 1_024 },
    { sampleRate: 48_000, windowSize: 4_096, hopSize: 960, meterSize: 1_024 },
    { sampleRate: 96_000, windowSize: 8_192, hopSize: 1_920, meterSize: 2_048 },
    { sampleRate: 192_000, windowSize: 16_384, hopSize: 3_840, meterSize: 4_096 },
  ])(
    "preserves window depth and a 20 ms hop at $sampleRate Hz",
    ({ sampleRate, windowSize, hopSize, meterSize }) => {
      expect(analysisWindowSizes(sampleRate)).toEqual({ windowSize, hopSize, meterSize });
    },
  );

  it("keeps 100 deterministic sample-rate boundaries power-of-two, time-stable, and 45 Hz capable", () => {
    const referenceBufferSeconds = 4_096 / 48_000;
    const referenceMeterSeconds = 1_024 / 48_000;
    const maximumPowerOfTwoDurationRatio = Math.SQRT2 + 1e-12;

    for (let index = 0; index < 100; index += 1) {
      const sampleRate = 8_000 + index * 3_799;
      const windows = analysisWindowSizes(sampleRate);
      const bufferDurationRatio = windows.windowSize / sampleRate / referenceBufferSeconds;
      const meterDurationRatio = windows.meterSize / sampleRate / referenceMeterSeconds;

      expect(Number.isInteger(Math.log2(windows.windowSize))).toBe(true);
      expect(Number.isInteger(Math.log2(windows.meterSize))).toBe(true);
      expect(windows.hopSize / sampleRate).toBeCloseTo(0.02, 4);
      expect(windows.hopSize).toBeLessThan(windows.windowSize);
      expect(bufferDurationRatio).toBeGreaterThanOrEqual(1 / maximumPowerOfTwoDurationRatio);
      expect(bufferDurationRatio).toBeLessThanOrEqual(maximumPowerOfTwoDurationRatio);
      expect(meterDurationRatio).toBeGreaterThanOrEqual(1 / maximumPowerOfTwoDurationRatio);
      expect(meterDurationRatio).toBeLessThanOrEqual(maximumPowerOfTwoDurationRatio);
      expect(windows.windowSize - Math.ceil(sampleRate / 45) - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it("validates inputs before allocating worklet buffers", () => {
    expect(() => analysisWindowSizes(0)).toThrow(RangeError);
    expect(() => analysisWindowSizes(Number.NaN)).toThrow(RangeError);
    expect(() => analysisWindowSizes(2_400)).toThrow(/canonical detector range/);
    expect(() => analysisWindowSizes(768_001)).toThrow(/no greater than 768000/);
    expect(() => analysisWindowSizes(2_401)).not.toThrow();
    expect(() => analysisWindowSizes(20_000_000)).toThrow(/no greater than/);
    expect(() => analysisWindowSizes(48_000, 0)).toThrow(RangeError);
    expect(() => analysisWindowSizes(48_000, 4_096, 1.5)).toThrow(RangeError);
  });
});
