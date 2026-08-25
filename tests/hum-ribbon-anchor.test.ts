import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import { humRibbonAnchorMidi } from "../apps/web/src/features/hum-lab/hum-analysis";

function frame(midiFloat: number | null, confidence = 0.95): PitchObservation {
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
  const voiced = midiFloat !== null;
  return {
    timeSeconds: 0,
    frequencyHz: voiced ? 440 * 2 ** ((midiFloat - 69) / 12) : null,
    midiFloat,
    nearestMidi,
    centsFromNearest: voiced ? (midiFloat - nearestMidi!) * 100 : null,
    rms: voiced ? 0.05 : 0,
    confidence,
    voiced,
    detector: "yin",
    periodSamples: voiced ? 48_000 / (440 * 2 ** ((midiFloat - 69) / 12)) : null,
    yinValue: voiced ? 1 - confidence : null,
    reason: voiced ? "detected" : "below-rms-threshold",
    observationKind: voiced ? "voiced" : "unvoiced",
    sampleRate: 48_000,
    startSample: 0,
    endSample: 4_096,
    processedSampleCount: 4_096,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: 32,
    discontinuity: false,
    periodicity: voiced ? confidence : 0,
  };
}

describe("Hum Lab ribbon anchor", () => {
  it("never recenters historical geometry when later observations arrive", () => {
    const opening = [frame(null), frame(48.2, 0.2)];
    const initialAnchor = humRibbonAnchorMidi(opening);
    const extendedAnchor = humRibbonAnchorMidi([
      ...opening,
      frame(55),
      frame(43),
      frame(61),
    ]);

    expect(initialAnchor).toBe(48.2);
    expect(extendedAnchor).toBe(initialAnchor);
  });

  it("uses voiced authority rather than inventing another confidence gate", () => {
    expect(humRibbonAnchorMidi([frame(null), frame(52.1, 0.01)]))
      .toBe(52.1);
  });

  it("does not anchor from an uncertain coordinate", () => {
    expect(humRibbonAnchorMidi([{
      ...frame(52.1),
      observationKind: "uncertain",
    }])).toBeNull();
  });
});
