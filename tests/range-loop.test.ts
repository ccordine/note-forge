import { describe, expect, it } from "vitest";

import {
  RANGE_FAMILIES,
  advanceFamily,
  createFamilyTargetSequence,
  orderTargets,
  rangeFamilyForMidi,
  targetsForFamily,
} from "../apps/web/src/features/range-loop/model";

describe("range-loop family targets", () => {
  it("defines families across every detector-supported tempered note", () => {
    expect(RANGE_FAMILIES).toEqual([
      { id: "foundation", label: "Foundation", octave: 1, firstMidi: 30, lastMidi: 35, rangeLabel: "F♯1–B1" },
      { id: "deep", label: "Deep", octave: 2, firstMidi: 36, lastMidi: 47, rangeLabel: "C2–B2" },
      { id: "low", label: "Low", octave: 3, firstMidi: 48, lastMidi: 59, rangeLabel: "C3–B3" },
      { id: "middle", label: "Middle", octave: 4, firstMidi: 60, lastMidi: 71, rangeLabel: "C4–B4" },
      { id: "high", label: "High", octave: 5, firstMidi: 72, lastMidi: 83, rangeLabel: "C5–B5" },
      { id: "upper", label: "Upper", octave: 6, firstMidi: 84, lastMidi: 86, rangeLabel: "C6–D6" },
    ]);
  });

  it("builds natural and chromatic targets inside each fixed family", () => {
    expect(targetsForFamily("foundation", "natural")).toEqual([31, 33, 35]);
    expect(targetsForFamily("deep", "natural")).toEqual([36, 38, 40, 41, 43, 45, 47]);
    expect(targetsForFamily("low", "natural")).toEqual([48, 50, 52, 53, 55, 57, 59]);
    expect(targetsForFamily("middle", "natural")).toEqual([60, 62, 64, 65, 67, 69, 71]);
    expect(targetsForFamily("high", "natural")).toEqual([72, 74, 76, 77, 79, 81, 83]);
    expect(targetsForFamily("upper", "natural")).toEqual([84, 86]);

    expect(targetsForFamily("foundation", "chromatic")).toEqual(
      Array.from({ length: 6 }, (_, index) => 30 + index),
    );
    expect(targetsForFamily("deep", "chromatic")).toEqual(
      Array.from({ length: 12 }, (_, index) => 36 + index),
    );
    expect(targetsForFamily("low", "chromatic")).toEqual(
      Array.from({ length: 12 }, (_, index) => 48 + index),
    );
    expect(targetsForFamily("middle", "chromatic")).toEqual(
      Array.from({ length: 12 }, (_, index) => 60 + index),
    );
    expect(targetsForFamily("high", "chromatic")).toEqual(
      Array.from({ length: 12 }, (_, index) => 72 + index),
    );
    expect(targetsForFamily("upper", "chromatic")).toEqual([84, 85, 86]);
  });

  it.each([
    [0, "foundation"],
    [29, "foundation"],
    [30, "foundation"],
    [35, "foundation"],
    [36, "deep"],
    [47, "deep"],
    [48, "low"],
    [59, "low"],
    [60, "middle"],
    [71, "middle"],
    [72, "high"],
    [83, "high"],
    [84, "upper"],
    [86, "upper"],
    [87, "upper"],
    [127, "upper"],
  ] as const)("maps MIDI %i to the %s range family", (midi, expectedFamily) => {
    expect(rangeFamilyForMidi(midi)).toBe(expectedFamily);
  });

  it.each([-1, 35.5, 128, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid MIDI family lookup %s",
    (midi) => {
      expect(() => rangeFamilyForMidi(midi)).toThrow(RangeError);
    },
  );

  it("orders fresh copies ascending and descending", () => {
    const source = [55, 48, 52, 50];
    expect(orderTargets(source, "ascending")).toEqual([48, 50, 52, 55]);
    expect(orderTargets(source, "descending")).toEqual([55, 52, 50, 48]);
    expect(source).toEqual([55, 48, 52, 50]);
  });

  it("uses a validated injected random source for deterministic shuffling", () => {
    let calls = 0;
    const shuffled = createFamilyTargetSequence({
      familyId: "low",
      noteSet: "natural",
      order: "shuffled",
      rng: () => {
        calls += 1;
        return 0;
      },
    });

    expect(shuffled).toEqual([50, 52, 53, 55, 57, 59, 48]);
    expect([...shuffled].sort((left, right) => left - right)).toEqual(
      targetsForFamily("low", "natural"),
    );
    expect(calls).toBe(6);
  });

  it.each([-0.01, 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid random sample %s",
    (sample) => {
      expect(() => orderTargets([1, 2], "shuffled", () => sample)).toThrow(RangeError);
    },
  );

  it("validates runtime note-set, order, and family values", () => {
    expect(() => targetsForFamily("low", "whole-tone" as never)).toThrow(RangeError);
    expect(() => orderTargets([1, 2], "randomish" as never)).toThrow(RangeError);
    expect(() => targetsForFamily("basement" as never)).toThrow(RangeError);
  });
});

describe("family cycle policy", () => {
  it("advances through the complete detector span and wraps at D6", () => {
    expect(advanceFamily("foundation")).toEqual({
      previousFamilyId: "foundation",
      familyId: "deep",
      wrapped: false,
    });
    expect(advanceFamily("deep")).toEqual({
      previousFamilyId: "deep",
      familyId: "low",
      wrapped: false,
    });
    expect(advanceFamily("low")).toEqual({
      previousFamilyId: "low",
      familyId: "middle",
      wrapped: false,
    });
    expect(advanceFamily("middle")).toEqual({
      previousFamilyId: "middle",
      familyId: "high",
      wrapped: false,
    });
    expect(advanceFamily("high")).toEqual({
      previousFamilyId: "high",
      familyId: "upper",
      wrapped: false,
    });
    expect(advanceFamily("upper")).toEqual({
      previousFamilyId: "upper",
      familyId: "foundation",
      wrapped: true,
    });
  });

  it("rejects an unknown runtime family", () => {
    expect(() => advanceFamily("ultrasonic" as never)).toThrow(RangeError);
  });
});
