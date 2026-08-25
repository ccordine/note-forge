import { describe, expect, it } from "vitest";

import { midiToFrequency } from "@noteforge/pitch-engine";
import { AnalysisWindowNormalizer } from "../apps/web/src/audio/analysis-window-normalizer";
import {
  NoteInputEngine,
  type NoteInputWindow,
} from "../apps/web/src/audio/note-input";
import { analysisWindowSizes } from "../apps/web/src/audio/microphone";
import { generateSyntheticSignal } from "../packages/pitch-engine/test/synthetic-signals";

const STANDARD_HIGH_RATES = [88_200, 96_000, 176_400, 192_000] as const;
const STANDARD_CAPTURE_RATES = [44_100, 48_000, ...STANDARD_HIGH_RATES] as const;
const ADVERSARIAL_HIGH_RATES = [96_000, 192_000] as const;
const PUBLIC_HIGH_RATE_CASES = [
  48_001,
  50_000,
  88_200,
  96_000,
  100_000,
  176_400,
  192_000,
  384_000,
  705_600,
  768_000,
] as const;
const WINDOW_SIZE_AT_48_KHZ = 4_096;

function capture(samples: Float32Array, sampleRate: number): NoteInputWindow {
  return {
    samples,
    sampleRate,
    startSample: 0,
    endSample: samples.length,
    capturedAt: samples.length / (2 * sampleRate),
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    processCount: 1,
    processedSampleCount: samples.length,
    discontinuity: true,
  };
}

function tone(
  sampleRate: number,
  frequencyHz: number,
  amplitude = 0.3,
  phaseRadians = 0.37,
): Float32Array {
  const sampleCount = analysisWindowSizes(sampleRate, WINDOW_SIZE_AT_48_KHZ).windowSize;
  return generateSyntheticSignal({
    sampleRate,
    durationSeconds: sampleCount / sampleRate,
    frequencyHz,
    amplitude,
    phaseRadians,
  });
}

function mix(...signals: readonly Float32Array[]): Float32Array {
  return Float32Array.from(signals[0] ?? [], (_, index) =>
    signals.reduce((sum, signal) => sum + signal[index]!, 0));
}

function centsError(actualHz: number | null, expectedHz: number): number | null {
  return actualHz === null ? null : 1_200 * Math.log2(actualHz / expectedHz);
}

describe("high-rate analysis anti-aliasing", () => {
  it("uses a bounded half-rate cascade for every supported high-rate family", () => {
    const expected = [44_100, 48_000, 44_100, 48_000] as const;
    const results = STANDARD_HIGH_RATES.map((sampleRate) => {
      const samples = tone(sampleRate, 220);
      const normalizer = new AnalysisWindowNormalizer();
      const first = normalizer.normalize({ samples, sampleRate });
      const second = normalizer.normalize({ samples, sampleRate });
      return { first, second };
    });

    expect(results.map(({ first }) => first.sampleRate)).toEqual(expected);
    expect(results.map(({ first }) => first.samples.length))
      .toEqual([4_096, 4_096, 4_096, 4_096]);
    expect(results.every(({ first, second }) => first === second)).toBe(true);
    expect(results.every(({ first, second }) => first.samples === second.samples)).toBe(true);
  });

  it("normalizes the complete public high-rate contract without a fallback decimator", () => {
    const outcomes = PUBLIC_HIGH_RATE_CASES.map((sampleRate) => {
      const samples = tone(sampleRate, midiToFrequency(48));
      const result = new NoteInputEngine().process(capture(samples, sampleRate));
      return { sampleRate, result };
    });

    expect(outcomes.flatMap(({ sampleRate, result }) => {
      const error = centsError(result.observation.frequencyHz, midiToFrequency(48));
      if (!result.observation.voiced || error === null || Math.abs(error) > 5) {
        return [`${sampleRate} Hz: ${result.observation.reason}, ${String(error)} cents`];
      }
      if (
        result.configuration.analysisSampleRate <= 24_000
        || result.configuration.analysisSampleRate > 48_000
      ) {
        return [`${sampleRate} Hz: invalid analysis rate ${result.configuration.analysisSampleRate}`];
      }
      return [];
    })).toEqual([]);
  });

  it("leaves undersized high-rate windows to the detector's ordinary evidence model", () => {
    const samples = new Float32Array(16).fill(0.2);
    const frame = new NoteInputEngine().process(capture(samples, 768_000)).observation;

    expect(frame.voiced).toBe(false);
    expect(frame.frequencyHz).toBeNull();
    expect(frame.nearestMidi).toBeNull();
    expect(["insufficient-samples", "below-rms-threshold"]).toContain(frame.reason);
  });

  it("does not fold near-Nyquist or repeated-image tones into the vocal band", () => {
    const aliasTargets = [55, midiToFrequency(48), 440, 1_200] as const;
    const trials = ADVERSARIAL_HIGH_RATES.flatMap((sampleRate) => {
      const analysisRate = sampleRate === 96_000 ? 48_000 : 48_000;
      const images = sampleRate === 96_000 ? [analysisRate] : [analysisRate, 96_000];
      return images.flatMap((imageHz) => aliasTargets.flatMap((aliasHz, index) =>
        [imageHz - aliasHz, imageHz + aliasHz]
          .filter((frequencyHz) => frequencyHz > 0 && frequencyHz < sampleRate / 2)
          .map((frequencyHz) => ({ sampleRate, frequencyHz, aliasHz, index }))));
    });
    const outcomes = trials.map((trial) => {
      const frame = new NoteInputEngine().process(capture(
        tone(trial.sampleRate, trial.frequencyHz, 0.45, trial.index * 0.43 + 0.17),
        trial.sampleRate,
      )).observation;
      return { ...trial, frame };
    });

    expect(outcomes.flatMap(({ sampleRate, frequencyHz, aliasHz, frame }) =>
      frame.voiced || frame.frequencyHz !== null
        ? [`${sampleRate} Hz source ${frequencyHz.toFixed(3)} aliased to ${aliasHz.toFixed(3)}: ${String(frame.frequencyHz)} Hz (${frame.reason}), rms=${String(frame.rms)}, confidence=${String(frame.confidence)}`]
        : [])).toEqual([]);
  });

  it("rejects mixtures of high-frequency image tones without inventing a note", () => {
    const outcomes = ADVERSARIAL_HIGH_RATES.map((sampleRate) => {
      const imageHz = sampleRate === 96_000 ? 48_000 : 96_000;
      const samples = mix(
        tone(sampleRate, imageHz - 73.42, 0.2, 0.13),
        tone(sampleRate, imageHz - 261.63, 0.18, 1.19),
        tone(sampleRate, imageHz - 880, 0.16, 2.03),
      );
      const frame = new NoteInputEngine().process(capture(samples, sampleRate)).observation;
      return { sampleRate, frame };
    });

    expect(outcomes.flatMap(({ sampleRate, frame }) => frame.voiced
      ? [`${sampleRate} Hz: invented ${String(frame.frequencyHz)} Hz (${frame.reason})`]
      : [])).toEqual([]);
  });

  it("preserves an arbitrarily quiet real fundamental beneath loud out-of-band energy", () => {
    const expectedHz = midiToFrequency(48);
    const outcomes = ADVERSARIAL_HIGH_RATES.map((sampleRate) => {
      const imageHz = sampleRate === 96_000 ? 48_000 : 96_000;
      const samples = mix(
        tone(sampleRate, expectedHz, 10 ** (-126 / 20), 0.71),
        tone(sampleRate, imageHz - 440, 0.45, 1.27),
      );
      const frame = new NoteInputEngine().process(capture(samples, sampleRate)).observation;
      return { sampleRate, frame, errorCents: centsError(frame.frequencyHz, expectedHz) };
    });

    expect(outcomes.flatMap(({ sampleRate, frame, errorCents }) =>
      !frame.voiced || errorCents === null || Math.abs(errorCents) > 5
        ? [`${sampleRate} Hz: ${frame.reason}, ${String(frame.frequencyHz)} Hz, ${String(errorCents)} cents, rms=${String(frame.rms)}, candidate=${JSON.stringify(frame.rawCandidate)}`]
        : [])).toEqual([]);
  });

  it("keeps quiet detector boundaries and representative notes at every standard rate", () => {
    const expectedFrequencies = [45, midiToFrequency(48), 440, 1_200] as const;
    const outcomes = STANDARD_CAPTURE_RATES.flatMap((sampleRate) =>
      expectedFrequencies.map((expectedHz, index) => {
        const frame = new NoteInputEngine().process(capture(
          tone(sampleRate, expectedHz, 10 ** (-126 / 20), index * 0.47 + 0.11),
          sampleRate,
        )).observation;
        return { sampleRate, expectedHz, frame, errorCents: centsError(frame.frequencyHz, expectedHz) };
      }));

    expect(outcomes.flatMap(({ sampleRate, expectedHz, frame, errorCents }) =>
      !frame.voiced || errorCents === null || Math.abs(errorCents) > 5
        ? [`${sampleRate} Hz / ${expectedHz} Hz: ${frame.reason}, ${String(errorCents)} cents`]
        : [])).toEqual([]);
  });

  it("reports steady anti-alias cost without imposing a host-dependent deadline", () => {
    const stats = [96_000, 192_000, 768_000].map((sampleRate) => {
      const samples = tone(sampleRate, midiToFrequency(48));
      const normalizer = new AnalysisWindowNormalizer();
      const first = normalizer.normalize({ samples, sampleRate });
      const durations: number[] = [];
      for (let index = 0; index < 32; index += 1) {
        const startedAt = performance.now();
        const current = normalizer.normalize({ samples, sampleRate });
        durations.push(performance.now() - startedAt);
        expect(current).toBe(first);
        expect(current.samples).toBe(first.samples);
      }
      durations.sort((left, right) => left - right);
      return {
        sampleRate,
        medianMs: Number(durations[15]!.toFixed(3)),
        p95Ms: Number(durations[30]!.toFixed(3)),
        maximumMs: Number(durations.at(-1)!.toFixed(3)),
      };
    });

    console.info("AnalysisWindowNormalizer steady timing", stats);
    expect(stats.every(({ medianMs, p95Ms, maximumMs }) =>
      Number.isFinite(medianMs)
      && Number.isFinite(p95Ms)
      && Number.isFinite(maximumMs)
      && medianMs >= 0
      && p95Ms >= medianMs
      && maximumMs >= p95Ms)).toBe(true);
  });
});
