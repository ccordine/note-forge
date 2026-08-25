import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_NOTE_TRACKER_OPTIONS,
  reduceLiveNote,
  type LiveNote,
  type LiveNoteTrackerOptions,
  type TrackablePitchObservation,
} from "../apps/web/src/audio/live-note";

const SAMPLE_RATE = 48_000;

function observation(
  overrides: Partial<TrackablePitchObservation> = {},
): Readonly<TrackablePitchObservation> {
  return Object.freeze({
    sampleRate: SAMPLE_RATE,
    startSample: 0,
    endSample: 4_096,
    processedSampleCount: overrides.endSample ?? 4_096,
    captureEpoch: 1,
    continuityEpoch: 1,
    graphGeneration: 0,
    workletProcessCount: Math.floor((overrides.endSample ?? 4_096) / 128),
    discontinuity: false,
    observationKind: "voiced",
    frequencyHz: 261.625565,
    midiFloat: 60,
    nearestMidi: 60,
    centsFromNearest: 0,
    confidence: 0.95,
    ...overrides,
  });
}

function advance(
  previous: Readonly<LiveNote> | null,
  overrides: Partial<TrackablePitchObservation> = {},
  options: Readonly<LiveNoteTrackerOptions> = DEFAULT_LIVE_NOTE_TRACKER_OPTIONS,
): Readonly<LiveNote> | null {
  return reduceLiveNote(previous, observation(overrides), options);
}

describe("continuous live-note tracking", () => {
  it("reports the current note immediately without inventing pre-observation hold time", () => {
    const live = advance(null);

    expect(live).toEqual({
      sampleRate: SAMPLE_RATE,
      startSample: 0,
      endSample: 4_096,
      processedSampleCount: 4_096,
      captureEpoch: 1,
      continuityEpoch: 1,
      graphGeneration: 0,
      workletProcessCount: 32,
      frequencyHz: 261.625565,
      midiFloat: 60,
      nearestMidi: 60,
      centsFromNearest: 0,
      confidence: 0.95,
      enteredAtSample: 4_096,
      heldSamples: 0,
      heldSeconds: 0,
      stable: false,
    });
  });

  it("advances same-note hold time by overlapping-window hops, not window lengths", () => {
    const options = { stableAfterSeconds: 0.04 } as const;
    const first = advance(null, {}, options);
    const second = advance(first, {
      startSample: 960,
      endSample: 5_056,
      frequencyHz: 261.7,
      confidence: 0.96,
    }, options);
    const third = advance(second, {
      startSample: 1_920,
      endSample: 6_016,
      frequencyHz: 261.6,
      confidence: 0.97,
    }, options);

    expect([first?.heldSamples, second?.heldSamples, third?.heldSamples])
      .toEqual([0, 960, 1_920]);
    expect([first?.heldSeconds, second?.heldSeconds, third?.heldSeconds])
      .toEqual([0, 0.02, 0.04]);
    expect([first?.stable, second?.stable, third?.stable])
      .toEqual([false, false, true]);
    expect(third?.enteredAtSample).toBe(4_096);
  });

  it("treats silence and uncertainty as ordinary note-free observations", () => {
    const voiced = advance(null);
    const silence = advance(voiced, {
      startSample: 960,
      endSample: 5_056,
      observationKind: "unvoiced",
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
      confidence: 0,
    });
    const afterSilence = advance(silence, {
      startSample: 1_920,
      endSample: 6_016,
    });
    const uncertain = advance(afterSilence, {
      startSample: 2_880,
      endSample: 6_976,
      observationKind: "uncertain",
      frequencyHz: 261.4,
      midiFloat: 59.985,
      nearestMidi: 60,
      centsFromNearest: -1.5,
      confidence: 0.4,
    });

    expect(silence).toBeNull();
    expect(afterSilence).toMatchObject({
      nearestMidi: 60,
      enteredAtSample: 6_016,
      heldSamples: 0,
    });
    expect(uncertain).toBeNull();
  });

  it("starts a new occupancy interval immediately when the nearest note changes", () => {
    const c4 = advance(null);
    const cSharp4 = advance(c4, {
      startSample: 960,
      endSample: 5_056,
      frequencyHz: 277.182631,
      midiFloat: 61,
      nearestMidi: 61,
      centsFromNearest: 0,
    });

    expect(cSharp4).toMatchObject({
      nearestMidi: 61,
      enteredAtSample: 5_056,
      heldSamples: 0,
      heldSeconds: 0,
    });
  });

  it("preserves bends, vibrato, and confidence from each current same-note frame", () => {
    const first = advance(null, {
      frequencyHz: 258.623,
      midiFloat: 59.8,
      centsFromNearest: -20,
      confidence: 0.82,
    });
    const second = advance(first, {
      startSample: 960,
      endSample: 5_056,
      frequencyHz: 264.665,
      midiFloat: 60.2,
      centsFromNearest: 20,
      confidence: 0.91,
    });
    const third = advance(second, {
      startSample: 1_920,
      endSample: 6_016,
      frequencyHz: 260.871,
      midiFloat: 59.95,
      centsFromNearest: -5,
      confidence: 0.88,
    });

    expect(third).toMatchObject({
      frequencyHz: 260.871,
      midiFloat: 59.95,
      nearestMidi: 60,
      centsFromNearest: -5,
      confidence: 0.88,
      enteredAtSample: 4_096,
      heldSamples: 1_920,
    });
  });

  it("resets occupancy across explicit discontinuities and epoch changes", () => {
    const first = advance(null);
    const discontinuous = advance(first, {
      startSample: 960,
      endSample: 5_056,
      discontinuity: true,
    });
    const newContinuityEpoch = advance(discontinuous, {
      startSample: 1_920,
      endSample: 6_016,
      continuityEpoch: 2,
    });
    const newCaptureEpoch = advance(newContinuityEpoch, {
      startSample: 0,
      endSample: 4_096,
      captureEpoch: 2,
      continuityEpoch: 1,
    });
    const newSampleRate = advance(newCaptureEpoch, {
      sampleRate: 44_100,
      startSample: 441,
      endSample: 4_537,
      captureEpoch: 2,
      continuityEpoch: 1,
    });

    for (const live of [discontinuous, newContinuityEpoch, newCaptureEpoch, newSampleRate]) {
      expect(live).toMatchObject({ heldSamples: 0, heldSeconds: 0 });
      expect(live?.enteredAtSample).toBe(live?.endSample);
    }
  });

  it("ignores duplicate/reordered frames and resets on a real missing window", () => {
    const first = advance(null);
    const duplicate = advance(first);
    const regressing = advance(first, {
      startSample: 1,
      endSample: 4_000,
    });
    const gap = advance(first, {
      startSample: 5_000,
      endSample: 9_096,
    });

    expect(duplicate).toBe(first);
    expect(regressing).toBe(first);
    expect(gap).toMatchObject({ heldSamples: 0, heldSeconds: 0 });
    expect(gap?.enteredAtSample).toBe(gap?.endSample);
  });

  it("does not let stale nonvoiced evidence clear a newer live note", () => {
    const first = advance(null);
    const staleSilence = advance(first, {
      observationKind: "unvoiced",
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
      confidence: 0,
    } as Partial<TrackablePitchObservation>);
    expect(staleSilence).toBe(first);
  });

  it("clears rather than throwing on malformed or unsafe stream evidence", () => {
    const first = advance(null);
    const invalid = [
      observation({ endSample: 0 }),
      observation({ startSample: 0.5 }),
      observation({ endSample: Number.MAX_SAFE_INTEGER + 1 }),
      observation({ sampleRate: Number.NaN }),
      observation({ captureEpoch: -1 }),
      observation({ continuityEpoch: 0.5 }),
      observation({ confidence: 1.01 }),
      observation({ frequencyHz: 30_000 }),
      observation({ frequencyHz: Number.POSITIVE_INFINITY }),
      observation({ midiFloat: 60.2, centsFromNearest: 10 }),
      observation({ nearestMidi: 128 }),
      observation({ observationKind: "fabricated" as never }),
      null as never,
    ];

    expect(invalid.map((frame) => reduceLiveNote(first, frame)))
      .toEqual(invalid.map(() => null));
  });

  it("ignores an invalid prior state and starts from current valid evidence", () => {
    const forged = {
      ...advance(null),
      enteredAtSample: -1,
      heldSamples: 4_097,
    } as unknown as LiveNote;
    const live = advance(forged, {
      startSample: 960,
      endSample: 5_056,
    });

    expect(live).toMatchObject({
      enteredAtSample: 5_056,
      heldSamples: 0,
    });
  });

  it("returns immutable evidence without mutating its input", () => {
    const frame = observation();
    const before = { ...frame };
    const live = reduceLiveNote(null, frame);

    expect(Object.isFrozen(live)).toBe(true);
    expect(frame).toEqual(before);
    expect(() => {
      (live as unknown as { nearestMidi: number }).nearestMidi = 72;
    }).toThrow(TypeError);
  });

  it("validates the interpretation threshold without imposing a lifetime ceiling", () => {
    const invalid = [-1, Number.NaN, Number.POSITIVE_INFINITY];

    for (const stableAfterSeconds of invalid) {
      expect(() => advance(null, {}, { stableAfterSeconds })).toThrow(RangeError);
    }
    expect(() => reduceLiveNote(
      null,
      observation(),
      null as never,
    )).toThrow(TypeError);
    expect(advance(null, {}, { stableAfterSeconds: 0 })?.stable).toBe(true);
    expect(advance(null, {}, { stableAfterSeconds: 3_600 })?.stable).toBe(false);
  });
});
