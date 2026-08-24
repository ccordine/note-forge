import { describe, expect, it } from "vitest";
import {
  frequencyToMidi as musicFrequencyToMidi,
  midiToFrequency as musicMidiToFrequency,
} from "@noteforge/music-core";

import {
  frequencyToMidi as detectorFrequencyToMidi,
  midiToFrequency as detectorMidiToFrequency,
  pitchFrameAtMidi,
} from "../src";

describe("canonical pitch-math authority", () => {
  it("re-exports the exact music-core conversion functions instead of a second implementation", () => {
    expect(detectorFrequencyToMidi).toBe(musicFrequencyToMidi);
    expect(detectorMidiToFrequency).toBe(musicMidiToFrequency);
  });

  it("uses music-core's half-step coordinate semantics", () => {
    const frame = pitchFrameAtMidi({
      timeSeconds: 0,
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
      rms: 0,
      confidence: 1,
      voiced: false,
    }, -0.5);

    expect(frame.nearestMidi).toBe(0);
    expect(frame.centsFromNearest).toBe(-50);
  });
});
