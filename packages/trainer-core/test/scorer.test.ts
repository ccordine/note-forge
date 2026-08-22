import { describe, expect, it } from "vitest";

import { scoreSustainedNote, type NoteTarget, type PitchFrame } from "../src";

const target: NoteTarget = {
  midi: 60,
  centsOffset: 0,
  durationMs: 1_000,
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

  it("can derive a continuous MIDI observation from frequency", () => {
    const frequency = 440 * 2 ** ((60.12 - 69) / 12);
    const frames = [
      frame(0, null, {
        frequencyHz: frequency,
        midiFloat: null,
        voiced: true,
        confidence: 1,
      }),
    ];
    expect(scoreSustainedNote(frames, target).medianErrorCents).toBeCloseTo(12, 8);
  });

  it("returns observable counts rather than inventing pitch metrics for silence", () => {
    const metrics = scoreSustainedNote([frame(0, null), frame(0.1, null)], target);
    expect(metrics.totalFrameCount).toBe(2);
    expect(metrics.voicedFrameCount).toBe(0);
    expect(metrics.analyzedFrameCount).toBe(0);
    expect(metrics.medianErrorCents).toBeUndefined();
  });

  it("rejects an invalid target lane", () => {
    expect(() => scoreSustainedNote([], target, { toleranceCents: 0 })).toThrow(RangeError);
  });
});
