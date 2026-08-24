import { describe, expect, it } from "vitest";
import { midiToFrequency } from "@noteforge/pitch-engine";
import {
  NoteInputEngine,
  type NoteInputWindow,
  type VocalObservation,
} from "../apps/web/src/audio/note-input";
import { generateSyntheticSignal } from "../packages/pitch-engine/test/synthetic-signals";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;

type BrightnessProfile = "dark" | "bright";

function profileAmplitude(profile: BrightnessProfile, harmonic: number): number {
  return profile === "dark"
    ? 0.55 / harmonic ** 1.8
    : 0.72 / harmonic ** 0.55;
}

function harmonicVoice(options: Readonly<{
  frequencyHz: number;
  profile: BrightnessProfile;
  amplitude?: number;
  noiseAmplitude?: number;
  phaseRadians?: number;
}>): Float32Array {
  return generateSyntheticSignal({
    sampleRate: SAMPLE_RATE,
    durationSeconds: WINDOW_SIZE / SAMPLE_RATE,
    frequencyHz: options.frequencyHz,
    amplitude: options.amplitude ?? 0.08,
    phaseRadians: options.phaseRadians ?? 0.31,
    harmonics: Array.from({ length: 15 }, (_, index) => {
      const harmonic = index + 2;
      return {
        multiple: harmonic,
        amplitude: profileAmplitude(options.profile, harmonic),
        phaseRadians: harmonic * 0.173,
      };
    }),
    noiseAmplitude: options.noiseAmplitude,
    noiseSeed: 0x42_52_49_47,
  });
}

function capturedWindow(
  samples: Float32Array,
  startSample = 24_000,
): NoteInputWindow {
  const endSample = startSample + samples.length;
  return {
    samples,
    capturedAt: (startSample + endSample) / (2 * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
    startSample,
    endSample,
    captureEpoch: 7,
    continuityEpoch: 3,
    graphGeneration: 2,
    processCount: 219,
    processedSampleCount: endSample,
    discontinuity: false,
  };
}

function observe(samples: Float32Array, startSample = 24_000): Readonly<VocalObservation> {
  return new NoteInputEngine().process(capturedWindow(samples, startSample)).observation;
}

function expectVoicedBrightness(observation: Readonly<VocalObservation>): number {
  expect(observation.observationKind).toBe("voiced");
  expect(observation.voiced).toBe(true);
  expect(observation.brightness).not.toBeNull();
  expect(observation.brightnessConfidence).toBeGreaterThan(0);
  return observation.brightness!;
}

describe("shared vocal brightness telemetry", () => {
  it("separates dark and bright harmonic shapes at the same fundamental", () => {
    const frequencyHz = midiToFrequency(48);
    const dark = observe(harmonicVoice({ frequencyHz, profile: "dark" }));
    const bright = observe(harmonicVoice({ frequencyHz, profile: "bright" }));
    const darkValue = expectVoicedBrightness(dark);
    const brightValue = expectVoicedBrightness(bright);

    expect(brightValue - darkValue).toBeGreaterThan(0.12);
    expect(dark.brightnessConfidence).toBeGreaterThan(0.8);
    expect(bright.brightnessConfidence).toBeGreaterThan(0.8);
  });

  it("is level-independent, including a quiet valid voice-like signal", () => {
    const frequencyHz = midiToFrequency(48);
    const ordinary = observe(harmonicVoice({
      frequencyHz,
      profile: "bright",
      amplitude: 0.08,
    }));
    const quiet = observe(harmonicVoice({
      frequencyHz,
      profile: "bright",
      amplitude: 0.001,
      phaseRadians: 1.17,
    }));
    const ordinaryValue = expectVoicedBrightness(ordinary);
    const quietValue = expectVoicedBrightness(quiet);

    expect(Math.abs(ordinaryValue - quietValue)).toBeLessThan(0.01);
    expect(quiet.rms).toBeLessThan(10 ** (-55 / 20));
    expect(quiet.brightnessConfidence).toBeGreaterThan(0.8);
  });

  it("does not reinterpret pitch transposition of the same envelope as brightness", () => {
    const lower = observe(harmonicVoice({
      frequencyHz: midiToFrequency(47),
      profile: "bright",
    }));
    const higher = observe(harmonicVoice({
      frequencyHz: midiToFrequency(55),
      profile: "bright",
      phaseRadians: 0.83,
    }));
    const lowerValue = expectVoicedBrightness(lower);
    const higherValue = expectVoicedBrightness(higher);

    expect(Math.abs(lowerValue - higherValue)).toBeLessThan(0.015);
  });

  it("reduces brightness confidence when broadband energy is not harmonically explained", () => {
    const frequencyHz = midiToFrequency(48);
    const clean = observe(harmonicVoice({
      frequencyHz,
      profile: "bright",
      amplitude: 0.08,
    }));
    const noisy = observe(harmonicVoice({
      frequencyHz,
      profile: "bright",
      amplitude: 0.08,
      noiseAmplitude: 0.025,
    }));

    expectVoicedBrightness(clean);
    expectVoicedBrightness(noisy);
    expect(noisy.brightnessConfidence).toBeLessThan(clean.brightnessConfidence);
  });

  it("emits no brightness control evidence for silence or nonperiodic noise", () => {
    const silence = observe(new Float32Array(WINDOW_SIZE));
    const noise = observe(generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: WINDOW_SIZE / SAMPLE_RATE,
      frequencyHz: 130.81,
      amplitude: 0,
      noiseAmplitude: 0.24,
      noiseSeed: 0x4e_4f_49_53,
    }));

    for (const observation of [silence, noise]) {
      expect(observation.voiced).toBe(false);
      expect(observation.brightness).toBeNull();
      expect(observation.brightnessConfidence).toBe(0);
    }
  });

  it("preserves bounded derived values and exact immutable sample authority", () => {
    const startSample = 913_207;
    const observation = observe(harmonicVoice({
      frequencyHz: midiToFrequency(52),
      profile: "bright",
    }), startSample);

    expectVoicedBrightness(observation);
    expect(observation.brightness).toBeGreaterThanOrEqual(0);
    expect(observation.brightness).toBeLessThanOrEqual(1);
    expect(observation.brightnessConfidence).toBeGreaterThanOrEqual(0);
    expect(observation.brightnessConfidence).toBeLessThanOrEqual(1);
    expect({
      startSample: observation.startSample,
      endSample: observation.endSample,
      processedSampleCount: observation.processedSampleCount,
      captureEpoch: observation.captureEpoch,
      continuityEpoch: observation.continuityEpoch,
      graphGeneration: observation.graphGeneration,
      workletProcessCount: observation.workletProcessCount,
    }).toEqual({
      startSample,
      endSample: startSample + WINDOW_SIZE,
      processedSampleCount: startSample + WINDOW_SIZE,
      captureEpoch: 7,
      continuityEpoch: 3,
      graphGeneration: 2,
      workletProcessCount: 219,
    });
    expect(Object.isFrozen(observation)).toBe(true);
  });
});
