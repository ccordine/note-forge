import { describe, expect, it } from "vitest";

import { detectPitch, midiToFrequency } from "../src";

const SAMPLE_RATE = 48_000;
const WINDOW_SAMPLES = 4_096;
const HOP_SAMPLES = 960;
const B2_MIDI = 47;

function createNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000 * 2 - 1;
  };
}

/**
 * Adjacent glottal cycles vary in strength while B2 and its formant-shaped
 * harmonic family remain dominant. The removed family override interpreted
 * this ordinary cycle variation as B1 even while YIN's own estimate was B2.
 */
function alternatingCycleB2(alternationDepth: number): Float32Array {
  const samples = new Float32Array(Math.round(1.5 * SAMPLE_RATE));
  const noise = createNoise(0x42_32);
  const frequencyHz = midiToFrequency(B2_MIDI);
  const weights = [0.126, 0.708, 0.447, 0.282, 0.178] as const;
  let phase = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const timeSeconds = index / SAMPLE_RATE;
    const vibratoCents = 8 * Math.sin(2 * Math.PI * 5.1 * timeSeconds);
    phase += 2 * Math.PI * frequencyHz * 2 ** (vibratoCents / 1_200) / SAMPLE_RATE;
    const cycle = Math.floor(phase / (2 * Math.PI));
    const cycleGain = 1 + alternationDepth * (cycle % 2 === 0 ? 1 : -1);
    let voice = 0;
    for (let harmonic = 1; harmonic <= weights.length; harmonic += 1) {
      voice += weights[harmonic - 1]!
        * Math.sin(harmonic * phase + harmonic * 0.31 + harmonic ** 2 * 0.07);
    }
    const slowEnvelope = 0.82
      + 0.13 * Math.sin(2 * Math.PI * 1.7 * timeSeconds + 0.2)
      + 0.05 * Math.sin(2 * Math.PI * 3.7 * timeSeconds + 0.9);
    samples[index] = 0.09 * slowEnvelope * cycleGain * voice
      + 0.0009 * noise();
  }
  return samples;
}

describe("direct YIN B2 octave regression", () => {
  it.each([0, 0.04, 0.08, 0.12, 0.18])(
    "does not halve B2 with %f adjacent-cycle alternation",
    (alternationDepth) => {
      const samples = alternatingCycleB2(alternationDepth);
      const frames = [];
      for (
        let start = 0;
        start + WINDOW_SAMPLES <= samples.length;
        start += HOP_SAMPLES
      ) {
        frames.push(detectPitch(
          samples.subarray(start, start + WINDOW_SAMPLES),
          {
            sampleRate: SAMPLE_RATE,
            currentEdgeSpanSamples: HOP_SAMPLES,
          },
        ));
      }

      expect(frames).toHaveLength(71);
      expect(frames.every((frame) => (
        frame.voiced
        && frame.nearestMidi === B2_MIDI
        && frame.rawCandidate?.frequencyHz === frame.frequencyHz
        && frame.rawCandidate.periodSamples === frame.periodSamples
      ))).toBe(true);
    },
  );
});
