import { describe, expect, it } from "vitest";

import {
  correctOctaveJumps,
  medianSmoothPitchFrames,
  midiToFrequency,
  type PitchFrame,
  smoothPitchFrames,
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
});

describe("continuity-aware octave correction", () => {
  it("repairs a brief octave-up detector excursion that returns to its anchor", () => {
    const source = [69, 69.1, 81.15, 81.2, 69.25].map(frame);
    const result = correctOctaveJumps(source);

    expect(result[2].midiFloat).toBeCloseTo(69.15, 8);
    expect(result[3].midiFloat).toBeCloseTo(69.2, 8);
    expect(result[2].frequencyHz).toBeCloseTo(midiToFrequency(69.15), 8);
  });

  it("repairs a brief octave-down detector excursion", () => {
    const source = [64, 64.1, 52.05, 64.15].map(frame);
    const result = correctOctaveJumps(source);

    expect(result[2].midiFloat).toBeCloseTo(64.05, 8);
  });

  it("preserves a sustained octave change as potentially intentional", () => {
    const source = [69, 69, 81, 81, 81, 81].map(frame);
    const result = correctOctaveJumps(source, { maxOutlierFrames: 2 });

    expect(midiValues(result)).toEqual([69, 69, 81, 81, 81, 81]);
  });

  it("does not bridge octave corrections across loss of voicing", () => {
    const source = [69, 81, null, 69].map(frame);
    const result = correctOctaveJumps(source);

    expect(midiValues(result)).toEqual([69, 81, null, 69]);
  });

  it("does not reinterpret an unrelated wide leap as an octave error", () => {
    const source = [60, 69, 60].map(frame);
    const result = correctOctaveJumps(source);

    expect(midiValues(result)).toEqual([60, 69, 60]);
  });
});

describe("combined frame smoothing", () => {
  it("runs octave repair before the median filter", () => {
    const source = [69, 69.05, 81.1, 69.15, 69.2].map(frame);
    const result = smoothPitchFrames(source);

    expect(result.every((item) => (item.midiFloat ?? 69) < 70)).toBe(true);
    expect(result[2].midiFloat).toBeCloseTo(69.1, 8);
  });

  it("can retain raw octaves when correction is disabled", () => {
    const source = [69, 81, 69].map(frame);
    const result = smoothPitchFrames(source, {
      correctOctaveJumps: false,
      radius: 0,
    });

    expect(midiValues(result)).toEqual([69, 81, 69]);
  });
});
