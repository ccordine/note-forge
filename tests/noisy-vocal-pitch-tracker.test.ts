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
const C3_MIDI = 48;
const SEEDED_NOISE_MATRIX = Object.freeze(
  Array.from({ length: 40 }, (_unused, index) => index + 1),
);

type InterferenceStage = Readonly<{
  label: string;
  seconds: number;
  noiseSnrDb?: number;
  impulseAmplitude?: number;
  fundamentalGain?: number;
  secondGain?: number;
  thirdGain?: number;
  interferingFrequencyHz?: number;
  interferingSnrDb?: number;
}>;

const INTERFERENCE_STAGES: readonly InterferenceStage[] = Object.freeze([
  { label: "clean", seconds: 1.2 },
  { label: "broadband +30 dB SNR", seconds: 1.0, noiseSnrDb: 30 },
  { label: "broadband +20 dB SNR", seconds: 1.0, noiseSnrDb: 20 },
  { label: "broadband +10 dB SNR", seconds: 1.0, noiseSnrDb: 10 },
  { label: "short impulses", seconds: 1.0, noiseSnrDb: 24, impulseAmplitude: 0.8 },
  { label: "dominant second harmonic", seconds: 1.0, fundamentalGain: 0.08, secondGain: 1, thirdGain: 0.2 },
  { label: "dominant third harmonic", seconds: 1.0, fundamentalGain: 0.15, secondGain: 0.2, thirdGain: 1 },
  { label: "competing harmonic", seconds: 1.0, noiseSnrDb: 18, interferingFrequencyHz: midiToFrequency(67), interferingSnrDb: 8 },
  { label: "brief amplitude drops", seconds: 1.0, noiseSnrDb: 16 },
  { label: "clean recovery", seconds: 1.2 },
]);

function createNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000 * 2 - 1;
  };
}

function seededVoice(
  midi: number,
  seed: number,
  snrDb = 10,
  durationSeconds = 2,
): Float32Array {
  const sampleCount = durationSeconds * SAMPLE_RATE;
  const samples = new Float32Array(sampleCount);
  const fundamentalHz = midiToFrequency(midi);
  const voiceRms = 10 ** (-24 / 20);
  const noiseRms = voiceRms / 10 ** (snrDb / 20);
  const fundamentalGain = 1;
  const secondGain = 0.42;
  const thirdGain = 0.2;
  const unitRms = Math.sqrt(
    (fundamentalGain ** 2 + secondGain ** 2 + thirdGain ** 2) / 2,
  );
  const noise = createNoise(Math.imul(seed, 0x9e_37_79_b1));
  let phase = 0;
  for (let index = 0; index < samples.length; index += 1) {
    phase += 2 * Math.PI * fundamentalHz / SAMPLE_RATE;
    samples[index] = voiceRms / unitRms * (
      Math.sin(phase)
      + secondGain * Math.sin(2 * phase + 0.37)
      + thirdGain * Math.sin(3 * phase + 1.13)
    ) + noise() * Math.sqrt(3) * noiseRms;
  }
  return samples;
}

function seededC3(
  seed: number,
  snrDb = 10,
  durationSeconds = 2,
): Float32Array {
  return seededVoice(C3_MIDI, seed, snrDb, durationSeconds);
}

function concatenateSamples(...segments: readonly Float32Array[]): Float32Array {
  const result = new Float32Array(segments.reduce(
    (total, segment) => total + segment.length,
    0,
  ));
  let offset = 0;
  for (const segment of segments) {
    result.set(segment, offset);
    offset += segment.length;
  }
  return result;
}

function adversarialC3(): {
  samples: Float32Array;
  stageAtSample: (sample: number) => string;
} {
  const stageEnds: number[] = [];
  let sampleCount = 0;
  for (const stage of INTERFERENCE_STAGES) {
    sampleCount += Math.round(stage.seconds * SAMPLE_RATE);
    stageEnds.push(sampleCount);
  }
  const samples = new Float32Array(sampleCount);
  const stageAtSample = (sample: number): string => {
    const index = stageEnds.findIndex((end) => sample < end);
    return INTERFERENCE_STAGES[Math.max(0, index)]?.label ?? "tail";
  };
  const noise = createNoise(0x43_33_4e_4f);
  const fundamentalHz = midiToFrequency(C3_MIDI);
  const voiceRms = 10 ** (-24 / 20);
  let phase = 0;
  let stageIndex = 0;
  let stageStart = 0;
  for (let index = 0; index < samples.length; index += 1) {
    while (index >= stageEnds[stageIndex]!) {
      stageStart = stageEnds[stageIndex]!;
      stageIndex += 1;
    }
    const stage = INTERFERENCE_STAGES[stageIndex]!;
    const stageSample = index - stageStart;
    const stageTime = stageSample / SAMPLE_RATE;
    const voiceDrop = stage.label === "brief amplitude drops"
      && Math.floor(stageTime / 0.16) % 2 === 1
      && stageTime % 0.16 < 0.035
      ? 0.08
      : 1;
    const vibratoCents = 10 * Math.sin(2 * Math.PI * 5.2 * index / SAMPLE_RATE);
    phase += 2 * Math.PI * fundamentalHz * 2 ** (vibratoCents / 1_200) / SAMPLE_RATE;
    const fundamentalGain = stage.fundamentalGain ?? 1;
    const secondGain = stage.secondGain ?? 0.42;
    const thirdGain = stage.thirdGain ?? 0.2;
    const unitRms = Math.sqrt(
      (fundamentalGain ** 2 + secondGain ** 2 + thirdGain ** 2) / 2,
    );
    let value = voiceDrop * voiceRms / unitRms * (
      fundamentalGain * Math.sin(phase)
      + secondGain * Math.sin(2 * phase + 0.37)
      + thirdGain * Math.sin(3 * phase + 1.13)
    );
    if (stage.noiseSnrDb !== undefined) {
      const noiseRms = voiceRms / 10 ** (stage.noiseSnrDb / 20);
      value += noise() * Math.sqrt(3) * noiseRms;
    }
    if (stage.interferingFrequencyHz !== undefined && stage.interferingSnrDb !== undefined) {
      const interferenceRms = voiceRms / 10 ** (stage.interferingSnrDb / 20);
      value += Math.sqrt(2) * interferenceRms * Math.sin(
        2 * Math.PI * stage.interferingFrequencyHz * stageTime + 0.91,
      );
    }
    if (stage.impulseAmplitude !== undefined) {
      const impulsePosition = stageSample % Math.round(0.137 * SAMPLE_RATE);
      if (impulsePosition < Math.round(0.0025 * SAMPLE_RATE)) {
        const progress = impulsePosition / Math.round(0.0025 * SAMPLE_RATE);
        value += stage.impulseAmplitude * Math.sin(Math.PI * progress) * (noise() >= 0 ? 1 : -1);
      }
    }
    samples[index] = Math.max(-1, Math.min(1, value));
  }
  return { samples, stageAtSample };
}

function windowAt(
  samples: Float32Array,
  startSample: number,
  processCount: number,
): NoteInputWindow {
  const endSample = startSample + WINDOW_SAMPLES;
  return {
    samples: samples.slice(startSample, endSample),
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
  };
}

interface PitchAuthorityViolation {
  readonly seed: number;
  readonly snrDb: number;
  readonly endSample: number;
  readonly selectedFrequencyHz: number | null;
  readonly selectedMidi: number | null;
  readonly selectedCentsFromTarget: number | null;
  readonly rawFrequencyHz: number | null;
  readonly selectedConfidence: number;
  readonly selectedYinValue: number | null;
  readonly rawConfidence: number | null;
  readonly trackingDecision: VocalObservation["pitchTrackingDecision"];
}

function authorityViolations(
  samples: Float32Array,
  seed: number,
  snrDb: number,
  maximumDistanceCents = 20,
): PitchAuthorityViolation[] {
  const violations: PitchAuthorityViolation[] = [];
  const engine = new NoteInputEngine();
  for (
    let startSample = 0, processCount = 1;
    startSample + WINDOW_SAMPLES <= samples.length;
    startSample += HOP_SAMPLES, processCount += 1
  ) {
    const observation = engine.process(
      windowAt(samples, startSample, processCount),
    ).observation;
    if (
      observation.observationKind !== "voiced"
      || (
        observation.midiFloat !== null
        && Math.abs((observation.midiFloat - C3_MIDI) * 100)
          <= maximumDistanceCents
      )
    ) continue;
    violations.push(Object.freeze({
      seed,
      snrDb,
      endSample: observation.endSample,
      selectedFrequencyHz: observation.frequencyHz,
      selectedMidi: observation.nearestMidi,
      selectedCentsFromTarget: observation.midiFloat === null
        ? null
        : (observation.midiFloat - C3_MIDI) * 100,
      rawFrequencyHz: observation.pitchCandidate?.rawCandidate?.frequencyHz ?? null,
      selectedConfidence: observation.confidence,
      selectedYinValue: observation.yinValue,
      rawConfidence: observation.pitchCandidate?.rawCandidate?.confidence ?? null,
      trackingDecision: observation.pitchTrackingDecision,
    }));
  }
  return violations;
}

describe("continuous vocal pitch under changing interference", () => {
  it("does not give isolated physically incoherent candidates musical note authority", () => {
    const fixture = adversarialC3();
    const engine = new NoteInputEngine();
    const observations: Array<Readonly<VocalObservation> & { stage: string }> = [];
    for (
      let startSample = 0, processCount = 1;
      startSample + WINDOW_SAMPLES <= fixture.samples.length;
      startSample += HOP_SAMPLES, processCount += 1
    ) {
      const observation = engine.process(
        windowAt(fixture.samples, startSample, processCount),
      ).observation;
      observations.push(Object.freeze({
        ...observation,
        stage: fixture.stageAtSample(observation.endSample - 1),
      }));
    }

    const wrong = observations.filter((observation) => (
      observation.observationKind === "voiced"
      && observation.nearestMidi !== C3_MIDI
    ));
    expect(wrong.map((observation) => ({
      stage: observation.stage,
      endSample: observation.endSample,
      frequencyHz: observation.frequencyHz,
      nearestMidi: observation.nearestMidi,
      centsFromNearest: observation.centsFromNearest,
      confidence: observation.confidence,
      periodicity: observation.periodicity,
      reason: observation.reason,
    }))).toEqual([]);
  }, 60_000);

  it("never grants an octave-down family authority across a seeded +10 dB noise matrix", () => {
    const contradictions = SEEDED_NOISE_MATRIX.flatMap((seed) =>
      authorityViolations(seededC3(seed), seed, 10, 600));

    expect(contradictions).toEqual([]);
  }, 150_000);

  it("accepts a persistent noisy octave-down change instead of making C3 sticky", () => {
    for (const snrDb of [10, 6, 3]) {
      for (const seed of [1, 6, 20, 40]) {
        const c3 = seededC3(seed, snrDb, 1);
        const c2 = seededVoice(36, seed ^ 0x43_32, snrDb, 1.4);
        const samples = concatenateSamples(c3, c2);
        const engine = new NoteInputEngine();
        const tail: VocalObservation[] = [];
        for (
          let startSample = 0, processCount = 1;
          startSample + WINDOW_SAMPLES <= samples.length;
          startSample += HOP_SAMPLES, processCount += 1
        ) {
          const observation = engine.process(
            windowAt(samples, startSample, processCount),
          ).observation;
          if (observation.endSample > samples.length - 10 * HOP_SAMPLES) {
            tail.push(observation);
          }
        }
        expect(tail, `SNR ${snrDb}, seed ${seed}`).toHaveLength(10);
        const acceptedC2 = tail.filter((observation) => (
          observation.observationKind === "voiced"
          && observation.nearestMidi === 36
          && observation.midiFloat !== null
          && Math.abs((observation.midiFloat - 36) * 100) <= 50
        ));
        const staleC3 = tail.filter((observation) => (
          observation.observationKind === "voiced"
          && observation.nearestMidi === C3_MIDI
        ));
        const tailDiagnostic = JSON.stringify(tail.map((observation) => ({
          kind: observation.observationKind,
          midi: observation.nearestMidi,
          midiFloat: observation.midiFloat,
          decision: observation.pitchTrackingDecision,
        })));
        expect(
          acceptedC2.length,
          `SNR ${snrDb}, seed ${seed}: ${tailDiagnostic}`,
        ).toBeGreaterThanOrEqual(9);
        expect(
          staleC3,
          `SNR ${snrDb}, seed ${seed}: ${tailDiagnostic}`,
        ).toEqual([]);
      }
    }
  }, 90_000);
});
