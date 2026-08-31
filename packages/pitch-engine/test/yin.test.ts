import { describe, expect, it } from "vitest";

import {
  detectPitch,
  frequencyToMidi,
  midiToFrequency,
  YIN_DETECTOR_DEFAULTS,
} from "../src";
import {
  centsError,
  frequencyAtCents,
  generateSyntheticSignal,
  linearFadeEnvelope,
  midiFrequency,
} from "./synthetic-signals";

const SAMPLE_RATE = 48_000;
const BASE_OPTIONS = {
  sampleRate: SAMPLE_RATE,
  minFrequency: 60,
  maxFrequency: 1_200,
  analysisWindowSize: 2_048,
} as const;

function detectFrequency(frequencyHz: number) {
  const samples = generateSyntheticSignal({
    sampleRate: SAMPLE_RATE,
    durationSeconds: 0.1,
    frequencyHz,
    amplitude: 0.4,
  });
  return detectPitch(samples, BASE_OPTIONS);
}

describe("pitch conversion", () => {
  it("round-trips continuous MIDI values without quantizing", () => {
    for (const midi of [36, 57.25, 69, 72.5, 84]) {
      expect(frequencyToMidi(midiToFrequency(midi))).toBeCloseTo(midi, 10);
    }
  });
});

describe("YIN pitch detection", () => {
  it("uses the canonical full-depth, zero-floor detector policy for direct callers", () => {
    const cases = [
      { midi: 30, amplitude: 0.2 },
      { midi: 48, amplitude: 0.001 },
    ] as const;
    const frames = cases.map(({ midi, amplitude }) => detectPitch(
      generateSyntheticSignal({
        sampleRate: SAMPLE_RATE,
        durationSeconds: 4_096 / SAMPLE_RATE,
        frequencyHz: midiToFrequency(midi),
        amplitude,
        harmonics: [
          { multiple: 2, amplitude: 0.47 },
          { multiple: 3, amplitude: 0.23 },
        ],
      }),
      { sampleRate: SAMPLE_RATE },
    ));

    expect(YIN_DETECTOR_DEFAULTS).toMatchObject({
      minFrequency: 45,
      maxFrequency: 1_200,
      yinThreshold: 0.08,
      minConfidence: 0.55,
      rmsThreshold: 0,
    });
    expect(frames.map((frame) => frame.nearestMidi)).toEqual([30, 48]);
    expect(frames.every((frame) => frame.reason === "detected")).toBe(true);
  });

  it("uses yinThreshold for candidate search without overriding minConfidence admission", () => {
    const frame = detectPitch(generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 4_096 / SAMPLE_RATE,
      frequencyHz: midiToFrequency(48),
      amplitude: 0.02,
      harmonics: [
        { multiple: 2, amplitude: 0.3 },
        { multiple: 3, amplitude: 0.1 },
      ],
      noiseAmplitude: 0.013,
      noiseSeed: 12_345,
    }), {
      sampleRate: SAMPLE_RATE,
      minFrequency: 45,
      maxFrequency: 1_200,
      yinThreshold: 0.18,
      minConfidence: 0.55,
      rmsThreshold: 0,
    });

    expect(frame.confidence).toBeGreaterThan(0.8);
    expect(frame.confidence).toBeLessThan(0.82);
    expect(frame).toMatchObject({ reason: "detected", voiced: true, nearestMidi: 48 });
  });

  it("tracks every semitone across the intended range with no octave errors", () => {
    const notes = Array.from({ length: 51 }, (_unused, index) => 36 + index);
    let octaveErrors = 0;
    let worstErrorCents = 0;

    for (const midi of notes) {
      const expectedHz = midiFrequency(midi);
      const frame = detectFrequency(expectedHz);
      const errorCents = Math.abs(
        centsError(frame.frequencyHz ?? Number.NaN, expectedHz),
      );

      expect(frame.reason).toBe("detected");
      expect(frame.voiced).toBe(true);
      expect(frame.frequencyHz).not.toBeNull();
      expect(errorCents).toBeLessThan(1);
      expect(frame.midiFloat).toBeCloseTo(midi, 2);
      expect(frame.nearestMidi).toBe(midi);
      expect(frame.confidence).toBeGreaterThan(0.95);

      worstErrorCents = Math.max(worstErrorCents, errorCents);
      if (Math.abs((frame.nearestMidi ?? midi) - midi) >= 12) {
        octaveErrors += 1;
      }
    }

    expect(octaveErrors / notes.length).toBe(0);
    expect(worstErrorCents).toBeLessThan(1);
  });

  it.each([-50, -25, -10, 10, 25, 50])(
    "preserves a %+i-cent detuning as a continuous coordinate",
    (detuningCents) => {
      const expectedHz = frequencyAtCents(220, detuningCents);
      const frame = detectFrequency(expectedHz);

      expect(frame.voiced).toBe(true);
      expect(
        Math.abs(centsError(frame.frequencyHz as number, expectedHz)),
      ).toBeLessThan(0.75);
      expect(100 * ((frame.midiFloat as number) - 57)).toBeCloseTo(
        detuningCents,
        1,
      );
      expect(frame.midiFloat).not.toBe(Math.round(frame.midiFloat as number));
    },
  );

  it.each([60, 60.2, 1_190, 1_200])(
    "interpolates %.1f Hz near a configured search boundary",
    (expectedHz) => {
      const frame = detectFrequency(expectedHz);

      expect(frame.reason).toBe("detected");
      expect(
        Math.abs(centsError(frame.frequencyHz as number, expectedHz)),
        `${expectedHz} Hz boundary error`,
      )
        .toBeLessThan(1);
    },
  );

  it("tracks vibrato over successive analysis windows", () => {
    const centerHz = 220;
    const depthCents = 28;
    const rateHz = 5;
    const samples = generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 0.42,
      frequencyHz: centerHz,
      amplitude: 0.35,
      frequencyAtTime: (timeSeconds) =>
        frequencyAtCents(
          centerHz,
          depthCents * Math.sin(2 * Math.PI * rateHz * timeSeconds),
        ),
    });
    const windowLength = 2_048;
    const hop = 720;
    const detectedMidi: number[] = [];

    for (
      let start = 0;
      start + windowLength <= samples.length;
      start += hop
    ) {
      const frame = detectPitch(samples.slice(start, start + windowLength), {
        sampleRate: SAMPLE_RATE,
        minFrequency: 140,
        maxFrequency: 320,
        analysisWindowSize: 1_024,
        timeSeconds: start / SAMPLE_RATE,
      });
      expect(frame.voiced).toBe(true);
      detectedMidi.push(frame.midiFloat as number);
    }

    const centerMidi = frequencyToMidi(centerHz);
    const offsets = detectedMidi.map((midi) => 100 * (midi - centerMidi));
    expect(Math.max(...offsets)).toBeGreaterThan(15);
    expect(Math.min(...offsets)).toBeLessThan(-15);
    expect(
      Math.abs(offsets.reduce((sum, value) => sum + value, 0) / offsets.length),
    )
      .toBeLessThan(7);
  });

  it("rejects octave distraction from harmonics while amplitude changes", () => {
    const expectedHz = 110;
    const samples = generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 0.14,
      frequencyHz: expectedHz,
      amplitude: 0.24,
      amplitudeEnvelope: linearFadeEnvelope(0.3, 1),
      harmonics: [
        { multiple: 2, amplitude: 1.4, phaseRadians: 0.3 },
        { multiple: 3, amplitude: 0.8, phaseRadians: 1.1 },
        { multiple: 4, amplitude: 0.35, phaseRadians: 0.7 },
      ],
      noiseAmplitude: 0.008,
      noiseSeed: 42,
    });
    const frame = detectPitch(samples, {
      ...BASE_OPTIONS,
      minFrequency: 70,
      maxFrequency: 500,
    });

    expect(frame.reason).toBe("detected");
    expect(frame.frequencyHz).not.toBeNull();
    expect(Math.abs(centsError(frame.frequencyHz as number, expectedHz)))
      .toBeLessThan(3);
    expect(frame.rms).toBeGreaterThan(0.05);
  });

  it.each([
    { fundamental: 0.2, second: 1, third: 0.1, fourth: 0.4 },
  ])(
    "retains C3 identity when the second harmonic dominates ($fundamental fundamental)",
    ({ fundamental, second, third, fourth }) => {
      const expectedHz = midiFrequency(48);
      const samples = generateSyntheticSignal({
        sampleRate: SAMPLE_RATE,
        durationSeconds: 4_096 / SAMPLE_RATE,
        frequencyHz: expectedHz,
        amplitude: 0.24,
        fundamentalAmplitude: fundamental,
        harmonics: [
          { multiple: 2, amplitude: second, phaseRadians: 0.7 },
          { multiple: 3, amplitude: third, phaseRadians: 1.3 },
          { multiple: 4, amplitude: fourth, phaseRadians: 0.35 },
        ],
      });
      const frame = detectPitch(samples, {
        ...BASE_OPTIONS,
        minFrequency: 45,
        analysisWindowSize: 3_025,
      });

      expect(frame.reason).toBe("detected");
      expect(frame.nearestMidi).toBe(48);
      expect(Math.abs(centsError(frame.frequencyHz!, expectedHz))).toBeLessThan(3);
    },
  );

  it.each([30, 34, 39])(
    "retains low MIDI %i with a weak fundamental and dominant second harmonic",
    (midi) => {
      const expectedHz = midiFrequency(midi);
      for (const phaseRadians of [0, 0.61, 1.37, 2.53]) {
        const samples = generateSyntheticSignal({
          sampleRate: SAMPLE_RATE,
          durationSeconds: 4_096 / SAMPLE_RATE,
          frequencyHz: expectedHz,
          amplitude: 0.12,
          fundamentalAmplitude: 0.08,
          phaseRadians,
          harmonics: [
            { multiple: 2, amplitude: 1, phaseRadians: 2 * phaseRadians + 0.23 },
            { multiple: 3, amplitude: 0.24, phaseRadians: 3 * phaseRadians + 0.91 },
            { multiple: 4, amplitude: 0.12, phaseRadians: 4 * phaseRadians + 1.43 },
          ],
        });
        const frame = detectPitch(samples, {
          ...BASE_OPTIONS,
          minFrequency: 45,
        });

        expect(frame.reason, `phase ${phaseRadians}`).toBe("detected");
        expect(frame.nearestMidi, `phase ${phaseRadians}`).toBe(midi);
        expect(
          Math.abs(centsError(frame.frequencyHz!, expectedHz)),
          `phase ${phaseRadians}`,
        ).toBeLessThan(3);
      }
    },
  );

  it.each([42, 46, 51])(
    "does not invent a sub-80 Hz octave beneath pure MIDI %i",
    (midi) => {
      const expectedHz = midiFrequency(midi);
      for (const phaseRadians of [0, 0.61, 1.37, 2.53]) {
        const frame = detectPitch(generateSyntheticSignal({
          sampleRate: SAMPLE_RATE,
          durationSeconds: 4_096 / SAMPLE_RATE,
          frequencyHz: expectedHz,
          amplitude: 0.24,
          phaseRadians,
        }), {
          ...BASE_OPTIONS,
          minFrequency: 45,
        });

        expect(frame.reason, `phase ${phaseRadians}`).toBe("detected");
        expect(frame.nearestMidi, `phase ${phaseRadians}`).toBe(midi);
        expect(
          Math.abs(centsError(frame.frequencyHz!, expectedHz)),
          `phase ${phaseRadians}`,
        ).toBeLessThan(1);
      }
    },
  );

  it.each([
    { targetHz: 100, mainsHz: 50, otherMainsHz: 120 },
    { targetHz: 120, mainsHz: 60, otherMainsHz: 50 },
  ])(
    "retains $targetHz Hz above $mainsHz Hz mains leakage and broadband noise",
    ({ targetHz, mainsHz, otherMainsHz }) => {
      for (const phaseRadians of [0, 0.61, 1.37, 2.53]) {
        const options = {
          sampleRate: SAMPLE_RATE,
          durationSeconds: 4_096 / SAMPLE_RATE,
        } as const;
        const target = generateSyntheticSignal({
          ...options,
          frequencyHz: targetHz,
          amplitude: 0.24,
          phaseRadians,
        });
        const mains = generateSyntheticSignal({
          ...options,
          frequencyHz: mainsHz,
          amplitude: 0.034,
          phaseRadians: phaseRadians * 0.73 + 0.2,
        });
        const otherMains = generateSyntheticSignal({
          ...options,
          frequencyHz: otherMainsHz,
          amplitude: 0.012,
          phaseRadians: phaseRadians * 1.31 + 0.8,
        });
        const noise = generateSyntheticSignal({
          ...options,
          frequencyHz: 440,
          amplitude: 0,
          noiseAmplitude: 0.004,
          noiseSeed: 0x59_49_4e ^ Math.round(phaseRadians * 1_000),
        });
        const samples = Float32Array.from(target, (sample, index) =>
          sample + mains[index]! + otherMains[index]! + noise[index]!);
        const frame = detectPitch(samples, {
          ...BASE_OPTIONS,
          minFrequency: 45,
        });

        expect(frame.reason, `phase ${phaseRadians}`).toBe("detected");
        expect(
          Math.abs(centsError(frame.frequencyHz!, targetHz)),
          `phase ${phaseRadians}`,
        ).toBeLessThan(20);
      }
    },
  );

  it("does not invent a lower octave beneath a pure high sine", () => {
    const expectedHz = midiFrequency(60);
    const frame = detectPitch(generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 4_096 / SAMPLE_RATE,
      frequencyHz: expectedHz,
      amplitude: 0.3,
    }), {
      ...BASE_OPTIONS,
      minFrequency: 45,
      analysisWindowSize: 3_025,
    });

    expect(frame.nearestMidi).toBe(60);
    expect(Math.abs(centsError(frame.frequencyHz!, expectedHz))).toBeLessThan(1);
  });

  it("retains target pitch through a substantial clean amplitude envelope", () => {
    const expectedHz = midiFrequency(60);
    const samples = generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 0.14,
      frequencyHz: expectedHz,
      amplitude: 0.5,
      amplitudeEnvelope: (_time, progress) =>
        0.08 + 0.92 * Math.sin(Math.PI * progress) ** 2,
    });
    const frame = detectPitch(samples, BASE_OPTIONS);

    expect(frame.voiced).toBe(true);
    expect(Math.abs(centsError(frame.frequencyHz as number, expectedHz)))
      .toBeLessThan(3);
  });

  it("does not report an old 614-sample D3 release prefix as current pitch", () => {
    const samples = new Float32Array(4_096);
    const frequencyHz = midiFrequency(50);
    for (let index = 0; index < 614; index += 1) {
      samples[index] = 0.1 * Math.sin(2 * Math.PI * frequencyHz * index / SAMPLE_RATE + 0.7);
    }

    const frame = detectPitch(samples, {
      sampleRate: SAMPLE_RATE,
      minFrequency: 45,
      maxFrequency: 1_200,
      analysisWindowSize: 2_048,
    });

    expect(frame).toMatchObject({
      reason: "below-confidence-threshold",
      voiced: false,
      frequencyHz: null,
      confidence: 0,
    });
    expect(frame.yinValue).not.toBeNull();
  });

  it("does not invent pitch from the mirrored 614-sample onset alone", () => {
    const samples = new Float32Array(4_096);
    const frequencyHz = midiFrequency(50);
    const onset = samples.length - 614;
    for (let index = onset; index < samples.length; index += 1) {
      samples[index] = 0.1 * Math.sin(
        2 * Math.PI * frequencyHz * (index - onset) / SAMPLE_RATE + 0.7,
      );
    }

    const frame = detectPitch(samples, {
      sampleRate: SAMPLE_RATE,
      minFrequency: 45,
      maxFrequency: 1_200,
      analysisWindowSize: 2_048,
    });

    expect(frame.voiced).toBe(false);
    expect(frame.frequencyHz).toBeNull();
  });

  it("accepts two genuinely repeating recent candidate periods", () => {
    const samples = new Float32Array(4_096);
    const integerPeriod = 327;
    const frequencyHz = SAMPLE_RATE / integerPeriod;
    const recentStart = samples.length - 2 * integerPeriod;
    for (let index = 0; index < samples.length; index += 1) {
      if (index >= 3_115 && index < recentStart) continue;
      samples[index] = 0.1 * Math.sin(2 * Math.PI * index / integerPeriod + 0.7);
    }

    const frame = detectPitch(samples, {
      sampleRate: SAMPLE_RATE,
      minFrequency: 45,
      maxFrequency: 1_200,
      analysisWindowSize: 2_048,
    });

    expect(frame).toMatchObject({ reason: "detected", voiced: true, nearestMidi: 50 });
    expect(Math.abs(centsError(frame.frequencyHz!, frequencyHz))).toBeLessThan(1);
    expect(frame.confidence).toBeGreaterThan(0.95);
  });

  it("keeps arbitrarily quiet full-window periodic evidence current", () => {
    const frequencyHz = midiFrequency(48);
    const frame = detectPitch(generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 4_096 / SAMPLE_RATE,
      frequencyHz,
      amplitude: 1e-7,
      harmonics: [
        { multiple: 2, amplitude: 0.47 },
        { multiple: 3, amplitude: 0.23 },
      ],
    }), { sampleRate: SAMPLE_RATE });

    expect(frame).toMatchObject({ reason: "detected", voiced: true, nearestMidi: 48 });
    expect(Math.abs(centsError(frame.frequencyHz!, frequencyHz))).toBeLessThan(1);
    expect(frame.rms).toBeGreaterThan(0);
  });

  it("returns direct stateless results when the pitch changes", () => {
    const detectMidi = (midi: number, timeSeconds: number) => detectPitch(
      generateSyntheticSignal({
        sampleRate: SAMPLE_RATE,
        durationSeconds: 0.1,
        frequencyHz: midiToFrequency(midi),
      }),
      { ...BASE_OPTIONS, timeSeconds },
    );

    const first = detectMidi(57, 1.25);
    const changed = detectMidi(58, 1.35);

    expect(first).toMatchObject({ reason: "detected", nearestMidi: 57, timeSeconds: 1.25 });
    expect(changed).toMatchObject({ reason: "detected", nearestMidi: 58, timeSeconds: 1.35 });
  });
});

describe("observable detection failures", () => {
  it("marks silence as below the RMS threshold", () => {
    const frame = detectPitch(new Float32Array(4_096), BASE_OPTIONS);

    expect(frame).toMatchObject({
      reason: "below-rms-threshold",
      voiced: false,
      frequencyHz: null,
      midiFloat: null,
      confidence: 0,
      rms: 0,
    });
  });

  it("reports an insufficient analysis buffer", () => {
    const samples = generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 0.01,
      frequencyHz: 220,
    });
    const frame = detectPitch(samples, BASE_OPTIONS);

    expect(frame.reason).toBe("insufficient-samples");
    expect(frame.voiced).toBe(false);
    expect(frame.rms).toBeGreaterThan(0);
  });

  it("reports deterministic noise as non-periodic without guessing a note", () => {
    const noise = generateSyntheticSignal({
      sampleRate: SAMPLE_RATE,
      durationSeconds: 0.1,
      frequencyHz: 220,
      amplitude: 0,
      noiseAmplitude: 0.25,
      noiseSeed: 8675309,
    });
    const frame = detectPitch(noise, {
      ...BASE_OPTIONS,
      yinThreshold: 0.1,
    });

    expect(frame.reason).toBe("no-periodic-candidate");
    expect(frame.voiced).toBe(false);
    expect(frame.frequencyHz).toBeNull();
    expect(frame.confidence).toBeGreaterThanOrEqual(0);
    expect(frame.yinValue).not.toBeNull();
  });

  it("reports invalid numeric samples explicitly", () => {
    const samples = new Float32Array(4_096);
    samples.fill(0.2);
    samples[100] = Number.NaN;
    const frame = detectPitch(samples, BASE_OPTIONS);

    expect(frame.reason).toBe("invalid-samples");
    expect(frame.voiced).toBe(false);
  });

  it("validates detector configuration before analysis", () => {
    expect(
      () =>
        detectPitch(new Float32Array(4_096), {
          sampleRate: 48_000,
          minFrequency: 500,
          maxFrequency: 100,
        }),
    ).toThrow(/minFrequency/);
    expect(
      () =>
        detectPitch(new Float32Array(4_096), {
          sampleRate: 48_000,
          yinThreshold: 2,
        }),
    ).toThrow(/yinThreshold/);
    expect(
      () => detectPitch(new Float32Array(4_096), {
        sampleRate: 48_000,
        currentEdgeSpanSamples: -1,
      }),
    ).toThrow(/currentEdgeSpanSamples/);
  });
});
