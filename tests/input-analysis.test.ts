import { describe, expect, it } from "vitest";

import {
  amplitudeToDbfs,
  analyzeInputBuffer,
  applyGateHysteresis,
  dbfsToAmplitude,
  deriveGateLevelDbfs,
  deriveNoiseGateThresholds,
  estimateNoiseFloorDbfs,
} from "../apps/web/src/audio/input-analysis";

describe("dBFS conversion", () => {
  it("converts known linear amplitudes without clamping over-scale input", () => {
    expect(amplitudeToDbfs(1)).toBeCloseTo(0, 10);
    expect(amplitudeToDbfs(0.5)).toBeCloseTo(-6.0206, 4);
    expect(amplitudeToDbfs(-0.1)).toBeCloseTo(-20, 10);
    expect(amplitudeToDbfs(2)).toBeCloseTo(6.0206, 4);
    expect(amplitudeToDbfs(0, -96)).toBe(-96);
  });

  it("round-trips finite amplitudes and represents negative infinity as silence", () => {
    for (const amplitude of [0.001, 0.1, 0.5, 1, 1.4]) {
      expect(dbfsToAmplitude(amplitudeToDbfs(amplitude)))
        .toBeCloseTo(amplitude, 12);
    }
    expect(dbfsToAmplitude(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("input-buffer diagnostics", () => {
  it("reports RMS, peak, DC, clipping, and crest factor", () => {
    const result = analyzeInputBuffer(new Float32Array([1, 0, -1, 0]));

    expect(result.rms).toBeCloseTo(Math.SQRT1_2, 10);
    expect(result.rmsDbfs).toBeCloseTo(-3.0103, 4);
    expect(result.peak).toBe(1);
    expect(result.peakDbfs).toBe(0);
    expect(result.dcOffset).toBe(0);
    expect(result.clippedSampleCount).toBe(2);
    expect(result.clippingRatio).toBe(0.5);
    expect(result.isClipping).toBe(true);
    expect(result.crestFactor).toBeCloseTo(Math.SQRT2, 10);
    expect(result.crestFactorDb).toBeCloseTo(3.0103, 4);
  });

  it("measures signed DC offset and supports a configurable warning threshold", () => {
    const result = analyzeInputBuffer([0.25, 0.25, 0.25, 0.25], {
      clippingThreshold: 0.2,
    });

    expect(result.rms).toBe(0.25);
    expect(result.dcOffset).toBe(0.25);
    expect(result.dcOffsetDbfs).toBeCloseTo(-12.0412, 4);
    expect(result.crestFactor).toBe(1);
    expect(result.crestFactorDb).toBe(0);
    expect(result.clippingRatio).toBe(1);
  });

  it("isolates invalid samples instead of poisoning the meter", () => {
    const result = analyzeInputBuffer([0.5, Number.NaN, Number.POSITIVE_INFINITY]);

    expect(result.sampleCount).toBe(3);
    expect(result.validSampleCount).toBe(1);
    expect(result.invalidSampleCount).toBe(2);
    expect(result.rms).toBe(0.5);
  });

  it("returns stable empty-buffer diagnostics", () => {
    const result = analyzeInputBuffer([]);

    expect(result.rms).toBe(0);
    expect(result.rmsDbfs).toBe(-120);
    expect(result.peakDbfs).toBe(-120);
    expect(result.crestFactor).toBeNull();
    expect(result.crestFactorDb).toBeNull();
    expect(result.clippingRatio).toBe(0);
  });
});

describe("noise calibration", () => {
  it("uses a median estimate that resists brief loud transients", () => {
    const estimate = estimateNoiseFloorDbfs([
      -61,
      -60.5,
      -60.2,
      -60,
      -59,
      -20,
      -3,
    ]);

    expect(estimate).toBe(-60);
  });

  it("filters non-finite readings and interpolates configurable quantiles", () => {
    expect(estimateNoiseFloorDbfs([-80, -60, -40, Number.NaN], {
      quantile: 0.25,
    })).toBe(-70);
    expect(estimateNoiseFloorDbfs([Number.NaN, Number.POSITIVE_INFINITY]))
      .toBeNull();
  });
});

describe("noise gate", () => {
  it("adds headroom above the floor and clamps impractical thresholds", () => {
    expect(deriveGateLevelDbfs(-60)).toBe(-48);
    expect(deriveGateLevelDbfs(-100)).toBe(-72);
    expect(deriveGateLevelDbfs(-20)).toBe(-18);
  });

  it("derives a lower closing threshold", () => {
    expect(deriveNoiseGateThresholds(-60)).toEqual({
      noiseFloorDbfs: -60,
      openThresholdDbfs: -48,
      closeThresholdDbfs: -52,
      marginDb: 12,
      hysteresisDb: 4,
    });
  });

  it("holds state inside the hysteresis band instead of chattering", () => {
    const thresholds = deriveNoiseGateThresholds(-60);

    expect(applyGateHysteresis(false, -49, thresholds)).toBe(false);
    expect(applyGateHysteresis(false, -48, thresholds)).toBe(true);
    expect(applyGateHysteresis(true, -51, thresholds)).toBe(true);
    expect(applyGateHysteresis(true, -52, thresholds)).toBe(false);
    expect(applyGateHysteresis(true, null, thresholds)).toBe(false);
  });
});
