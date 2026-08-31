import { describe, expect, it } from "vitest";

import {
  medianSmoothPitchFrames,
  midiToFrequency,
  type PitchFrame,
  type YinPitchFrame,
} from "../src";

function frame(midiFloat: number | null, index: number): PitchFrame {
  if (midiFloat === null) {
    return {
      timeSeconds: index * 0.01,
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
      rms: 0,
      confidence: 0,
      voiced: false,
    };
  }

  const nearestMidi = Math.round(midiFloat);
  return {
    timeSeconds: index * 0.01,
    frequencyHz: midiToFrequency(midiFloat),
    midiFloat,
    nearestMidi,
    centsFromNearest: 100 * (midiFloat - nearestMidi),
    rms: 0.2 + index / 100,
    confidence: 0.9,
    voiced: true,
  };
}

function midiValues(frames: readonly PitchFrame[]): Array<number | null> {
  return frames.map((item) => item.midiFloat);
}

describe("median pitch smoothing", () => {
  it("removes a one-frame pitch impulse while retaining continuous MIDI", () => {
    const source = [69, 69.1, 74, 69.2, 69.1].map(frame);
    const result = medianSmoothPitchFrames(source);

    expect(result[2].midiFloat).toBeCloseTo(69.2, 8);
    expect(result[2].nearestMidi).toBe(69);
    expect(result[2].centsFromNearest).toBeCloseTo(20, 8);
    expect(result[2].frequencyHz).toBeCloseTo(midiToFrequency(69.2), 8);
    expect(result[2].rms).toBe(source[2].rms);
  });

  it("does not interpolate across an unvoiced gap", () => {
    const source = [69, null, 81].map(frame);
    const result = medianSmoothPitchFrames(source);

    expect(midiValues(result)).toEqual([69, null, 81]);
    expect(result[1].voiced).toBe(false);
  });

  it("leaves incomplete edge windows alone instead of averaging two notes", () => {
    const source = [69, 76].map(frame);
    const result = medianSmoothPitchFrames(source);

    expect(midiValues(result)).toEqual([69, 76]);
  });

  it("rejects impossible smoothing windows and invalid reference frequencies", () => {
    expect(() => medianSmoothPitchFrames([frame(69, 0)], { radius: 1, minSamples: 4 }))
      .toThrow(/window size/);
    expect(() => medianSmoothPitchFrames([frame(69, 0)], { radius: 0, a4Frequency: 0 }))
      .toThrow(/a4Frequency/);
  });
});

describe("detector-diagnostic preservation", () => {
  it("preserves detector diagnostics while smoothing pitch coordinates", () => {
    const source: YinPitchFrame[] = [69, 74, 69].map((midi, index) => ({
      ...frame(midi, index),
      detector: "yin",
      periodSamples: 100 + index,
      yinValue: 0.05 + index / 100,
      reason: "detected"
    }));

    const result = medianSmoothPitchFrames(source);

    expect(result[1].midiFloat).toBe(69);
    expect(result[1].detector).toBe("yin");
    expect(result[1].periodSamples).toBe(101);
    expect(result[1].yinValue).toBeCloseTo(0.06, 8);
    expect(result[1].reason).toBe("detected");
  });
});
