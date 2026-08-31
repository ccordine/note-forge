import { describe, expect, it } from "vitest";

import { midiToFrequency } from "@noteforge/pitch-engine";
import {
  NoteInputEngine,
  type NoteInputWindow,
  type VocalObservation,
} from "../apps/web/src/audio/note-input";

const SAMPLE_RATE = 48_000;
const WINDOW_SAMPLES = 4_096;
const HOP_SAMPLES = 960;
const LOW_REGISTER_MIDIS = [43, 44, 45, 46, 47, 48, 49] as const;

interface VoiceProfile {
  readonly label: string;
  readonly harmonicGains: readonly number[];
  readonly harmonicPhaseOffset?: number;
  readonly vibratoCents?: number;
  readonly noiseSnrDb?: number;
  readonly attackSeconds?: number;
  readonly fallingAmplitude?: boolean;
  readonly alternatingCycleDepth?: number;
}

const VOICE_PROFILES: readonly VoiceProfile[] = Object.freeze([
  {
    label: "strong fundamental",
    harmonicGains: [1, 0.42, 0.2, 0.1, 0.05],
  },
  {
    label: "weak fundamental / strong second",
    harmonicGains: [0.08, 1, 0.24, 0.12, 0.06],
    harmonicPhaseOffset: 0.23,
  },
  {
    label: "open-vowel spectrum",
    harmonicGains: [0.28, 1, 0.7, 0.18, 0.08],
    harmonicPhaseOffset: 0.61,
  },
  {
    label: "closed-vowel spectrum",
    harmonicGains: [0.14, 0.32, 1, 0.5, 0.2],
    harmonicPhaseOffset: 1.13,
  },
  {
    label: "falling amplitude",
    harmonicGains: [0.7, 1, 0.34, 0.15, 0.07],
    fallingAmplitude: true,
  },
  {
    label: "soft attack",
    harmonicGains: [0.35, 1, 0.43, 0.18, 0.08],
    attackSeconds: 0.12,
  },
  {
    label: "vibrato",
    harmonicGains: [0.55, 1, 0.38, 0.16, 0.07],
    vibratoCents: 28,
  },
  {
    label: "breath contamination",
    harmonicGains: [0.35, 1, 0.42, 0.18, 0.08],
    noiseSnrDb: 14,
  },
  {
    label: "alternating glottal cycles",
    harmonicGains: [0.126, 0.708, 0.447, 0.282, 0.178],
    alternatingCycleDepth: 0.18,
  },
]);

function createNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000 * 2 - 1;
  };
}

function renderVoice(
  midi: number,
  durationSamples: number,
  profile: Readonly<VoiceProfile>,
  seed: number,
): Float32Array {
  const result = new Float32Array(durationSamples);
  const noise = createNoise(seed);
  const frequencyHz = midiToFrequency(midi);
  const unitRms = Math.sqrt(
    profile.harmonicGains.reduce((sum, gain) => sum + gain * gain, 0) / 2,
  );
  const voiceRms = 10 ** (-24 / 20);
  const noiseRms = profile.noiseSnrDb === undefined
    ? 0
    : voiceRms / 10 ** (profile.noiseSnrDb / 20);
  let phase = 0;

  for (let index = 0; index < result.length; index += 1) {
    const timeSeconds = index / SAMPLE_RATE;
    const progress = result.length <= 1 ? 0 : index / (result.length - 1);
    const vibratoCents = (profile.vibratoCents ?? 0)
      * Math.sin(2 * Math.PI * 5.2 * timeSeconds + 0.31);
    phase += 2 * Math.PI * frequencyHz * 2 ** (vibratoCents / 1_200) / SAMPLE_RATE;
    const cycle = Math.floor(phase / (2 * Math.PI));
    const alternatingGain = 1 + (profile.alternatingCycleDepth ?? 0)
      * (cycle % 2 === 0 ? 1 : -1);
    const attackGain = profile.attackSeconds === undefined
      ? 1
      : Math.min(1, timeSeconds / profile.attackSeconds);
    const fallingGain = profile.fallingAmplitude ? 1 - 0.9 * progress : 1;
    const slowMotion = 0.88
      + 0.08 * Math.sin(2 * Math.PI * 1.7 * timeSeconds + 0.2)
      + 0.04 * Math.sin(2 * Math.PI * 3.7 * timeSeconds + 0.9);
    let voice = 0;
    for (
      let harmonic = 1;
      harmonic <= profile.harmonicGains.length;
      harmonic += 1
    ) {
      voice += profile.harmonicGains[harmonic - 1]!
        * Math.sin(
          harmonic * phase
            + harmonic * (profile.harmonicPhaseOffset ?? 0.31)
            + harmonic * harmonic * 0.07,
        );
    }
    result[index] = voiceRms / unitRms
      * attackGain
      * fallingGain
      * slowMotion
      * alternatingGain
      * voice
      + noise() * Math.sqrt(3) * noiseRms;
  }
  return result;
}

function analysisWindows(samples: Float32Array): readonly NoteInputWindow[] {
  const windows: NoteInputWindow[] = [];
  for (
    let startSample = 0, processCount = 1;
    startSample + WINDOW_SAMPLES <= samples.length;
    startSample += HOP_SAMPLES, processCount += 1
  ) {
    const endSample = startSample + WINDOW_SAMPLES;
    windows.push(Object.freeze({
      samples: samples.subarray(startSample, endSample),
      sampleRate: SAMPLE_RATE,
      startSample,
      endSample,
      capturedAt: (startSample + endSample) / (2 * SAMPLE_RATE),
      captureEpoch: 1,
      continuityEpoch: 0,
      graphGeneration: 0,
      processCount,
      processedSampleCount: endSample,
      discontinuity: processCount === 1,
    }));
  }
  return windows;
}

function analyze(samples: Float32Array): readonly VocalObservation[] {
  const engine = new NoteInputEngine();
  return analysisWindows(samples).map((window) => engine.process(window).observation);
}

function centsFrom(observation: Readonly<VocalObservation>, midi: number): number | null {
  return observation.midiFloat === null
    ? null
    : (observation.midiFloat - midi) * 100;
}

function concatenate(...segments: readonly Float32Array[]): Float32Array {
  const result = new Float32Array(segments.reduce(
    (length, segment) => length + segment.length,
    0,
  ));
  let offset = 0;
  for (const segment of segments) {
    result.set(segment, offset);
    offset += segment.length;
  }
  return result;
}

describe("low-register direct-YIN regression", () => {
  it("does not halve G2 through C-sharp3 across vocal spectra and dynamics", () => {
    const durationSamples = WINDOW_SAMPLES + HOP_SAMPLES * 34;
    const failures = LOW_REGISTER_MIDIS.flatMap((midi) =>
      VOICE_PROFILES.flatMap((profile, profileIndex) => {
        const observations = analyze(renderVoice(
          midi,
          durationSamples,
          profile,
          0x4e_46_47 ^ Math.imul(midi, 257) ^ profileIndex,
        ));
        const rawCandidates = observations.flatMap((observation) =>
          observation.pitchCandidate?.rawCandidate === null
          || observation.pitchCandidate?.rawCandidate === undefined
            ? []
            : [observation.pitchCandidate.rawCandidate]);
        const octaveDown = rawCandidates.filter((candidate) =>
          Math.abs(1_200 * Math.log2(candidate.frequencyHz / midiToFrequency(midi)) + 1_200)
            <= 100);
        const authoritativeWrong = observations.filter((observation) =>
          observation.observationKind === "voiced"
          && Math.abs(centsFrom(observation, midi) ?? Number.POSITIVE_INFINITY) > 50);
        const correct = observations.filter((observation) =>
          observation.observationKind === "voiced"
          && Math.abs(centsFrom(observation, midi) ?? Number.POSITIVE_INFINITY) <= 50);
        const minimumCorrect = Math.floor(observations.length * 0.75);
        return octaveDown.length === 0
          && authoritativeWrong.length === 0
          && correct.length >= minimumCorrect
          ? []
          : [{
              midi,
              profile: profile.label,
              frames: observations.length,
              correct: correct.length,
              octaveDown: octaveDown.length,
              authoritativeWrong: authoritativeWrong.map((observation) => ({
                endSample: observation.endSample,
                midiFloat: observation.midiFloat,
                decision: observation.pitchTrackingDecision,
              })),
            }];
      }));

    expect(failures).toEqual([]);
  }, 30_000);

  it("publishes the direct YIN candidate without an octave reinterpretation", () => {
    const samples = renderVoice(
      47,
      WINDOW_SAMPLES + HOP_SAMPLES * 20,
      VOICE_PROFILES.at(-1)!,
      0x42_32,
    );
    const detected = analyze(samples).filter((observation) =>
      observation.pitchCandidate?.voiced === true);

    expect(detected.length).toBeGreaterThan(15);
    expect(detected.flatMap((observation) => {
      const candidate = observation.pitchCandidate!;
      const raw = candidate.rawCandidate!;
      return candidate.frequencyHz === raw.frequencyHz
        && candidate.periodSamples === raw.periodSamples
        ? []
        : [{ candidate, raw }];
    })).toEqual([]);
  });

  it.each([
    [47, 59],
    [59, 47],
    [43, 55],
    [55, 43],
    [47, 55],
    [55, 47],
    [43, 44],
    [44, 43],
    [44, 45],
    [45, 44],
    [45, 46],
    [46, 45],
    [46, 47],
    [47, 46],
    [47, 48],
    [48, 47],
    [48, 49],
    [49, 48],
  ] as const)("accepts abrupt MIDI %i to %i without octave stickiness", (fromMidi, toMidi) => {
    const segmentSamples = HOP_SAMPLES * 30;
    const profile = VOICE_PROFILES[0]!;
    const samples = concatenate(
      renderVoice(fromMidi, segmentSamples, profile, fromMidi * 17),
      renderVoice(toMidi, segmentSamples, profile, toMidi * 31),
    );
    const observations = analyze(samples);
    const stableBefore = observations.filter((observation) =>
      observation.endSample <= segmentSamples).slice(-8);
    const stableAfter = observations.filter((observation) =>
      observation.startSample >= segmentSamples).slice(-8);
    const firstAcceptedTarget = observations.find((observation) =>
      observation.endSample > segmentSamples
      && observation.observationKind === "voiced"
      && Math.abs(centsFrom(observation, toMidi) ?? Number.POSITIVE_INFINITY) <= 50);

    expect(stableBefore).toHaveLength(8);
    expect(stableBefore.every((observation) =>
      observation.observationKind === "voiced"
      && Math.abs(centsFrom(observation, fromMidi) ?? Number.POSITIVE_INFINITY) <= 50))
      .toBe(true);
    expect(stableAfter).toHaveLength(8);
    expect(stableAfter.every((observation) =>
      observation.observationKind === "voiced"
      && Math.abs(centsFrom(observation, toMidi) ?? Number.POSITIVE_INFINITY) <= 50))
      .toBe(true);
    expect(firstAcceptedTarget?.endSample).toBeLessThanOrEqual(
      segmentSamples + WINDOW_SAMPLES + HOP_SAMPLES * 4,
    );
  });
});
