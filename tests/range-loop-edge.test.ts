import { describe, expect, it } from "vitest";

import {
  advanceFamily,
  createFamilyTargetSequence,
  orderTargets,
  rangeFamilyForMidi,
  targetsForFamily,
  type RangeFamilyId,
} from "../apps/web/src/features/range-loop/model";

describe("range-loop target-sequence edges", () => {
  it("keeps curriculum-edge MIDI values in the nearest range family", () => {
    expect(rangeFamilyForMidi(0)).toBe("foundation");
    expect(rangeFamilyForMidi(35)).toBe("foundation");
    expect(rangeFamilyForMidi(36)).toBe("deep");
    expect(rangeFamilyForMidi(83)).toBe("high");
    expect(rangeFamilyForMidi(84)).toBe("upper");
    expect(rangeFamilyForMidi(127)).toBe("upper");
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
      ["upper", false],
      ["foundation", true],
      ["deep", false],
      ["low", false],
      ["middle", false],
      ["high", false],
    ]);
  });
});
