import { describe, expect, it } from "vitest";

import { scoreSustainedNote, type NoteTarget, type PitchFrame } from "../src";

const target: NoteTarget = {
  midi: 60,
  centsOffset: 0,
  timbre: "sine",
  amplitude: 0.5,
};

const frame = (
  timeSeconds: number,
  cents: number | null,
  overrides: Partial<PitchFrame> = {},
): PitchFrame => ({
  timeSeconds,
  frequencyHz: null,
  midiFloat: cents === null ? null : 60 + cents / 100,
  nearestMidi: cents === null ? null : 60,
  centsFromNearest: cents,
  rms: cents === null ? 0.001 : 0.1,
  confidence: cents === null ? 0 : 0.95,
  voiced: cents !== null,
  ...overrides,
});

describe("scoreSustainedNote", () => {
  it("keeps signed pitch error and reports the sustained-note metrics", () => {
    const frames = Array.from({ length: 51 }, (_, index) => frame(index * 0.02, 23));
    const metrics = scoreSustainedNote(frames, target, {
      toleranceCents: 25,
      promptTimeSeconds: 0,
    });

    expect(metrics.attackErrorCents).toBeCloseTo(23, 8);
    expect(metrics.medianErrorCents).toBeCloseTo(23, 8);
    expect(metrics.meanAbsoluteErrorCents).toBeCloseTo(23, 8);
    expect(metrics.stabilityCents).toBeCloseTo(0, 8);
    expect(metrics.driftCentsPerSecond).toBeCloseTo(0, 8);
    expect(metrics.inToleranceRatio).toBe(1);
    expect(metrics.holdDurationMs).toBeCloseTo(1_000, 8);
    expect(metrics.onsetLatencyMs).toBe(0);
    expect(metrics.detectorConfidence).toBeCloseTo(0.95, 8);
    expect(metrics.volume?.envelope.length).toBeLessThanOrEqual(51);
  });

  it("measures onset latency, continuous hold, confidence filtering, and drift", () => {
    const frames = [frame(0, null), frame(0.1, null)];
    for (let index = 0; index <= 20; index += 1) {
      const timeSeconds = 0.25 + index * 0.05;
      frames.push(frame(timeSeconds, -20 + index * 2));
    }
    frames.push(frame(1.3, 80, { confidence: 0.2 }));
    const metrics = scoreSustainedNote(frames, target, {
      toleranceCents: 10,
      promptTimeSeconds: 0,
      minimumConfidence: 0.5,
    });

    expect(metrics.onsetLatencyMs).toBeCloseTo(250, 8);
    expect(metrics.holdDurationMs).toBeCloseTo(1_000, 8);
    expect(metrics.medianErrorCents).toBeCloseTo(0, 8);
    expect(metrics.driftCentsPerSecond).toBeCloseTo(40, 8);
    expect(metrics.analyzedFrameCount).toBe(21);
    expect(metrics.voicedFrameCount).toBe(22);
    expect(metrics.inToleranceRatio).toBeCloseTo(11 / 21, 8);
  });

  it("selects the longest hold by elapsed time instead of favorable frame density", () => {
    const frames = [
      frame(0, 0),
      frame(0.01, 0),
      frame(0.02, 0),
      frame(0.03, 0),
      frame(1, 0),
      frame(1.09, 0),
      frame(1.18, 0),
    ];
    const metrics = scoreSustainedNote(frames, target, {
      maximumVoicedGapSeconds: 0.1,
    });

    expect(metrics.holdDurationMs).toBeCloseTo(180, 8);
  });

  it("recognizes centered vibrato without folding it into the target center", () => {
    const frames = Array.from({ length: 201 }, (_, index) => {
      const time = index / 100;
      return frame(time, 3 + 30 * Math.sin(2 * Math.PI * 5 * time));
    });
    const metrics = scoreSustainedNote(frames, target, { toleranceCents: 35 });

    expect(metrics.medianErrorCents).toBeCloseTo(3, 1);
    expect(metrics.vibrato?.detected).toBe(true);
    expect(metrics.vibratoCenterCents).toBeCloseTo(3, 1);
    expect(metrics.vibratoDepthCents).toBeCloseTo(30, 0);
    expect(metrics.vibratoRateHz).toBeCloseTo(5, 1);
    expect(metrics.vibratoRegularity).toBeGreaterThan(0.95);
    expect(metrics.stabilityCents).toBeGreaterThan(20);
    expect(metrics.vibratoAdjustedStabilityCents).toBeLessThan(1);
  });

  it("does not invent a second MIDI coordinate from a malformed frequency-only frame", () => {
    const frequency = 440 * 2 ** ((60.12 - 69) / 12);
    const frames = [
      frame(0, null, {
        frequencyHz: frequency,
        midiFloat: null,
        voiced: true,
        confidence: 1,
      }),
    ];
    const metrics = scoreSustainedNote(frames, target);
    expect(metrics.voicedFrameCount).toBe(0);
    expect(metrics.analyzedFrameCount).toBe(0);
    expect(metrics.medianErrorCents).toBeUndefined();
  });

  it("excludes malformed confidence and out-of-range MIDI coordinates", () => {
    const metrics = scoreSustainedNote([
      frame(0, 0, { confidence: 1.01 }),
      frame(0.1, 0, { confidence: -0.01 }),
      frame(0.2, 0, { midiFloat: Number.MAX_VALUE }),
      frame(0.3, 5),
    ], target);

    expect(metrics.voicedFrameCount).toBe(1);
    expect(metrics.analyzedFrameCount).toBe(1);
    expect(metrics.medianErrorCents).toBeCloseTo(5, 8);
    expect(metrics.detectorConfidence).toBeCloseTo(0.95, 8);
  });

  it("returns observable counts rather than inventing pitch metrics for silence", () => {
    const metrics = scoreSustainedNote([frame(0, null), frame(0.1, null)], target);
    expect(metrics.totalFrameCount).toBe(2);
    expect(metrics.voicedFrameCount).toBe(0);
    expect(metrics.analyzedFrameCount).toBe(0);
    expect(metrics.medianErrorCents).toBeUndefined();
  });

  it("keeps invalid RMS values out of serialized volume evidence", () => {
    const frames = [
      frame(0, 0, { rms: 0.1 }),
      frame(0.1, 0, { rms: Number.NaN }),
      frame(0.2, 0, { rms: -1 }),
      frame(0.3, 0, { rms: 0.3 }),
    ];
    const volume = scoreSustainedNote(frames, target, { volumeEnvelopePoints: 4 }).volume;

    expect(volume).toMatchObject({
      meanRms: 0.2,
      minimumRms: 0.1,
      maximumRms: 0.3,
    });
    expect(volume?.envelope).toEqual([
      { timeSeconds: 0, rms: 0.1 },
      { timeSeconds: 0.3, rms: 0.3 },
    ]);
    expect(JSON.stringify(volume)).not.toContain("null");
  });

  it("keeps extreme finite RMS evidence numerically representable", () => {
    const volume = scoreSustainedNote([
      frame(0, 0, { rms: Number.MAX_VALUE }),
      frame(0.1, 0, { rms: Number.MIN_VALUE }),
    ], target).volume;

    expect(volume?.meanRms).toBe(Number.MAX_VALUE / 2);
    expect(volume?.dynamicRangeDb).toBeTypeOf("number");
    expect(Number.isFinite(volume?.dynamicRangeDb)).toBe(true);
  });

  it("rejects an invalid target lane", () => {
    expect(() => scoreSustainedNote([], {
      ...target,
      midi: Number.MAX_VALUE,
      centsOffset: Number.MAX_VALUE,
    })).toThrow(/resolved target MIDI/);
    expect(() => scoreSustainedNote([], {
      ...target,
      midi: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow(/canonical safe range/);
    expect(() => scoreSustainedNote([], target, { toleranceCents: 0 })).toThrow(RangeError);
    expect(() => scoreSustainedNote([], target, { promptTimeSeconds: Number.NaN })).toThrow(RangeError);
    expect(() => scoreSustainedNote([], target, { minimumConfidence: 1.1 })).toThrow(RangeError);
    expect(() => scoreSustainedNote([], target, { maximumVoicedGapSeconds: 0 })).toThrow(RangeError);
    expect(() => scoreSustainedNote([], target, { volumeEnvelopePoints: 1.5 })).toThrow(RangeError);
    expect(() => scoreSustainedNote([], target, { vibrato: { minimumCycles: 0 } })).toThrow(RangeError);
  });
});
