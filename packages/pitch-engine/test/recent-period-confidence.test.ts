import { describe, expect, it } from "vitest";

import { detectPitch, midiToFrequency } from "../src";
import { recentPeriodConfidence } from "../src/recent-period-confidence";

const SAMPLE_RATE = 48_000;
const WINDOW_SAMPLES = 4_096;
const HOP_SAMPLES = 960;

function fixtureTone(midi: number): Float32Array {
  const frequency = midiToFrequency(midi);
  const sampleCount = Math.round(SAMPLE_RATE * 0.7);
  const edgeSamples = Math.round(SAMPLE_RATE * 0.008);
  const harmonicWeights = [1, 0.35, 0.173333] as const;
  const harmonicPhases = [0.1, 0.7, 1.3] as const;
  const targetRms = 10 ** (-24 / 20);
  const unitRms = Math.sqrt(
    harmonicWeights.reduce((sum, weight) => sum + weight ** 2, 0) / 2,
  );
  const amplitudeScale = targetRms / unitRms;
  const samples = new Float32Array(sampleCount);
  let phase = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    phase += 2 * Math.PI * frequency / SAMPLE_RATE;
    const edgeGain = Math.min(
      1,
      index / edgeSamples,
      (sampleCount - 1 - index) / edgeSamples,
    );
    const value = harmonicWeights.reduce((sum, weight, harmonicIndex) =>
      sum + weight * Math.sin(
        phase * (harmonicIndex + 1) + harmonicPhases[harmonicIndex]!,
      ), 0) * amplitudeScale * edgeGain;
    samples[index] = Math.round(value * 0x7fff) / 0x8000;
  }
  return samples;
}

function voiceLikeD6(durationSeconds: number): Float32Array {
  const frequency = midiToFrequency(86);
  const sampleCount = Math.round(SAMPLE_RATE * durationSeconds);
  const samples = new Float32Array(sampleCount);
  const targetRms = 10 ** (-24 / 20);
  const harmonicWeights = [1, 0.35, 0.173333] as const;
  const harmonicPhases = [0.1, 0.7, 1.3] as const;
  const unitRms = Math.sqrt(
    harmonicWeights.reduce((sum, weight) => sum + weight ** 2, 0) / 2,
  );
  const amplitudeScale = targetRms / unitRms;
  let noiseState = (0x53_55_53_54 ^ Math.imul(8, 0x9e_37_79_b1)) >>> 0;
  let voicePhase = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / SAMPLE_RATE;
    const vibratoCents = 14 * Math.sin(2 * Math.PI * 5.1 * time)
      + 3 * Math.sin(2 * Math.PI * 0.37 * time);
    voicePhase += 2 * Math.PI * frequency * 2 ** (vibratoCents / 1_200) / SAMPLE_RATE;
    const harmonicSignal = harmonicWeights.reduce((sum, weight, harmonicIndex) =>
      sum + weight * Math.sin(
        voicePhase * (harmonicIndex + 1) + harmonicPhases[harmonicIndex]!,
      ), 0);
    const amplitudeMotion = 0.72 + 0.2 * Math.sin(2 * Math.PI * 1.7 * time)
      + 0.08 * Math.sin(2 * Math.PI * 3.1 * time + 0.4);
    noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0;
    const breathNoise = (noiseState / 0x1_0000_0000 * 2 - 1)
      * Math.sqrt(3) * targetRms * 10 ** (-34 / 20);
    const value = Math.max(-1, Math.min(
      1,
      harmonicSignal * amplitudeScale * amplitudeMotion + breathNoise,
    ));
    samples[index] = Math.round(value * 0x7fff) / 0x7fff;
  }
  return samples;
}

function logarithmicOctaveGlide(durationSeconds: number): Float32Array {
  const sampleCount = Math.round(SAMPLE_RATE * durationSeconds);
  const samples = new Float32Array(sampleCount);
  let phase = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const midi = 48 + 12 * index / (sampleCount - 1);
    phase += 2 * Math.PI * midiToFrequency(midi) / SAMPLE_RATE;
    samples[index] = 0.08 * (
      Math.sin(phase + 0.1)
      + 0.35 * Math.sin(2 * phase + 0.7)
      + 0.173333 * Math.sin(3 * phase + 1.3)
    );
  }
  return samples;
}

describe("recent-period confidence", () => {
  it("does not admit an intermediate pitch at the exact abrupt E3 to G3 boundary", () => {
    const e3 = fixtureTone(52);
    const g3 = fixtureTone(55);
    const window = new Float32Array(WINDOW_SAMPLES);
    // Chromium's fixture-to-worklet path put this source slice in the
    // authoritative [149760, 153856) window: 1,536 E3 then 2,560 G3 samples.
    window.set(e3.subarray(e3.length - 1_536), 0);
    window.set(g3.subarray(0, 2_560), 1_536);

    const frame = detectPitch(window, {
      sampleRate: SAMPLE_RATE,
      currentEdgeSpanSamples: HOP_SAMPLES,
    });

    expect(frame.nearestMidi).not.toBe(54);
    expect(frame).toMatchObject({ reason: "detected", voiced: true, nearestMidi: 55 });
  });

  it("keeps a phase-continuous logarithmic octave glide voiced and monotonic", () => {
    const samples = logarithmicOctaveGlide(4);
    const midiValues: number[] = [];
    for (let start = 0; start + WINDOW_SAMPLES <= samples.length; start += HOP_SAMPLES) {
      const frame = detectPitch(samples.slice(start, start + WINDOW_SAMPLES), {
        sampleRate: SAMPLE_RATE,
        currentEdgeSpanSamples: HOP_SAMPLES,
      });
      expect(frame, `window starting at ${start}`).toMatchObject({
        reason: "detected",
        voiced: true,
      });
      midiValues.push(frame.midiFloat!);
    }

    expect(midiValues[0]).toBeGreaterThan(48);
    expect(midiValues.at(-1)).toBeLessThan(60);
    expect(midiValues.at(-1)).toBeGreaterThan(59.5);
    expect(midiValues.some((midi) => Math.abs(midi - Math.round(midi)) > 0.1)).toBe(true);
    for (let index = 1; index < midiValues.length; index += 1) {
      expect(midiValues[index]).toBeGreaterThan(midiValues[index - 1]!);
    }
  });

  it("rejects a stale 614-sample release prefix under live edge policy", () => {
    const samples = new Float32Array(WINDOW_SAMPLES);
    const frequency = midiToFrequency(50);
    for (let index = 0; index < 614; index += 1) {
      samples[index] = 0.1 * Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE + 0.7);
    }

    expect(detectPitch(samples, {
      sampleRate: SAMPLE_RATE,
      currentEdgeSpanSamples: HOP_SAMPLES,
    })).toMatchObject({ voiced: false, frequencyHz: null });
  });

  it("accepts arbitrarily quiet 45 Hz evidence under live edge policy", () => {
    const samples = new Float32Array(WINDOW_SAMPLES);
    for (let index = 0; index < samples.length; index += 1) {
      const phase = 2 * Math.PI * 45 * index / SAMPLE_RATE;
      samples[index] = 1e-7 * (
        Math.sin(phase + 0.1)
        + 0.35 * Math.sin(2 * phase + 0.7)
        + 0.173333 * Math.sin(3 * phase + 1.3)
      );
    }

    const frame = detectPitch(samples, {
      sampleRate: SAMPLE_RATE,
      currentEdgeSpanSamples: HOP_SAMPLES,
    });
    expect(frame).toMatchObject({ reason: "detected", voiced: true });
    expect(Math.abs(1_200 * Math.log2(frame.frequencyHz! / 45))).toBeLessThan(2);
  });

  it("keeps the authored sustained D6 periodic at every full-window hop", () => {
    const samples = voiceLikeD6(8.5);
    const failures: Array<{ start: number; reason: string; confidence: number }> = [];
    for (let start = 0; start + WINDOW_SAMPLES <= samples.length; start += HOP_SAMPLES) {
      const window = samples.slice(start, start + WINDOW_SAMPLES);
      const frame = detectPitch(window, {
        sampleRate: SAMPLE_RATE,
        currentEdgeSpanSamples: HOP_SAMPLES,
      });
      if (!frame.voiced || frame.nearestMidi !== 86) {
        failures.push({
          start,
          reason: frame.reason,
          confidence: frame.confidence,
        });
      }
    }

    expect(failures).toEqual([]);
  });

  it("ignores only bounded exact-zero transport padding at the current edge", () => {
    const source = voiceLikeD6(5.5).slice(-WINDOW_SAMPLES);
    const withZeroSuffix = (count: number) => {
      const window = source.slice();
      window.fill(0, window.length - count);
      return window;
    };

    for (const padding of [128, 154, 256]) {
      const window = withZeroSuffix(padding);
      const frame = detectPitch(window, {
        sampleRate: SAMPLE_RATE,
        currentEdgeSpanSamples: HOP_SAMPLES,
      });
      expect(recentPeriodConfidence(window, 41, HOP_SAMPLES)).toBeGreaterThan(0.9);
      expect(frame, `${padding} exact-zero edge samples`).toMatchObject({
        reason: "detected",
        voiced: true,
        nearestMidi: 86,
      });
    }
  });

  it("rejects exact-zero release tails beyond the transport-padding bound", () => {
    const source = voiceLikeD6(5.5).slice(-WINDOW_SAMPLES);
    for (const releaseSamples of [257, 602]) {
      const window = source.slice();
      window.fill(0, window.length - releaseSamples);
      const frame = detectPitch(window, {
        sampleRate: SAMPLE_RATE,
        currentEdgeSpanSamples: HOP_SAMPLES,
      });
      expect(recentPeriodConfidence(window, 41, HOP_SAMPLES)).toBe(0);
      expect(frame, `${releaseSamples} exact-zero release samples`).toMatchObject({
        reason: "below-confidence-threshold",
        voiced: false,
        frequencyHz: null,
        confidence: 0,
      });
    }
  });

  it("keeps exact-zero transport tolerance out of strict offline detection", () => {
    const window = voiceLikeD6(5.5).slice(-WINDOW_SAMPLES);
    window.fill(0, window.length - 154);

    expect(recentPeriodConfidence(window, 41)).toBe(0);
    expect(detectPitch(window, { sampleRate: SAMPLE_RATE })).toMatchObject({
      reason: "below-confidence-threshold",
      voiced: false,
    });
  });

  it("uses the live hop instead of one fragile pair before transport padding", () => {
    const window = voiceLikeD6(5.5).slice(-WINDOW_SAMPLES);
    const padding = 154;
    const seamEnd = window.length - padding;
    for (let index = seamEnd - 41; index < seamEnd; index += 1) {
      window[index] = 0.01 * Math.sin(index * 1.731) + 1e-6;
    }
    window.fill(0, seamEnd);

    expect(recentPeriodConfidence(window, 41)).toBeLessThan(0.55);
    expect(recentPeriodConfidence(window, 41, HOP_SAMPLES)).toBeGreaterThan(0.55);
    expect(detectPitch(window, {
      sampleRate: SAMPLE_RATE,
      currentEdgeSpanSamples: HOP_SAMPLES,
    })).toMatchObject({ reason: "detected", voiced: true, nearestMidi: 86 });
  });
});
