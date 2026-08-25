import { describe, expect, it } from "vitest";

import { detectPitch, midiToFrequency } from "../src";
import {
  centsError,
  generateSyntheticSignal,
} from "./synthetic-signals";

const SAMPLE_RATE = 48_000;
const WINDOW_SAMPLES = 4_096;
const LIVE_EDGE_SAMPLES = 960;
const C3_MIDI = 48;

describe("YIN harmonic-family selection", () => {
  it.each([
    { dominant: 2, weights: [0.08, 1, 0.24, 0.12, 0.06] },
    { dominant: 3, weights: [0.15, 0.2, 1, 0.12, 0.08] },
    { dominant: 4, weights: [0.15, 0.2, 0.16, 1, 0.1] },
    { dominant: 5, weights: [0.15, 0.2, 0.16, 0.12, 1] },
  ])(
    "selects one primitive C3 family when partial $dominant dominates",
    ({ dominant, weights }) => {
      const expectedHz = midiToFrequency(C3_MIDI);
      for (const phaseRadians of [0.13, 0.71, 1.37]) {
        const frame = detectPitch(generateSyntheticSignal({
          sampleRate: SAMPLE_RATE,
          durationSeconds: WINDOW_SAMPLES / SAMPLE_RATE,
          frequencyHz: expectedHz,
          amplitude: 0.12,
          fundamentalAmplitude: weights[0],
          phaseRadians,
          harmonics: weights.slice(1).map((amplitude, index) => ({
            multiple: index + 2,
            amplitude,
            phaseRadians: (index + 2) * phaseRadians + index * 0.29,
          })),
        }), {
          sampleRate: SAMPLE_RATE,
          currentEdgeSpanSamples: LIVE_EDGE_SAMPLES,
        });

        expect(frame, `dominant ${dominant}, phase ${phaseRadians}`).toMatchObject({
          reason: "detected",
          voiced: true,
          nearestMidi: C3_MIDI,
        });
        expect(
          Math.abs(centsError(frame.frequencyHz!, expectedHz)),
          `dominant ${dominant}, phase ${phaseRadians}`,
        ).toBeLessThan(4);
        expect(frame.rawCandidate).not.toBeNull();
        expect(Object.isFrozen(frame.rawCandidate)).toBe(true);
        expect(frame.harmonicAmbiguity).toBeGreaterThanOrEqual(0);
        expect(frame.harmonicAmbiguity).toBeLessThanOrEqual(1);
      }
    },
  );

  it("keeps weak-fundamental ratios on both sides of the removed octave cutoff", () => {
    const expectedHz = midiToFrequency(C3_MIDI);
    for (const fundamentalAmplitude of [0.055, 0.074, 0.075, 0.08, 0.15]) {
      const frame = detectPitch(generateSyntheticSignal({
        sampleRate: SAMPLE_RATE,
        durationSeconds: WINDOW_SAMPLES / SAMPLE_RATE,
        frequencyHz: expectedHz,
        amplitude: 0.12,
        fundamentalAmplitude,
        harmonics: [
          { multiple: 2, amplitude: 1, phaseRadians: 0.37 },
          { multiple: 3, amplitude: 0.24, phaseRadians: 1.13 },
          { multiple: 4, amplitude: 0.12, phaseRadians: 0.71 },
        ],
      }), {
        sampleRate: SAMPLE_RATE,
        currentEdgeSpanSamples: LIVE_EDGE_SAMPLES,
      });

      expect(frame, `${fundamentalAmplitude} fundamental`).toMatchObject({
        reason: "detected",
        nearestMidi: C3_MIDI,
      });
      expect(Math.abs(centsError(frame.frequencyHz!, expectedHz))).toBeLessThan(4);
    }
  });

  it("does not fold a noisy true low family upward when odd harmonics identify its period", () => {
    for (const expectedMidi of [30, 36, 40]) {
      const expectedHz = midiToFrequency(expectedMidi);
      for (const noiseSeed of [1, 20]) {
        const frame = detectPitch(generateSyntheticSignal({
          sampleRate: SAMPLE_RATE,
          durationSeconds: WINDOW_SAMPLES / SAMPLE_RATE,
          frequencyHz: expectedHz,
          amplitude: 0.08,
          fundamentalAmplitude: 0.08,
          harmonics: [
            { multiple: 2, amplitude: 1, phaseRadians: 0.37 },
            { multiple: 3, amplitude: 0.24, phaseRadians: 1.13 },
            { multiple: 4, amplitude: 0.12, phaseRadians: 0.71 },
            { multiple: 6, amplitude: 0.06, phaseRadians: 1.91 },
          ],
          noiseAmplitude: 0.05,
          noiseSeed,
        }), {
          sampleRate: SAMPLE_RATE,
          currentEdgeSpanSamples: LIVE_EDGE_SAMPLES,
        });

        expect(frame, `MIDI ${expectedMidi}, noise seed ${noiseSeed}`).toMatchObject({
          reason: "detected",
          nearestMidi: expectedMidi,
        });
        expect(
          Math.abs(centsError(frame.frequencyHz!, expectedHz)),
          `MIDI ${expectedMidi}, noise seed ${noiseSeed}`,
        ).toBeLessThan(20);
      }
    }
  });

  it("retains pure and voice-like true high notes", () => {
    const expectedMidi = 72;
    const expectedHz = midiToFrequency(expectedMidi);
    const cases = [
      generateSyntheticSignal({
        sampleRate: SAMPLE_RATE,
        durationSeconds: WINDOW_SAMPLES / SAMPLE_RATE,
        frequencyHz: expectedHz,
        amplitude: 0.16,
      }),
      generateSyntheticSignal({
        sampleRate: SAMPLE_RATE,
        durationSeconds: WINDOW_SAMPLES / SAMPLE_RATE,
        frequencyHz: expectedHz,
        amplitude: 0.16,
        harmonics: [
          { multiple: 2, amplitude: 0.35, phaseRadians: 0.37 },
          { multiple: 3, amplitude: 0.17, phaseRadians: 1.13 },
        ],
      }),
    ];

    for (const samples of cases) {
      const frame = detectPitch(samples, {
        sampleRate: SAMPLE_RATE,
        currentEdgeSpanSamples: LIVE_EDGE_SAMPLES,
      });
      expect(frame).toMatchObject({ reason: "detected", nearestMidi: expectedMidi });
      expect(Math.abs(centsError(frame.frequencyHz!, expectedHz))).toBeLessThan(2);
      expect(frame.rawCandidate).toMatchObject({
        frequencyHz: expect.any(Number),
        periodSamples: expect.any(Number),
        yinValue: expect.any(Number),
        confidence: expect.any(Number),
      });
      expect(Object.isFrozen(frame.rawCandidate)).toBe(true);
    }
  });

  it("does not turn a normal high-note onset into a confident octave-down frame", () => {
    const expectedMidi = 64;
    const expectedHz = midiToFrequency(expectedMidi);
    const samples = new Float32Array(WINDOW_SAMPLES);
    const onsetSample = samples.length - 1_896;
    for (let index = onsetSample; index < samples.length; index += 1) {
      const onsetIndex = index - onsetSample;
      const phase = 2 * Math.PI * expectedHz * onsetIndex / SAMPLE_RATE;
      samples[index] = 0.1 * (
        Math.sin(phase + 0.1)
        + 0.35 * Math.sin(2 * phase + 0.7)
        + 0.173333 * Math.sin(3 * phase + 1.3)
      );
    }

    const frame = detectPitch(samples, {
      sampleRate: SAMPLE_RATE,
      currentEdgeSpanSamples: LIVE_EDGE_SAMPLES,
    });
    expect(frame).toMatchObject({ reason: "detected", nearestMidi: expectedMidi });
    expect(Math.abs(centsError(frame.frequencyHz!, expectedHz))).toBeLessThan(5);
  });

  it("populates explicit empty raw-family telemetry when no candidate exists", () => {
    expect(detectPitch(new Float32Array(WINDOW_SAMPLES), {
      sampleRate: SAMPLE_RATE,
    })).toMatchObject({
      reason: "below-rms-threshold",
      rawCandidate: null,
      harmonicAmbiguity: 0,
    });
  });
});
