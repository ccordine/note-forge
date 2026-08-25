import { describe, expect, it } from "vitest";

import {
  midiToFrequency,
  pitchValuesFromFrequency,
  type YinPitchFrame,
} from "@noteforge/pitch-engine";
import {
  PitchStateTracker,
} from "../apps/web/src/audio/pitch-state-tracker";

function voiced(midiFloat: number, timeSeconds: number, confidence = 0.95): YinPitchFrame {
  const frequencyHz = midiToFrequency(midiFloat);
  return {
    timeSeconds,
    ...pitchValuesFromFrequency(frequencyHz),
    rms: 0.08,
    confidence,
    voiced: true,
    detector: "yin",
    periodSamples: 48_000 / frequencyHz,
    yinValue: 1 - confidence,
    reason: "detected",
  };
}

function unvoiced(timeSeconds: number): YinPitchFrame {
  return {
    timeSeconds,
    frequencyHz: null,
    midiFloat: null,
    nearestMidi: null,
    centsFromNearest: null,
    rms: 0.002,
    confidence: 0.2,
    voiced: false,
    detector: "yin",
    periodSamples: null,
    yinValue: 0.8,
    reason: "no-periodic-candidate",
  };
}

describe("target-independent causal pitch state", () => {
  it("withholds a one-frame teleport and immediately accepts the returning contour", () => {
    const tracker = new PitchStateTracker();
    const results = [
      tracker.track(voiced(48, 0)),
      tracker.track(voiced(48.04, 0.02)),
      tracker.track(voiced(67, 0.04, 0.91)),
      tracker.track(voiced(47.98, 0.06)),
    ];

    expect(results.map(({ frame }) => frame.nearestMidi)).toEqual([48, 48, null, 48]);
    expect(results.map(({ decision }) => decision)).toEqual([
      "accepted-cold-attack",
      "accepted-continuation",
      "pending-transition",
      "accepted-continuation",
    ]);
    expect(results[2]!.frame.reason).toBe("temporally-ambiguous");
    expect(results[2]!.candidate).toMatchObject({
      nearestMidi: 67,
      voiced: true,
      reason: "detected",
    });
  });

  it("accepts a genuinely persistent note step after one ambiguous hop", () => {
    const tracker = new PitchStateTracker();
    const results = [
      tracker.track(voiced(48, 0)),
      tracker.track(voiced(50.03, 0.02)),
      // Ordinary estimator jitter can reverse by a few cents while remaining
      // strong persistent evidence for the same remote pitch region.
      tracker.track(voiced(49.98, 0.04)),
      tracker.track(voiced(49.98, 0.06)),
    ];

    expect(results.map(({ frame }) => frame.nearestMidi)).toEqual([48, null, 50, 50]);
    expect(results[2]!.decision).toBe("accepted-confirmed-transition");
  });

  it("passes vibrato and a fast coherent glide without a median-filter delay", () => {
    const tracker = new PitchStateTracker();
    const midi = [48, 48.22, 48.47, 48.75, 49.02, 49.31, 49.58];
    const results = midi.map((value, index) => tracker.track(voiced(value, index * 0.02)));

    results.forEach(({ frame }, index) => {
      expect(frame.midiFloat).toBeCloseTo(midi[index]!, 10);
    });
    expect(results.slice(1).every(({ decision }) => decision === "accepted-continuation"))
      .toBe(true);
  });

  it("publishes silence immediately and treats a later voiced attack as new authority", () => {
    const tracker = new PitchStateTracker();
    const first = tracker.track(voiced(48, 0));
    const silence = Array.from({ length: 8 }, (_unused, index) =>
      tracker.track(unvoiced(0.02 * (index + 1))));
    const attack = tracker.track(voiced(67, 0.18));

    expect(first.frame.nearestMidi).toBe(48);
    expect(silence.every(({ frame, decision }) => !frame.voiced && decision === "no-pitch"))
      .toBe(true);
    expect(attack).toMatchObject({
      decision: "accepted-cold-attack",
      frame: { nearestMidi: 67, voiced: true },
    });
  });

  it("resets temporal authority across a long scheduling gap", () => {
    const tracker = new PitchStateTracker();
    tracker.track(voiced(48, 0));
    const afterGap = tracker.track(voiced(72, 0.25));

    expect(afterGap).toMatchObject({
      decision: "accepted-cold-attack",
      frame: { nearestMidi: 72 },
    });
  });
});
