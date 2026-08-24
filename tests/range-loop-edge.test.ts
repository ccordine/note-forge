import { describe, expect, it } from "vitest";

import {
  advanceFamily,
  createFamilyTargetSequence,
  createSupportPlan,
  createSustainTracker,
  orderTargets,
  rangeFamilyForMidi,
  targetsForFamily,
  updateSustainTracker,
  type RangeFamilyId,
  type SustainFrame,
  type SustainTrackerState,
} from "../apps/web/src/features/range-loop/model";

const frame = (
  timeSeconds: number,
  midiFloat: number | null,
  overrides: Partial<SustainFrame> = {},
): SustainFrame => ({
  timeSeconds,
  midiFloat,
  confidence: midiFloat === null ? 0 : 0.95,
  voiced: midiFloat !== null,
  ...overrides,
});

const feed = (
  tracker: SustainTrackerState,
  ...frames: SustainFrame[]
): SustainTrackerState => frames.reduce(updateSustainTracker, tracker);

describe("range-loop target-sequence edges", () => {
  it("keeps curriculum-edge MIDI values in the nearest range family", () => {
    expect(rangeFamilyForMidi(0)).toBe("deep");
    expect(rangeFamilyForMidi(35)).toBe("deep");
    expect(rangeFamilyForMidi(36)).toBe("deep");
    expect(rangeFamilyForMidi(83)).toBe("high");
    expect(rangeFamilyForMidi(84)).toBe("high");
    expect(rangeFamilyForMidi(127)).toBe("high");
  });

  it("returns isolated family arrays and fresh default sequences", () => {
    const familyTargets = targetsForFamily("middle");
    const defaultSequence = createFamilyTargetSequence({ familyId: "middle" });
    familyTargets[0] = 999;
    defaultSequence[1] = 998;

    expect(targetsForFamily("middle")).toEqual([60, 62, 64, 65, 67, 69, 71]);
    expect(createFamilyTargetSequence({ familyId: "middle" }))
      .toEqual([60, 62, 64, 65, 67, 69, 71]);
  });

  it("does not consume randomness when ordering requires no shuffle work", () => {
    const unusedRng = () => {
      throw new Error("RNG should not be called");
    };

    expect(orderTargets([3, 1, 2], "ascending", unusedRng)).toEqual([1, 2, 3]);
    expect(orderTargets([3, 1, 2], "descending", unusedRng)).toEqual([3, 2, 1]);
    expect(orderTargets([], "shuffled", unusedRng)).toEqual([]);
    expect(orderTargets([42], "shuffled", unusedRng)).toEqual([42]);
  });

  it("still validates a shuffled random source when no swaps are needed", () => {
    expect(() => orderTargets([], "shuffled", null as never)).toThrow(TypeError);
    expect(() => orderTargets([42], "shuffled", 0.5 as never)).toThrow(TypeError);
  });
});

describe("range-loop support boundaries", () => {
  it.each([
    ["unison", 0],
    ["major-third", 4],
    ["perfect-fifth", 7],
    ["octave", 12],
  ] as const)("allows %s support exactly at MIDI zero", (mode, vocalTargetMidi) => {
    expect(createSupportPlan(vocalTargetMidi, mode)).toMatchObject({
      mode,
      vocalTargetMidi,
      guideMidi: 0,
    });
  });

  it("keeps both solo and assisted plans valid at the upper MIDI boundary", () => {
    expect(createSupportPlan(127, "solo")).toMatchObject({
      vocalTargetMidi: 127,
      guideMidi: null,
    });
    expect(createSupportPlan(127, "octave")).toMatchObject({
      vocalTargetMidi: 127,
      guideMidi: 115,
    });
  });
});

describe("range-loop sustain state edges", () => {
  it("is immutable and clamps a cadence overshoot to exact completion", () => {
    const initial = createSustainTracker({
      targetMidi: 60,
      requiredHoldSeconds: 0.15,
      toleranceCents: 20,
      listeningStartedAtSeconds: 0,
      graceSeconds: 0.5,
    });
    const started = updateSustainTracker(initial, frame(0, 60));
    const complete = updateSustainTracker(started, frame(0.2, 60));

    expect(initial).toMatchObject({ status: "waiting", heldSeconds: 0, progress: 0 });
    expect(started).toMatchObject({ status: "holding", heldSeconds: 0, progress: 0 });
    expect(complete).toMatchObject({
      status: "complete",
      heldSeconds: 0.15,
      progress: 1,
    });
    expect(complete).not.toBe(started);
  });

  it("treats non-finite confidence as a dropout and resumes without crediting it", () => {
    let tracker = createSustainTracker({
      targetMidi: 60,
      requiredHoldSeconds: 0.3,
      toleranceCents: 20,
      listeningStartedAtSeconds: 0,
      graceSeconds: 0.22,
    });

    tracker = feed(tracker, frame(0, 60), frame(0.1, 60));
    tracker = updateSustainTracker(tracker, frame(0.2, 60, { confidence: Number.NaN }));
    expect(tracker).toMatchObject({ status: "holding", heldSeconds: 0.1, inGrace: true });

    tracker = updateSustainTracker(tracker, frame(0.21, 60));
    expect(tracker.heldSeconds).toBeCloseTo(0.1, 10);
    tracker = feed(tracker, frame(0.31, 60), frame(0.41, 60));
    expect(tracker).toMatchObject({ status: "complete", progress: 1 });
  });

  it("cannot backfill target time with a late frame after a newer guide frame", () => {
    const initial = createSustainTracker({
      targetMidi: 64,
      requiredHoldSeconds: 0.2,
      toleranceCents: 20,
      listeningStartedAtSeconds: 0,
    });
    const afterGuide = updateSustainTracker(initial, frame(1, 60));
    const lateTarget = updateSustainTracker(afterGuide, frame(0.9, 64));

    expect(lateTarget).toBe(afterGuide);
    const started = updateSustainTracker(lateTarget, frame(1.1, 64));
    expect(started).toMatchObject({
      status: "holding",
      heldSeconds: 0,
      runStartedAtSeconds: 1.1,
    });
  });

  it("supports the maximum confidence and MIDI boundaries", () => {
    let tracker = createSustainTracker({
      targetMidi: 127,
      requiredHoldSeconds: 0.1,
      toleranceCents: 1,
      listeningStartedAtSeconds: 0,
      minimumConfidence: 1,
    });
    tracker = feed(
      tracker,
      frame(0, 127, { confidence: 1 }),
      frame(0.1, 127, { confidence: 1 }),
    );
    expect(tracker.status).toBe("complete");

    expect(() => createSustainTracker({
      targetMidi: 0,
      requiredHoldSeconds: 0.1,
      toleranceCents: 1,
      listeningStartedAtSeconds: 0,
      minimumConfidence: 0,
    })).not.toThrow();
  });

  it("does not fabricate elapsed hold time when grace is explicitly zero", () => {
    const tracker = feed(
      createSustainTracker({
        targetMidi: 60,
        requiredHoldSeconds: 0.1,
        toleranceCents: 20,
        listeningStartedAtSeconds: 0,
        graceSeconds: 0,
      }),
      frame(0, 60),
      frame(0.01, 60),
      frame(0.02, 60),
    );

    expect(tracker).toMatchObject({ status: "holding", heldSeconds: 0, progress: 0 });
    expect(tracker.runStartedAtSeconds).toBe(0.02);
  });
});

describe("range-loop repeated progression", () => {
  it("continues across multiple family wraps without entering a terminal state", () => {
    let familyId: RangeFamilyId = "deep";
    const transitions = Array.from({ length: 9 }, () => {
      const transition = advanceFamily(familyId);
      familyId = transition.familyId;
      return [transition.familyId, transition.wrapped] as const;
    });

    expect(transitions).toEqual([
      ["low", false],
      ["middle", false],
      ["high", false],
      ["deep", true],
      ["low", false],
      ["middle", false],
      ["high", false],
      ["deep", true],
      ["low", false],
    ]);
  });
});
