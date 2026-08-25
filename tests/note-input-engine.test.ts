import { describe, expect, it } from "vitest";
import {
  frequencyToMidi,
  midiToFrequency,
  type YinPitchFrame,
} from "@noteforge/pitch-engine";
import {
  NOTE_INPUT_DEFAULTS,
  NOTE_INPUT_SAMPLE_RATE_BOUNDS,
  NoteInputEngine,
  type NoteInputWindow,
  type VocalObservation,
} from "../apps/web/src/audio/note-input";
import { reduceLiveNote } from "../apps/web/src/audio/live-note";
import { analysisWindowSizes } from "../apps/web/src/audio/microphone";
import { generateSyntheticSignal } from "../packages/pitch-engine/test/synthetic-signals";

const REFERENCE_SAMPLE_RATE = 48_000;
const REFERENCE_WINDOW_SIZE = 4_096;
const REFERENCE_WINDOW_SECONDS = REFERENCE_WINDOW_SIZE / REFERENCE_SAMPLE_RATE;
const PRODUCTION_CAPTURE_SAMPLE_RATES = [
  44_100,
  48_000,
  88_200,
  96_000,
  176_400,
  192_000,
] as const;
const LOW_CAPTURE_SAMPLE_RATES = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000] as const;
const LOWEST_SUPPORTED_MIDI = Math.ceil(
  frequencyToMidi(NOTE_INPUT_DEFAULTS.minFrequency),
);
const HIGHEST_SUPPORTED_MIDI = Math.floor(
  frequencyToMidi(NOTE_INPUT_DEFAULTS.maxFrequency),
);

function amplitudeFromDbfs(dbfs: number): number {
  return 10 ** (dbfs / 20);
}

function harmonicWindow(
  midi: number,
  options: {
    sampleRate?: number;
    rmsScaleDbfs?: number;
    windowIndex?: number;
  } = {},
): Float32Array {
  const sampleRate = options.sampleRate ?? REFERENCE_SAMPLE_RATE;
  const windowIndex = options.windowIndex ?? 0;
  const captureSize = analysisWindowSizes(sampleRate, REFERENCE_WINDOW_SIZE).windowSize;
  return generateSyntheticSignal({
    sampleRate,
    durationSeconds: captureSize / sampleRate,
    frequencyHz: midiToFrequency(midi),
    amplitude: amplitudeFromDbfs(options.rmsScaleDbfs ?? -18),
    phaseRadians: windowIndex * 0.731,
    harmonics: [
      { multiple: 2, amplitude: 0.47, phaseRadians: 0.37 + windowIndex * 0.11 },
      { multiple: 3, amplitude: 0.23, phaseRadians: 1.13 + windowIndex * 0.07 },
      { multiple: 4, amplitude: 0.11, phaseRadians: 0.71 + windowIndex * 0.05 },
    ],
  });
}

function processHarmonic(
  engine: NoteInputEngine,
  midi: number,
  windowIndex: number,
  options: { sampleRate?: number; rmsScaleDbfs?: number } = {},
): Readonly<VocalObservation> {
  const sampleRate = options.sampleRate ?? REFERENCE_SAMPLE_RATE;
  const windowSeconds = analysisWindowSizes(
    sampleRate,
    REFERENCE_WINDOW_SIZE,
  ).windowSize / sampleRate;
  return engine.process(capturedWindow(
    harmonicWindow(midi, { ...options, windowIndex }),
    sampleRate,
    (windowIndex + 0.5) * windowSeconds,
  )).observation;
}

function capturedWindow(
  samples: Float32Array,
  sampleRate: number,
  requestedMidpointSeconds: number,
): NoteInputWindow {
  const minimumMidpoint = samples.length / (2 * sampleRate);
  const midpoint = Math.max(minimumMidpoint, requestedMidpointSeconds);
  const startSample = Math.max(
    0,
    Math.round(midpoint * sampleRate - samples.length / 2),
  );
  const endSample = startSample + samples.length;
  return {
    samples,
    sampleRate,
    startSample,
    endSample,
    capturedAt: (startSample + endSample) / (2 * sampleRate),
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    processCount: endSample,
    processedSampleCount: endSample,
    discontinuity: startSample === 0,
  };
}

function centsError(frame: Readonly<YinPitchFrame>, expectedMidi: number): number | null {
  return frame.midiFloat === null ? null : (frame.midiFloat - expectedMidi) * 100;
}

function frameFailure(
  frame: Readonly<YinPitchFrame>,
  expectedMidi: number,
  maximumErrorCents: number,
): string | null {
  const errorCents = centsError(frame, expectedMidi);
  if (!frame.voiced) return `${expectedMidi}: unvoiced (${frame.reason})`;
  if (frame.nearestMidi !== expectedMidi) {
    return `${expectedMidi}: detected ${String(frame.nearestMidi)} (${errorCents?.toFixed(2) ?? "no"} cents)`;
  }
  if (errorCents === null || Math.abs(errorCents) > maximumErrorCents) {
    return `${expectedMidi}: ${errorCents?.toFixed(2) ?? "no"} cents`;
  }
  return null;
}

describe("direct NoteInputEngine detection", () => {
  it("maps every supported semitone from F-sharp 1 through D6 on its first capture-sized PCM window at production rates", () => {
    const midis = Array.from(
      { length: HIGHEST_SUPPORTED_MIDI - LOWEST_SUPPORTED_MIDI + 1 },
      (_, index) => LOWEST_SUPPORTED_MIDI + index,
    );
    const trials = PRODUCTION_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      midis.map((midi) => ({ sampleRate, midi })));
    const results = trials.map(({ sampleRate, midi }, index) => {
      // A fresh engine for every trial proves there is no acquisition frame.
      const frame = processHarmonic(new NoteInputEngine(), midi, index, {
        sampleRate,
        rmsScaleDbfs: -108,
      });
      const failure = frameFailure(frame, midi, 2);
      return {
        sampleRate,
        midi,
        frame,
        failure: failure === null ? null : `${sampleRate} Hz / ${failure}`,
      };
    });

    expect({
      lowestMidi: midis[0],
      highestMidi: midis.at(-1),
      passed: results.filter((result) => result.failure === null).length,
      total: results.length,
      failures: results.flatMap((result) => result.failure ?? []),
    }).toEqual({
      lowestMidi: 30,
      highestMidi: 86,
      passed: 342,
      total: 342,
      failures: [],
    });
    expect(results.every(({ frame }) => frame.reason === "detected")).toBe(true);
  });

  it("never drops an eight-second voice-like sustain across overlapping production windows", () => {
    const hopSamples = Math.round(REFERENCE_SAMPLE_RATE * 0.02);
    const durationSeconds = 8.25;
    const cases = [
      {
        midi: LOWEST_SUPPORTED_MIDI,
        rmsScaleDbfs: -42,
        fundamentalAmplitude: 0.18,
        harmonics: [
          { multiple: 2, amplitude: 1, phaseRadians: 0.37 },
          { multiple: 3, amplitude: 0.28, phaseRadians: 1.13 },
          { multiple: 4, amplitude: 0.13, phaseRadians: 0.71 },
        ],
      },
      {
        midi: 48,
        rmsScaleDbfs: -60,
        fundamentalAmplitude: 1,
        harmonics: [
          { multiple: 2, amplitude: 0.47, phaseRadians: 0.37 },
          { multiple: 3, amplitude: 0.23, phaseRadians: 1.13 },
          { multiple: 4, amplitude: 0.11, phaseRadians: 0.71 },
        ],
      },
      {
        midi: 60,
        rmsScaleDbfs: -24,
        fundamentalAmplitude: 1,
        harmonics: [
          { multiple: 2, amplitude: 0.35, phaseRadians: 0.37 },
          { multiple: 3, amplitude: 0.16, phaseRadians: 1.13 },
        ],
      },
      {
        midi: HIGHEST_SUPPORTED_MIDI,
        rmsScaleDbfs: -24,
        fundamentalAmplitude: 1,
        harmonics: [
          { multiple: 2, amplitude: 0.2, phaseRadians: 0.37 },
          { multiple: 3, amplitude: 0.08, phaseRadians: 1.13 },
        ],
      },
    ] as const;

    const results = cases.map((fixture, fixtureIndex) => {
      const centerFrequency = midiToFrequency(fixture.midi);
      const signal = generateSyntheticSignal({
        sampleRate: REFERENCE_SAMPLE_RATE,
        durationSeconds,
        frequencyHz: centerFrequency,
        amplitude: amplitudeFromDbfs(fixture.rmsScaleDbfs),
        fundamentalAmplitude: fixture.fundamentalAmplitude,
        harmonics: fixture.harmonics,
        noiseAmplitude: amplitudeFromDbfs(fixture.rmsScaleDbfs - 34),
        noiseSeed: 0x53_55_53_54 ^ Math.imul(fixtureIndex + 1, 0x9e_37_79_b1),
        amplitudeEnvelope: (timeSeconds) =>
          0.72 + 0.2 * Math.sin(2 * Math.PI * 1.7 * timeSeconds)
            + 0.08 * Math.sin(2 * Math.PI * 3.1 * timeSeconds + 0.4),
        frequencyAtTime: (timeSeconds) => centerFrequency * 2 ** ((
          14 * Math.sin(2 * Math.PI * 5.1 * timeSeconds)
            + 3 * Math.sin(2 * Math.PI * 0.37 * timeSeconds)
        ) / 1_200),
      });
      const engine = new NoteInputEngine();
      let liveNote = null;
      const frames = [];
      for (
        let startSample = 0, index = 0;
        startSample + REFERENCE_WINDOW_SIZE <= signal.length;
        startSample += hopSamples, index += 1
      ) {
        const endSample = startSample + REFERENCE_WINDOW_SIZE;
        const frame = engine.process({
          samples: signal.slice(startSample, endSample),
          sampleRate: REFERENCE_SAMPLE_RATE,
          startSample,
          endSample,
          capturedAt: (startSample + endSample) / (2 * REFERENCE_SAMPLE_RATE),
          captureEpoch: 1,
          continuityEpoch: 0,
          graphGeneration: 0,
          processCount: index + 1,
          processedSampleCount: endSample,
          discontinuity: index === 0,
        }).observation;
        frames.push(frame);
        liveNote = reduceLiveNote(liveNote, frame);
      }
      return { fixture, frames, liveNote };
    });

    const failures = results.flatMap(({ fixture, frames }) => frames.flatMap((frame, index) => {
      const failure = frameFailure(frame, fixture.midi, 25);
      return failure === null ? [] : [`MIDI ${fixture.midi} frame ${index}: ${failure}`];
    }));
    expect(failures).toEqual([]);
    expect(results.every(({ frames }) => frames.length >= 400)).toBe(true);
    expect(results.map(({ fixture, liveNote }) => ({
      midi: fixture.midi,
      heldSamples: liveNote?.heldSamples,
      heldSeconds: liveNote?.heldSeconds,
    }))).toEqual(results.map(({ fixture, frames }) => ({
      midi: fixture.midi,
      heldSamples: (frames.length - 1) * hopSamples,
      heldSeconds: (frames.length - 1) * hopSamples / REFERENCE_SAMPLE_RATE,
    })));
    expect(results.every(({ liveNote }) => (liveNote?.heldSeconds ?? 0) > 8)).toBe(true);
  }, 90_000);

  it("detects the literal 45 Hz and 1,200 Hz configured boundaries at every production rate", () => {
    const frequencies = [
      NOTE_INPUT_DEFAULTS.minFrequency,
      NOTE_INPUT_DEFAULTS.maxFrequency,
    ] as const;
    const trials = PRODUCTION_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      frequencies.map((frequencyHz) => ({ sampleRate, frequencyHz })));
    const results = trials.map(({ sampleRate, frequencyHz }, index) => {
      const samples = harmonicWindow(frequencyToMidi(frequencyHz), {
        sampleRate,
        windowIndex: index,
      });
      const result = new NoteInputEngine().process(
        capturedWindow(samples, sampleRate, index + 1),
      );
      const measuredFrequency = result.observation.frequencyHz;
      const errorCents = measuredFrequency === null
        ? null
        : 1_200 * Math.log2(measuredFrequency / frequencyHz);
      return { sampleRate, frequencyHz, result, errorCents };
    });

    expect(results.flatMap(({ sampleRate, frequencyHz, result, errorCents }) => {
      if (!result.observation.voiced) {
        return [`${sampleRate} Hz / ${frequencyHz} Hz: unvoiced (${result.observation.reason})`];
      }
      if (errorCents === null || Math.abs(errorCents) > 2) {
        return [`${sampleRate} Hz / ${frequencyHz} Hz: ${errorCents?.toFixed(2) ?? "no"} cents`];
      }
      return [];
    })).toEqual([]);
    expect(results.every(({ result }) =>
      result.configuration.minFrequency === NOTE_INPUT_DEFAULTS.minFrequency
      && result.configuration.maxFrequency === NOTE_INPUT_DEFAULTS.maxFrequency))
      .toBe(true);
  });

  it("uses one normalized live hop for current-edge transport evidence", () => {
    const spans = PRODUCTION_CAPTURE_SAMPLE_RATES.map((sampleRate, index) =>
      new NoteInputEngine().process(capturedWindow(
        harmonicWindow(60, { sampleRate, windowIndex: index }),
        sampleRate,
        index + 1,
      )).configuration.currentEdgeSpanSamples);

    expect(NOTE_INPUT_DEFAULTS.currentEdgeSpanSamples).toBe(0);
    expect(spans).toEqual([882, 960, 882, 960, 882, 960]);
  });

  it("keeps both literal detector boundaries voiced and accurate at low Web Audio rates", () => {
    const frequencies = [
      NOTE_INPUT_DEFAULTS.minFrequency,
      NOTE_INPUT_DEFAULTS.maxFrequency,
    ] as const;
    const results = LOW_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      frequencies.flatMap((frequencyHz, index) => ["harmonic", "pure"].map((profile) => {
        const captureSize = analysisWindowSizes(sampleRate).windowSize;
        const samples = profile === "harmonic"
          ? harmonicWindow(frequencyToMidi(frequencyHz), {
              sampleRate,
              windowIndex: index,
            })
          : generateSyntheticSignal({
              sampleRate,
              durationSeconds: captureSize / sampleRate,
              frequencyHz,
              amplitude: 0.25,
              phaseRadians: index * 0.731,
            });
        const frame = new NoteInputEngine().process(
          capturedWindow(samples, sampleRate, index + 1),
        ).observation;
        const errorCents = frame.frequencyHz === null
          ? null
          : 1_200 * Math.log2(frame.frequencyHz / frequencyHz);
        return { sampleRate, frequencyHz, profile, frame, errorCents };
      })));

    expect(results.flatMap(({ sampleRate, frequencyHz, profile, frame, errorCents }) => {
      if (!frame.voiced) {
        return [`${sampleRate} Hz / ${frequencyHz} Hz / ${profile}: unvoiced (${frame.reason})`];
      }
      if (errorCents === null || Math.abs(errorCents) > 2) {
        return [`${sampleRate} Hz / ${frequencyHz} Hz / ${profile}: ${errorCents?.toFixed(2) ?? "no"} cents`];
      }
      return [];
    })).toEqual([]);
  });

  it("preserves every supported note identity at low Web Audio rates", () => {
    const midis = Array.from(
      { length: HIGHEST_SUPPORTED_MIDI - LOWEST_SUPPORTED_MIDI + 1 },
      (_, index) => LOWEST_SUPPORTED_MIDI + index,
    );
    const results = LOW_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      midis.map((midi, index) => {
        const frame = processHarmonic(new NoteInputEngine(), midi, index, { sampleRate });
        const failure = frameFailure(frame, midi, 15);
        return {
          sampleRate,
          midi,
          failure: failure === null ? null : `${sampleRate} Hz / ${failure}`,
        };
      }));

    expect({
      passed: results.filter(({ failure }) => failure === null).length,
      total: results.length,
      failures: results.flatMap(({ failure }) => failure ?? []),
    }).toEqual({ passed: 399, total: 399, failures: [] });
  });

  it("exposes every raw candidate immediately while requiring persistent remote pitch evidence", () => {
    const engine = new NoteInputEngine();
    const sequence = [48, 49, 67, 36, 83, 55, 60, 47, 72] as const;
    const framesPerPitch = 4;
    const frames = sequence.flatMap((midi, sequenceIndex) =>
      Array.from({ length: framesPerPitch }, (_unused, repeat) =>
        processHarmonic(engine, midi, sequenceIndex * framesPerPitch + repeat)));
    const pairs = sequence.map((_midi, index) =>
      frames.slice(index * framesPerPitch, index * framesPerPitch + framesPerPitch));

    expect(frames.map((frame) => frame.pitchCandidate?.nearestMidi)).toEqual(
      sequence.flatMap((midi) => Array.from({ length: framesPerPitch }, () => midi)),
    );
    frames.forEach((frame, index) => {
      expect(frame.timeSeconds).toBeCloseTo(
        (index + 0.5) * REFERENCE_WINDOW_SECONDS,
        12,
      );
    });
    expect(pairs[0]!.map((frame) => frame.nearestMidi)).toEqual([48, 48, 48, 48]);
    pairs.slice(1).forEach((pair, index) => {
      const expectedMidi = sequence[index + 1]!;
      pair.slice(0, 3).forEach((frame) => {
        expect(frame).toMatchObject({
          voiced: false,
          nearestMidi: null,
          reason: "temporally-ambiguous",
          pitchTrackingDecision: "pending-transition",
        });
        expect(frame.pitchCandidate).toMatchObject({
          voiced: true,
          nearestMidi: expectedMidi,
          reason: "detected",
        });
      });
      expect(pair[3]).toMatchObject({
        voiced: true,
        nearestMidi: expectedMidi,
        reason: "detected",
        pitchTrackingDecision: "accepted-confirmed-transition",
      });
      expect(frameFailure(pair[3]!, expectedMidi, 2)).toBeNull();
    });
  });

  it("freezes each canonical live result so consumers cannot rewrite shared evidence", () => {
    const result = new NoteInputEngine().process(capturedWindow(
      harmonicWindow(48),
      REFERENCE_SAMPLE_RATE,
      1,
    ));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(() => {
      (result.observation as YinPitchFrame).nearestMidi = 72;
    }).toThrow(TypeError);
    expect(() => {
      (result.configuration as { minFrequency: number }).minFrequency = 440;
    }).toThrow(TypeError);
    expect(result.observation.nearestMidi).toBe(48);
    expect(result.configuration.minFrequency).toBe(NOTE_INPUT_DEFAULTS.minFrequency);
  });

  it("preserves exact capture authority and classifies voice, silence, and invalid evidence", () => {
    const voicedWindow = capturedWindow(harmonicWindow(60), REFERENCE_SAMPLE_RATE, 1);
    const voiced = new NoteInputEngine().process({
      ...voicedWindow,
      captureEpoch: 9,
      continuityEpoch: 4,
      graphGeneration: 2,
      processCount: 777,
      discontinuity: true,
    }).observation;
    const silence = new NoteInputEngine().process(capturedWindow(
      new Float32Array(REFERENCE_WINDOW_SIZE),
      REFERENCE_SAMPLE_RATE,
      2,
    )).observation;
    const invalidSamples = new Float32Array(REFERENCE_WINDOW_SIZE);
    invalidSamples[100] = Number.NaN;
    const uncertain = new NoteInputEngine().process(capturedWindow(
      invalidSamples,
      REFERENCE_SAMPLE_RATE,
      3,
    )).observation;

    expect(voiced).toMatchObject({
      observationKind: "voiced",
      voiced: true,
      sampleRate: REFERENCE_SAMPLE_RATE,
      startSample: voicedWindow.startSample,
      endSample: voicedWindow.endSample,
      processedSampleCount: voicedWindow.endSample,
      captureEpoch: 9,
      continuityEpoch: 4,
      graphGeneration: 2,
      workletProcessCount: 777,
      discontinuity: true,
    });
    expect(voiced.periodicity).toBeGreaterThan(0.5);
    expect(silence).toMatchObject({
      observationKind: "unvoiced",
      voiced: false,
      reason: "below-rms-threshold",
      frequencyHz: null,
      midiFloat: null,
    });
    expect(uncertain).toMatchObject({
      observationKind: "uncertain",
      voiced: false,
      reason: "invalid-samples",
      frequencyHz: null,
      midiFloat: null,
    });
  });

  it("rejects capture windows whose sample identity or midpoint is fabricated", () => {
    const valid = capturedWindow(harmonicWindow(60), REFERENCE_SAMPLE_RATE, 1);
    expect(() => new NoteInputEngine().process({
      ...valid,
      endSample: valid.endSample + 1,
    })).toThrow(/coordinates/);
    expect(() => new NoteInputEngine().process({
      ...valid,
      processedSampleCount: valid.processedSampleCount + 1,
    })).toThrow(/processedSampleCount/);
    expect(() => new NoteInputEngine().process({
      ...valid,
      capturedAt: valid.capturedAt + 0.001,
    })).toThrow(/midpoint/);
    expect(() => new NoteInputEngine().process(capturedWindow(
      new Float32Array(128),
      NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.exclusiveMinimum,
      1,
    ))).toThrow(/greater than 2400/);
    expect(() => new NoteInputEngine().process(capturedWindow(
      new Float32Array(128),
      NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.maximum + 1,
      1,
    ))).toThrow(/no greater than 768000/);
  });

  it("analyzes arbitrarily quiet nonzero harmonic evidence down to -126 dBFS scale", () => {
    const trials = [-72, -90, -108, -126].flatMap((rmsScaleDbfs) =>
      [36, 48, 60, 72, 83].map((midi) => ({ midi, rmsScaleDbfs })));
    const results = trials.map((trial, index) => {
      const frame = processHarmonic(new NoteInputEngine(), trial.midi, index, {
        rmsScaleDbfs: trial.rmsScaleDbfs,
      });
      return {
        ...trial,
        frame,
        failure: frameFailure(frame, trial.midi, 2),
      };
    });

    expect(NOTE_INPUT_DEFAULTS.rmsThreshold).toBe(0);
    expect(results.flatMap((result) => result.failure === null
      ? []
      : [`${result.rmsScaleDbfs} dBFS / ${result.failure}`])).toEqual([]);
    expect(results.every(({ frame }) => frame.rms > 0)).toBe(true);
  });

  it("lets credible best-period evidence reach minConfidence when no YIN minimum crosses the search guide", () => {
    const samples = generateSyntheticSignal({
      sampleRate: REFERENCE_SAMPLE_RATE,
      durationSeconds: REFERENCE_WINDOW_SECONDS,
      frequencyHz: midiToFrequency(48),
      amplitude: 0.02,
      harmonics: [
        { multiple: 2, amplitude: 0.3 },
        { multiple: 3, amplitude: 0.1 },
      ],
      noiseAmplitude: 0.013,
      noiseSeed: 12_345,
    });
    const frame = new NoteInputEngine().process(capturedWindow(
      samples,
      REFERENCE_SAMPLE_RATE,
      1,
    )).observation;

    expect(frame.periodicity).toBeGreaterThan(NOTE_INPUT_DEFAULTS.minConfidence);
    expect(frame.periodicity).toBeLessThan(1 - NOTE_INPUT_DEFAULTS.yinThreshold);
    expect(frame).toMatchObject({
      observationKind: "voiced",
      voiced: true,
      reason: "detected",
      nearestMidi: 48,
    });
    expect(Math.abs((frame.midiFloat! - 48) * 100)).toBeLessThan(8);
  });

  it("detects every low-register semitone from F-sharp 1 through B2 at -108 dBFS scale across production rates", () => {
    const lowMidis = Array.from({ length: 48 - LOWEST_SUPPORTED_MIDI },
      (_, index) => LOWEST_SUPPORTED_MIDI + index);
    const trials = PRODUCTION_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      lowMidis.map((midi) => ({ sampleRate, midi })));
    const results = trials.map(({ sampleRate, midi }, index) => {
      const frame = processHarmonic(new NoteInputEngine(), midi, index, {
        sampleRate,
        rmsScaleDbfs: -108,
      });
      const failure = frameFailure(frame, midi, 2);
      return {
        sampleRate,
        midi,
        frame,
        failure: failure === null ? null : `${sampleRate} Hz / ${failure}`,
      };
    });

    expect({
      lowestMidi: lowMidis[0],
      highestMidi: lowMidis.at(-1),
      passed: results.filter(({ failure }) => failure === null).length,
      total: results.length,
      failures: results.flatMap(({ failure }) => failure ?? []),
    }).toEqual({
      lowestMidi: 30,
      highestMidi: 47,
      passed: 108,
      total: 108,
      failures: [],
    });
    expect(results.every(({ frame }) => frame.rms > 0)).toBe(true);
  });

  it("retains low-register identity when realistic vocal spectra have a dominant second harmonic", () => {
    const lowMidis = Array.from({ length: 48 - LOWEST_SUPPORTED_MIDI },
      (_, index) => LOWEST_SUPPORTED_MIDI + index);
    const phases = [0, 0.61, 1.37, 2.53] as const;
    const profiles = [
      { name: "moderate-fundamental", fundamental: 0.2 },
      { name: "weak-fundamental", fundamental: 0.08 },
    ] as const;
    const trials = PRODUCTION_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      profiles.flatMap((profile) =>
        lowMidis.flatMap((midi) =>
          phases.map((phaseRadians) => ({
            sampleRate,
            profile,
            midi,
            phaseRadians,
          })))));
    const results = trials.map((trial) => {
      const captureSize = analysisWindowSizes(
        trial.sampleRate,
        REFERENCE_WINDOW_SIZE,
      ).windowSize;
      const samples = generateSyntheticSignal({
        sampleRate: trial.sampleRate,
        durationSeconds: captureSize / trial.sampleRate,
        frequencyHz: midiToFrequency(trial.midi),
        amplitude: 0.12,
        fundamentalAmplitude: trial.profile.fundamental,
        phaseRadians: trial.phaseRadians,
        harmonics: [
          { multiple: 2, amplitude: 1, phaseRadians: 2 * trial.phaseRadians + 0.23 },
          { multiple: 3, amplitude: 0.24, phaseRadians: 3 * trial.phaseRadians + 0.91 },
          { multiple: 4, amplitude: 0.12, phaseRadians: 4 * trial.phaseRadians + 1.43 },
        ],
      });
      const frame = new NoteInputEngine().process(
        capturedWindow(samples, trial.sampleRate, 1),
      ).observation;
      return {
        ...trial,
        frame,
        failure: frameFailure(frame, trial.midi, 3),
      };
    });
    const failures = results.flatMap((result) => result.failure === null
      ? []
      : [{
          sampleRate: result.sampleRate,
          profile: result.profile.name,
          midi: result.midi,
          phaseRadians: result.phaseRadians,
          detectedMidi: result.frame.nearestMidi,
          reason: result.frame.reason,
          confidence: Number(result.frame.confidence.toFixed(4)),
          failure: result.failure,
        }]);

    const matrix = PRODUCTION_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      profiles.map((profile) => ({
        sampleRate,
        profile: profile.name,
        failuresByMidi: lowMidis.flatMap((midi) => {
          const outcomes = phases.map((phaseRadians) => {
            const result = results.find((candidate) =>
              candidate.sampleRate === sampleRate
              && candidate.profile.name === profile.name
              && candidate.midi === midi
              && candidate.phaseRadians === phaseRadians)!;
            return result.failure === null
              ? "ok"
              : result.frame.voiced
                ? `midi-${String(result.frame.nearestMidi)}`
                : result.frame.reason;
          });
          return outcomes.every((outcome) => outcome === "ok")
            ? []
            : [{ midi, phases, outcomes }];
        }),
      })));

    console.info("dominant-second low-register stress summary", {
      trials: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
    });
    console.info("dominant-second low-register exact failure matrix", JSON.stringify(matrix));
    expect(failures.length).toBe(0);
  });

  it("does not invent a sub-80 Hz octave beneath pure high tones", () => {
    const highMidis = Array.from({ length: 10 }, (_, index) => 42 + index);
    const phases = [0, 0.61, 1.37, 2.53] as const;
    const trials = PRODUCTION_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      highMidis.flatMap((midi) =>
        phases.map((phaseRadians) => ({ sampleRate, midi, phaseRadians }))));
    const results = trials.map((trial) => {
      const captureSize = analysisWindowSizes(
        trial.sampleRate,
        REFERENCE_WINDOW_SIZE,
      ).windowSize;
      const samples = generateSyntheticSignal({
          sampleRate: trial.sampleRate,
          durationSeconds: captureSize / trial.sampleRate,
          frequencyHz: midiToFrequency(trial.midi),
          amplitude: 0.24,
          phaseRadians: trial.phaseRadians,
        });
      const frame = new NoteInputEngine().process(
        capturedWindow(samples, trial.sampleRate, 1),
      ).observation;
      const failure = frameFailure(frame, trial.midi, 2);
      return {
        ...trial,
        failure: failure === null
          ? null
          : `${trial.sampleRate} Hz / phase ${trial.phaseRadians} / ${failure}`,
      };
    });

    expect({
      trials: results.length,
      passed: results.filter(({ failure }) => failure === null).length,
      failures: results.flatMap(({ failure }) => failure ?? []),
    }).toEqual({ trials: 240, passed: 240, failures: [] });
  });

  it("does not fold high periodic sources onto 50 or 60 Hz mains leakage", () => {
    const phases = [0, 0.61, 1.37, 2.53] as const;
    const cases = [
      { targetHz: 100, mainsHz: 50, otherMainsHz: 120 },
      { targetHz: 120, mainsHz: 60, otherMainsHz: 50 },
    ] as const;
    const trials = PRODUCTION_CAPTURE_SAMPLE_RATES.flatMap((sampleRate) =>
      cases.flatMap((fixture) =>
        phases.map((phaseRadians) => ({ sampleRate, fixture, phaseRadians }))));
    const results = trials.map((trial, trialIndex) => {
      const captureSize = analysisWindowSizes(
        trial.sampleRate,
        REFERENCE_WINDOW_SIZE,
      ).windowSize;
      const durationSeconds = captureSize / trial.sampleRate;
      const target = generateSyntheticSignal({
        sampleRate: trial.sampleRate,
        durationSeconds,
        frequencyHz: trial.fixture.targetHz,
        amplitude: 0.24,
        phaseRadians: trial.phaseRadians,
      });
      const mains = generateSyntheticSignal({
        sampleRate: trial.sampleRate,
        durationSeconds,
        frequencyHz: trial.fixture.mainsHz,
        amplitude: 0.034,
        phaseRadians: trial.phaseRadians * 0.73 + 0.2,
      });
      const otherMains = generateSyntheticSignal({
        sampleRate: trial.sampleRate,
        durationSeconds,
        frequencyHz: trial.fixture.otherMainsHz,
        amplitude: 0.012,
        phaseRadians: trial.phaseRadians * 1.31 + 0.8,
      });
      const noise = generateSyntheticSignal({
        sampleRate: trial.sampleRate,
        durationSeconds,
        frequencyHz: 440,
        amplitude: 0,
        noiseAmplitude: 0.004,
        noiseSeed: 0x4d_41_49_4e ^ Math.imul(trialIndex + 1, 0x9e_37_79_b1),
      });
      const samples = Float32Array.from(target, (sample, index) =>
        sample + mains[index]! + otherMains[index]! + noise[index]!);
      const frame = new NoteInputEngine().process(
        capturedWindow(samples, trial.sampleRate, 1),
      ).observation;
      const errorCents = frame.frequencyHz === null
        ? null
        : 1_200 * Math.log2(frame.frequencyHz / trial.fixture.targetHz);
      return { ...trial, frame, errorCents };
    });

    expect(results.flatMap(({ sampleRate, fixture, phaseRadians, frame, errorCents }) => {
      if (!frame.voiced) {
        return [`${sampleRate} Hz / target ${fixture.targetHz} / phase ${phaseRadians}: ${frame.reason}`];
      }
      return errorCents === null || Math.abs(errorCents) > 3
        ? [`${sampleRate} Hz / target ${fixture.targetHz} / phase ${phaseRadians}: ${errorCents?.toFixed(2) ?? "no"} cents`]
        : [];
    })).toEqual([]);
    expect(results).toHaveLength(48);
  });

  it("rejects digital silence and deterministic broadband noise", () => {
    const engine = new NoteInputEngine();
    const silence = engine.process(capturedWindow(
      new Float32Array(REFERENCE_WINDOW_SIZE),
      REFERENCE_SAMPLE_RATE,
      0,
    )).observation;
    const noiseFrames = Array.from({ length: 16 }, (_, index) =>
      engine.process(capturedWindow(
        generateSyntheticSignal({
          sampleRate: REFERENCE_SAMPLE_RATE,
          durationSeconds: REFERENCE_WINDOW_SECONDS,
          frequencyHz: 440,
          amplitude: 0,
          noiseAmplitude: 0.2,
          noiseSeed: 0x51_4e_4f_49 ^ Math.imul(index + 1, 0x9e_37_79_b1),
        }),
        REFERENCE_SAMPLE_RATE,
        (index + 1) * REFERENCE_WINDOW_SECONDS,
      )).observation);

    expect(silence).toMatchObject({
      voiced: false,
      nearestMidi: null,
      frequencyHz: null,
      reason: "below-rms-threshold",
    });
    expect(noiseFrames.every((frame) => !frame.voiced)).toBe(true);
    expect(noiseFrames.every((frame) => frame.nearestMidi === null)).toBe(true);
    expect(noiseFrames.every((frame) =>
      frame.reason === "no-periodic-candidate"
        || frame.reason === "below-confidence-threshold")).toBe(true);
  });

  it("normalizes 96 and 192 kHz windows and still maps their first frame", () => {
    const trials = [96_000, 192_000].flatMap((sampleRate) =>
      [36, 48, 60, 72, 83].map((midi) => ({ sampleRate, midi })));
    const results = trials.map((trial, index) => {
      const engine = new NoteInputEngine();
      const samples = harmonicWindow(trial.midi, {
        sampleRate: trial.sampleRate,
        windowIndex: index,
      });
      const result = engine.process(capturedWindow(
        samples,
        trial.sampleRate,
        (index + 0.5) * REFERENCE_WINDOW_SECONDS,
      ));
      return { ...trial, samples, result };
    });

    expect(results.flatMap(({ midi, result }) =>
      frameFailure(result.observation, midi, 2) ?? [])).toEqual([]);
    for (const { sampleRate, samples, result } of results) {
      expect(samples.length).toBe(
        analysisWindowSizes(sampleRate, REFERENCE_WINDOW_SIZE).windowSize,
      );
      expect(result.configuration.analysisSampleRate).toBeCloseTo(
        REFERENCE_SAMPLE_RATE,
        10,
      );
      expect(result.configuration.analysisSampleCount).toBe(REFERENCE_WINDOW_SIZE);
    }
  });

  it("reports processing-time statistics without a host-dependent deadline", () => {
    const fixtures = Array.from({ length: 24 }, (_, index) => ({
      midi: LOWEST_SUPPORTED_MIDI
        + index * 7 % (HIGHEST_SUPPORTED_MIDI - LOWEST_SUPPORTED_MIDI + 1),
      samples: harmonicWindow(
        LOWEST_SUPPORTED_MIDI
          + index * 7 % (HIGHEST_SUPPORTED_MIDI - LOWEST_SUPPORTED_MIDI + 1),
        { windowIndex: index },
      ),
    }));
    const engine = new NoteInputEngine();
    // Warm module-level detector buffers before measuring individual calls.
    engine.process(capturedWindow(
      fixtures[0]!.samples,
      REFERENCE_SAMPLE_RATE,
      0,
    ));

    const durationsMs: number[] = [];
    const frames = fixtures.map((fixture, index) => {
      const startedAt = performance.now();
      const independentWindow = capturedWindow(
        fixture.samples,
        REFERENCE_SAMPLE_RATE,
        (index + 1) * REFERENCE_WINDOW_SECONDS,
      );
      const frame = engine.process({
        ...independentWindow,
        // This benchmark intentionally changes pitch by seven semitones every
        // call. Mark each unrelated fixture as an explicit authority boundary
        // instead of asking the temporal tracker to believe an impossible
        // 20 ms vocal teleport.
        discontinuity: true,
      }).observation;
      durationsMs.push(performance.now() - startedAt);
      return frame;
    });
    const sorted = [...durationsMs].sort((left, right) => left - right);
    const percentile = (ratio: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
    const stats = {
      samples: sorted.length,
      minimumMs: Number(sorted[0]!.toFixed(3)),
      medianMs: Number(percentile(0.5).toFixed(3)),
      p95Ms: Number(percentile(0.95).toFixed(3)),
      maximumMs: Number(sorted.at(-1)!.toFixed(3)),
      meanMs: Number(
        (sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3),
      ),
    };

    console.info("NoteInputEngine processing-time stats", stats);
    expect(frames.flatMap((frame, index) =>
      frameFailure(frame, fixtures[index]!.midi, 2) ?? [])).toEqual([]);
    expect(stats.samples).toBe(fixtures.length);
    for (const measurement of [
      stats.minimumMs,
      stats.medianMs,
      stats.p95Ms,
      stats.maximumMs,
      stats.meanMs,
    ]) {
      expect(Number.isFinite(measurement)).toBe(true);
      expect(measurement).toBeGreaterThanOrEqual(0);
    }
  });
});
