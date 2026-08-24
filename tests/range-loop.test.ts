import { describe, expect, it } from "vitest";

import {
  DEFAULT_MINIMUM_CONFIDENCE,
  DEFAULT_RETAINED_FRAME_LIMIT,
  DEFAULT_SUSTAIN_GRACE_SECONDS,
  RANGE_FAMILIES,
  advanceFamily,
  appendBoundedFrame,
  createFamilyTargetSequence,
  createSupportPlan,
  createSustainTracker,
  orderTargets,
  rangeFamilyForMidi,
  targetsForFamily,
  updateSustainTracker,
  type SustainFrame,
  type SustainTrackerState,
} from "../apps/web/src/features/range-loop/model";

function frame(
  timeSeconds: number,
  midiFloat: number | null = 60,
  options: Partial<Pick<SustainFrame, "confidence" | "voiced">> = {},
): SustainFrame {
  return {
    timeSeconds,
    midiFloat,
    confidence: options.confidence ?? 0.9,
    voiced: options.voiced ?? true,
  };
}

function tracker(overrides: Partial<Parameters<typeof createSustainTracker>[0]> = {}) {
  return createSustainTracker({
    targetMidi: 60,
    requiredHoldSeconds: 0.5,
    toleranceCents: 20,
    listeningStartedAtSeconds: 0,
    ...overrides,
  });
}

function feed(
  initial: SustainTrackerState,
  frames: readonly SustainFrame[],
): SustainTrackerState {
  return frames.reduce(updateSustainTracker, initial);
}

describe("range-loop family targets", () => {
  it("defines the model-owned deep-through-high octave families", () => {
    expect(RANGE_FAMILIES).toEqual([
      { id: "deep", label: "Deep", octave: 2, firstMidi: 36, lastMidi: 47, rangeLabel: "C2–B2" },
      { id: "low", label: "Low", octave: 3, firstMidi: 48, lastMidi: 59, rangeLabel: "C3–B3" },
      { id: "middle", label: "Middle", octave: 4, firstMidi: 60, lastMidi: 71, rangeLabel: "C4–B4" },
      { id: "high", label: "High", octave: 5, firstMidi: 72, lastMidi: 83, rangeLabel: "C5–B5" },
    ]);
  });

  it("builds natural and chromatic targets inside each fixed family", () => {
    expect(targetsForFamily("deep", "natural")).toEqual([36, 38, 40, 41, 43, 45, 47]);
    expect(targetsForFamily("low", "natural")).toEqual([48, 50, 52, 53, 55, 57, 59]);
    expect(targetsForFamily("middle", "natural")).toEqual([60, 62, 64, 65, 67, 69, 71]);
    expect(targetsForFamily("high", "natural")).toEqual([72, 74, 76, 77, 79, 81, 83]);

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
  });

  it.each([
    [0, "deep"],
    [35, "deep"],
    [36, "deep"],
    [47, "deep"],
    [48, "low"],
    [59, "low"],
    [60, "middle"],
    [71, "middle"],
    [72, "high"],
    [83, "high"],
    [84, "high"],
    [127, "high"],
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

describe("range-loop support plans", () => {
  it("keeps solo silent, supports a sustained unison, and places harmony guides below the voice", () => {
    expect(createSupportPlan(72, "solo")).toEqual({
      mode: "solo",
      vocalTargetMidi: 72,
      guideMidi: null,
      intervalSemitones: null,
    });
    expect(createSupportPlan(72, "unison")).toEqual({
      mode: "unison",
      vocalTargetMidi: 72,
      guideMidi: 72,
      intervalSemitones: 0,
    });
    expect(createSupportPlan(72, "major-third")).toEqual({
      mode: "major-third",
      vocalTargetMidi: 72,
      guideMidi: 68,
      intervalSemitones: 4,
    });
    expect(createSupportPlan(72, "perfect-fifth")).toEqual({
      mode: "perfect-fifth",
      vocalTargetMidi: 72,
      guideMidi: 65,
      intervalSemitones: 7,
    });
    expect(createSupportPlan(72, "octave")).toEqual({
      mode: "octave",
      vocalTargetMidi: 72,
      guideMidi: 60,
      intervalSemitones: 12,
    });

    for (const mode of ["major-third", "perfect-fifth", "octave"] as const) {
      const plan = createSupportPlan(60, mode);
      expect(plan.guideMidi).not.toBe(plan.vocalTargetMidi);
      expect(plan.guideMidi).toBeLessThan(plan.vocalTargetMidi);
    }
  });

  it("rejects invalid MIDI targets, support modes, and guides below MIDI zero", () => {
    for (const target of [-1, 60.5, 128, Number.NaN]) {
      expect(() => createSupportPlan(target, "solo")).toThrow(RangeError);
    }
    expect(() => createSupportPlan(60, "duet" as never)).toThrow(RangeError);
    expect(() => createSupportPlan(3, "major-third")).toThrow(RangeError);
  });
});

describe("timestamp-driven sustained-note tracking", () => {
  it("exposes stable defaults and completes only at the required qualified duration", () => {
    let state = tracker({ requiredHoldSeconds: 0.5 });
    expect(state).toMatchObject({
      status: "waiting",
      minimumConfidence: DEFAULT_MINIMUM_CONFIDENCE,
      graceSeconds: DEFAULT_SUSTAIN_GRACE_SECONDS,
      heldSeconds: 0,
      progress: 0,
    });

    for (const timestamp of [0, 0.1, 0.2, 0.3, 0.4]) {
      state = updateSustainTracker(state, frame(timestamp));
    }
    expect(state.status).toBe("holding");
    expect(state.heldSeconds).toBeCloseTo(0.4, 10);
    expect(state.progress).toBeCloseTo(0.8, 10);

    state = updateSustainTracker(state, frame(0.5));
    expect(state.status).toBe("complete");
    expect(state.heldSeconds).toBe(0.5);
    expect(state.progress).toBe(1);
  });

  it("accepts the tolerance and confidence boundaries inclusively", () => {
    let state = tracker({ toleranceCents: 20, minimumConfidence: 0.7 });
    state = updateSustainTracker(state, frame(0, 60.2, { confidence: 0.7 }));
    expect(state.status).toBe("holding");

    const outside = updateSustainTracker(
      tracker({ toleranceCents: 20, minimumConfidence: 0.7 }),
      frame(0, 60.201, { confidence: 0.7 }),
    );
    expect(outside.status).toBe("waiting");
  });

  it("never treats a sustained wrong pitch or an audible guide as target time", () => {
    const wrongPitchFrames = Array.from(
      { length: 31 },
      (_, index) => frame(index / 10, 64),
    );
    const result = feed(tracker({ requiredHoldSeconds: 1 }), wrongPitchFrames);
    expect(result).toMatchObject({ status: "waiting", heldSeconds: 0, progress: 0 });

    const guideMidi = createSupportPlan(60, "perfect-fifth").guideMidi!;
    const guideResult = feed(
      tracker({ requiredHoldSeconds: 1 }),
      Array.from({ length: 20 }, (_, index) => frame(index / 10, guideMidi)),
    );
    expect(guideResult.status).toBe("waiting");
  });

  it("preserves a run through a brief dropout without crediting the dropout", () => {
    let state = feed(tracker({ requiredHoldSeconds: 0.3 }), [frame(0), frame(0.1)]);
    expect(state.heldSeconds).toBeCloseTo(0.1, 10);

    state = updateSustainTracker(state, frame(0.2, null, { voiced: false }));
    expect(state).toMatchObject({ status: "holding", inGrace: true });
    expect(state.heldSeconds).toBeCloseTo(0.1, 10);

    state = updateSustainTracker(state, frame(0.21));
    expect(state).toMatchObject({ status: "holding", inGrace: false });
    expect(state.heldSeconds).toBeCloseTo(0.1, 10);

    state = updateSustainTracker(state, frame(0.31));
    expect(state.heldSeconds).toBeCloseTo(0.2, 10);
    state = updateSustainTracker(state, frame(0.41));
    expect(state.status).toBe("complete");
  });

  it("allows exactly 0.22 seconds of detector-dropout grace and resets immediately beyond it", () => {
    let state = feed(tracker(), [frame(0), frame(0.1)]);
    state = updateSustainTracker(state, frame(0.32, null, { voiced: false }));
    expect(state).toMatchObject({ status: "holding", inGrace: true });

    state = updateSustainTracker(state, frame(0.321, null, { voiced: false }));
    expect(state).toMatchObject({
      status: "waiting",
      heldSeconds: 0,
      progress: 0,
      runStartedAtSeconds: null,
      inGrace: false,
    });
  });

  it("resets immediately when a reliable pitch leaves the target lane", () => {
    let state = feed(tracker(), [frame(0), frame(0.1)]);
    state = updateSustainTracker(state, frame(0.11, 61));

    expect(state).toMatchObject({
      status: "waiting",
      heldSeconds: 0,
      progress: 0,
      runStartedAtSeconds: null,
      inGrace: false,
    });
  });

  it("restarts rather than bridging a no-frame gap longer than grace", () => {
    let state = feed(tracker(), [frame(0), frame(0.1)]);
    expect(state.heldSeconds).toBeCloseTo(0.1, 10);
    state = updateSustainTracker(state, frame(0.33));
    expect(state).toMatchObject({
      status: "holding",
      heldSeconds: 0,
      progress: 0,
      runStartedAtSeconds: 0.33,
    });
  });

  it("gates unvoiced, low-confidence, null, and non-finite pitch observations", () => {
    const invalidFrames = [
      frame(0, 60, { voiced: false }),
      frame(0.1, 60, { confidence: 0.49 }),
      frame(0.2, null),
      frame(0.3, Number.NaN),
    ];
    const state = feed(tracker(), invalidFrames);
    expect(state).toMatchObject({ status: "waiting", heldSeconds: 0, progress: 0 });
  });

  it("ignores stale prompt frames before the listening cutoff", () => {
    const initial = tracker({ listeningStartedAtSeconds: 100 });
    const stale = [frame(0), frame(50), frame(99.999)];
    const afterStale = feed(initial, stale);
    expect(afterStale).toBe(initial);

    const started = updateSustainTracker(afterStale, frame(100));
    const advanced = updateSustainTracker(started, frame(100.1));
    expect(advanced.status).toBe("holding");
    expect(advanced.heldSeconds).toBeCloseTo(0.1, 10);
    expect(advanced.runStartedAtSeconds).toBe(100);
  });

  it("ignores duplicate, out-of-order, and non-finite timestamps", () => {
    let state = feed(tracker({ listeningStartedAtSeconds: 10 }), [frame(10), frame(10.1)]);
    const duplicate = updateSustainTracker(state, frame(10.1));
    expect(duplicate).toBe(state);
    const outOfOrder = updateSustainTracker(state, frame(10.05));
    expect(outOfOrder).toBe(state);
    const nonFinite = updateSustainTracker(state, frame(Number.NaN));
    expect(nonFinite).toBe(state);

    state = updateSustainTracker(state, frame(10.2));
    expect(state.heldSeconds).toBeCloseTo(0.2, 10);
  });

  it("freezes a completed tracker against later frames", () => {
    const complete = feed(
      tracker({ requiredHoldSeconds: 0.2 }),
      [frame(0), frame(0.1), frame(0.2)],
    );
    expect(complete.status).toBe("complete");
    expect(updateSustainTracker(complete, frame(0.3, 65))).toBe(complete);
  });

  it("validates tracker configuration", () => {
    expect(() => tracker({ targetMidi: 60.5 })).toThrow(RangeError);
    expect(() => tracker({ requiredHoldSeconds: 0 })).toThrow(RangeError);
    expect(() => tracker({ requiredHoldSeconds: Number.NaN })).toThrow(RangeError);
    expect(() => tracker({ toleranceCents: 0 })).toThrow(RangeError);
    expect(() => tracker({ minimumConfidence: -0.1 })).toThrow(RangeError);
    expect(() => tracker({ minimumConfidence: 1.1 })).toThrow(RangeError);
    expect(() => tracker({ graceSeconds: -0.01 })).toThrow(RangeError);
    expect(() => tracker({ listeningStartedAtSeconds: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe("bounded trace storage", () => {
  it("retains only the newest frames without mutating the source", () => {
    const source = [1, 2, 3];
    expect(appendBoundedFrame(source, 4, 3)).toEqual([2, 3, 4]);
    expect(source).toEqual([1, 2, 3]);
    expect(appendBoundedFrame(source, 4, 1)).toEqual([4]);
    expect(appendBoundedFrame([1, 2, 3, 4], 5, 2)).toEqual([4, 5]);
  });

  it("uses a finite default cap and validates explicit caps", () => {
    const overLimit = Array.from(
      { length: DEFAULT_RETAINED_FRAME_LIMIT + 10 },
      (_, index) => index,
    );
    const result = appendBoundedFrame(overLimit, 999_999);
    expect(result).toHaveLength(DEFAULT_RETAINED_FRAME_LIMIT);
    expect(result.at(-1)).toBe(999_999);
    expect(result[0]).toBe(11);

    for (const maximum of [0, -1, 1.5, Number.NaN]) {
      expect(() => appendBoundedFrame([], 1, maximum)).toThrow(RangeError);
    }
  });
});

describe("family cycle policy", () => {
  it("advances deep to low to middle to high and wraps high to deep", () => {
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
      familyId: "deep",
      wrapped: true,
    });
  });

  it("rejects an unknown runtime family", () => {
    expect(() => advanceFamily("ultrasonic" as never)).toThrow(RangeError);
  });
});
