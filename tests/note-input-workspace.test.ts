import { describe, expect, it } from "vitest";

import { midiToFrequency } from "@noteforge/pitch-engine";
import {
  NoteInputEngine,
  type NoteInputResult,
  type NoteInputWindow,
} from "../apps/web/src/audio/note-input";
import { generateSyntheticSignal } from "../packages/pitch-engine/test/synthetic-signals";

function harmonicSamples(
  midi: number,
  sampleRate: number,
  sampleCount: number,
): Float32Array {
  return generateSyntheticSignal({
    sampleRate,
    durationSeconds: sampleCount / sampleRate,
    frequencyHz: midiToFrequency(midi),
    amplitude: 0.18,
    harmonics: [
      { multiple: 2, amplitude: 0.47, phaseRadians: 0.37 },
      { multiple: 3, amplitude: 0.23, phaseRadians: 1.13 },
      { multiple: 4, amplitude: 0.11, phaseRadians: 0.71 },
    ],
  });
}

function capture(
  samples: Float32Array,
  sampleRate: number,
  startSample: number,
): NoteInputWindow {
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

function fixture(
  midi: number,
  sampleRate: number,
  sampleCount: number,
  startSample: number,
): NoteInputWindow {
  const window = capture(
    harmonicSamples(midi, sampleRate, sampleCount),
    sampleRate,
    startSample,
  );
  // These fixtures deliberately jump between unrelated notes, window sizes,
  // and non-overlapping PCM. Mark that boundary explicitly so this suite tests
  // scratch retention rather than the temporal pitch-state interpreter.
  return { ...window, discontinuity: true };
}

describe("NoteInputEngine detector workspace ownership", () => {
  it("keeps interleaved engines exactly equivalent to fresh engines", () => {
    const windows = [
      fixture(48, 96_000, 8_192, 0),
      fixture(86, 192_000, 16_384, 16_384),
      fixture(60, 96_000, 8_192, 32_768),
    ];
    const expected = windows.map((window) =>
      new NoteInputEngine().process(window));
    const first = new NoteInputEngine();
    const second = new NoteInputEngine();
    const firstResults: NoteInputResult[] = [];
    const secondResults: NoteInputResult[] = [];
    const secondOrder = [windows[2]!, windows[0]!, windows[1]!];
    for (let index = 0; index < windows.length; index += 1) {
      firstResults.push(first.process(windows[index]!));
      secondResults.push(second.process(secondOrder[index]!));
    }

    expect(firstResults).toEqual(expected);
    expect(secondResults).toEqual([expected[2], expected[0], expected[1]]);
  });

  it("does not leak stale normalized samples across high-rate size changes", () => {
    const windows = [
      fixture(48, 192_000, 16_384, 0),
      fixture(60, 192_000, 12_288, 16_384),
      fixture(55, 192_000, 16_384, 28_672),
      fixture(48, 192_000, 16_384, 45_056),
    ];
    const engine = new NoteInputEngine();
    const first = engine.process(windows[0]!);
    const retainedSnapshot = {
      observation: { ...first.observation },
      configuration: { ...first.configuration },
    };
    const reused = [first, ...windows.slice(1).map((window) => engine.process(window))];
    const fresh = windows.map((window) => new NoteInputEngine().process(window));

    expect(reused).toEqual(fresh);
    expect(first).toEqual(retainedSnapshot);
    expect(reused.map(({ observation }) => observation.nearestMidi))
      .toEqual([48, 60, 55, 48]);
    expect(reused.map(({ configuration }) => configuration.analysisSampleCount))
      .toEqual([4_096, 3_072, 4_096, 4_096]);
  });

  it("returns frozen, independently retained observations while scratch is reused", () => {
    const engine = new NoteInputEngine();
    const first = engine.process(fixture(48, 48_000, 4_096, 0)).observation;
    const snapshot = { ...first };
    const second = engine.process(fixture(55, 48_000, 4_096, 4_096)).observation;

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(second).not.toBe(first);
    expect(first).toEqual(snapshot);
    expect(first.nearestMidi).toBe(48);
    expect(second.nearestMidi).toBe(55);
  });

  it("releases its whole-process scratch guard after invalid and reentrant calls", () => {
    const engine = new NoteInputEngine();
    const valid = fixture(48, 96_000, 8_192, 0);
    expect(() => engine.process({
      ...valid,
      capturedAt: valid.capturedAt + 1,
    })).toThrow(/midpoint/);

    const reentrant = {
      ...valid,
      get samples(): Float32Array {
        engine.process(valid);
        return valid.samples;
      },
    } satisfies NoteInputWindow;
    expect(() => engine.process(reentrant)).toThrow(/reentrantly/);
    expect(engine.process(valid)).toEqual(new NoteInputEngine().process(valid));
  });
});
