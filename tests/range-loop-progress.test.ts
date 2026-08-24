import { describe, expect, it } from "vitest";

import {
  availableTargets,
  buildFamilyQueue,
  buildProfileFamilyQueue,
  nextProfileFamily,
  normalizeProgress,
  parkMidiAcrossNoteSets,
  profileFamilyOrder,
  recheckMidisAcrossNoteSets,
  restoreMidiAsPending,
  type LoopProgress,
} from "../apps/web/src/features/range-loop/progress";
import {
  RANGE_FAMILIES,
  targetsForFamily,
  type FamilyNoteSet,
  type RangeFamilyId,
} from "../apps/web/src/features/range-loop/model";

function withFullyParkedFamilies(
  noteSet: FamilyNoteSet,
  familyIds: readonly RangeFamilyId[],
): LoopProgress {
  return normalizeProgress({
    [noteSet]: Object.fromEntries(
      familyIds.map((familyId) => [
        familyId,
        { parkedMidis: targetsForFamily(familyId, noteSet) },
      ]),
    ),
  });
}

describe("range-loop stored progress normalization", () => {
  it("turns missing and invalid stored values into bounded progress records", () => {
    const empty = normalizeProgress(null);
    for (const noteSet of ["natural", "chromatic"] as const) {
      for (const family of RANGE_FAMILIES) {
        expect(empty[noteSet][family.id]).toEqual({
          passedMidis: [],
          parkedMidis: [],
          cyclesCompleted: 0,
        });
      }
    }

    const normalized = normalizeProgress({
      natural: {
        low: {
          passedMidis: [48, 48, 49, 50, 60, 50.5, Number.NaN, "52"],
          parkedMidis: [50, 50, 51, 72, Number.POSITIVE_INFINITY],
          cyclesCompleted: 2.9,
        },
        middle: {
          passedMidis: "not-an-array",
          parkedMidis: {},
          cyclesCompleted: -4,
        },
        high: { cyclesCompleted: Number.POSITIVE_INFINITY },
      },
      chromatic: {
        low: {
          passedMidis: [48, 49, 49, 59, 60],
          parkedMidis: [59, 59, 60],
          cyclesCompleted: 3.8,
        },
      },
      unknown: { low: { passedMidis: [48] } },
    });

    expect(normalized.natural.low).toEqual({
      passedMidis: [48],
      parkedMidis: [50, 59],
      cyclesCompleted: 2,
    });
    expect(normalized.chromatic.low).toEqual({
      passedMidis: [48, 49],
      parkedMidis: [50, 59],
      cyclesCompleted: 3,
    });
    expect(normalized.natural.middle).toEqual({
      passedMidis: [],
      parkedMidis: [],
      cyclesCompleted: 0,
    });
    expect(normalized.natural.high.cyclesCompleted).toBe(0);
  });

  it("moves parked natural pitches across note sets but keeps accidentals chromatic-only", () => {
    const normalized = normalizeProgress({
      natural: {
        middle: {
          passedMidis: [60, 62, 64],
          parkedMidis: [60],
        },
      },
      chromatic: {
        middle: {
          passedMidis: [60, 61, 62, 63],
          parkedMidis: [61, 62],
        },
      },
    });

    expect(normalized.natural.middle).toMatchObject({
      passedMidis: [64],
      parkedMidis: [60, 62],
    });
    expect(normalized.chromatic.middle).toMatchObject({
      passedMidis: [63],
      parkedMidis: [60, 61, 62],
    });
  });

  it("resets a complete-but-unfinalized passed snapshot so it cannot restore an empty queue", () => {
    const naturalTargets = targetsForFamily("low", "natural");
    const chromaticTargets = targetsForFamily("middle", "chromatic");
    const normalized = normalizeProgress({
      natural: {
        low: {
          passedMidis: naturalTargets,
          parkedMidis: [],
          cyclesCompleted: 4,
        },
      },
      chromatic: {
        middle: {
          passedMidis: chromaticTargets.filter((midi) => midi !== 61),
          parkedMidis: [61],
          cyclesCompleted: 2,
        },
      },
    });

    expect(normalized.natural.low).toEqual({
      passedMidis: [],
      parkedMidis: [],
      cyclesCompleted: 4,
    });
    expect(normalized.chromatic.middle).toEqual({
      passedMidis: [],
      parkedMidis: [61],
      cyclesCompleted: 2,
    });
    expect(buildFamilyQueue(normalized, "natural", "low", "ascending"))
      .toEqual(naturalTargets);
    expect(buildFamilyQueue(normalized, "chromatic", "middle", "ascending"))
      .toEqual(chromaticTargets.filter((midi) => midi !== 61));
  });
});

describe("range-loop family queues", () => {
  it("builds ordered queues without passed or parked targets", () => {
    const progress = normalizeProgress({
      natural: {
        low: {
          passedMidis: [48, 52],
          parkedMidis: [55],
        },
      },
    });

    expect(buildFamilyQueue(progress, "natural", "low", "ascending"))
      .toEqual([50, 53, 57, 59]);
    expect(buildFamilyQueue(progress, "natural", "low", "descending"))
      .toEqual([59, 57, 53, 50]);
  });

  it("reports every non-parked target as available even if it already passed this lap", () => {
    const progress = normalizeProgress({
      chromatic: {
        middle: {
          passedMidis: [60, 61],
          parkedMidis: [62, 63],
        },
      },
    });

    expect(availableTargets(progress, "chromatic", "middle"))
      .toEqual([60, 61, 64, 65, 66, 67, 68, 69, 70, 71]);
  });

  it("orders every family outward from the baseline while preserving every available target", () => {
    const progress = normalizeProgress(null);

    for (const noteSet of ["natural", "chromatic"] as const) {
      for (const family of RANGE_FAMILIES) {
        for (const order of ["ascending", "descending", "shuffled"] as const) {
          const expectedTargets = targetsForFamily(family.id, noteSet);
          const queue = buildProfileFamilyQueue(progress, noteSet, family.id, order, 48);
          const distances = queue.map((midi) => Math.abs(midi - 48));

          expect(distances).toEqual([...distances].sort((left, right) => left - right));
          expect([...queue].sort((left, right) => left - right)).toEqual(expectedTargets);
        }
      }
    }
  });

  it("enters the family below C3 on its nearest note instead of jumping to the octave floor", () => {
    const progress = normalizeProgress(null);

    expect(buildProfileFamilyQueue(progress, "natural", "deep", "ascending", 48))
      .toEqual([47, 45, 43, 41, 40, 38, 36]);
    expect(buildProfileFamilyQueue(progress, "chromatic", "deep", "ascending", 48))
      .toEqual([47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36]);
  });

  it("uses the selected order only to break equal-distance ties around a baseline", () => {
    const progress = normalizeProgress(null);

    expect(buildProfileFamilyQueue(progress, "chromatic", "middle", "ascending", 64))
      .toEqual([64, 63, 65, 62, 66, 61, 67, 60, 68, 69, 70, 71]);
    expect(buildProfileFamilyQueue(progress, "chromatic", "middle", "descending", 64))
      .toEqual([64, 65, 63, 66, 62, 67, 61, 68, 60, 69, 70, 71]);
  });

  it("omits an accidental baseline from Natural but leads with it in Chromatic", () => {
    const progress = normalizeProgress(null);
    const natural = buildProfileFamilyQueue(progress, "natural", "low", "descending", 49);
    const chromatic = buildProfileFamilyQueue(progress, "chromatic", "low", "descending", 49);

    expect(natural).not.toContain(49);
    expect(natural[0]).toBe(50);
    expect(chromatic[0]).toBe(49);
    expect(chromatic.filter((midi) => midi === 49)).toHaveLength(1);
  });
});

describe("baseline-first progress restoration", () => {
  it("restores a natural baseline from passed and parked state across both note sets immutably", () => {
    const empty = normalizeProgress(null);
    const progress: LoopProgress = {
      natural: {
        ...empty.natural,
        low: {
          passedMidis: [48, 50],
          parkedMidis: [48, 52],
          cyclesCompleted: 2,
        },
      },
      chromatic: {
        ...empty.chromatic,
        low: {
          passedMidis: [48, 49],
          parkedMidis: [48, 51],
          cyclesCompleted: 3,
        },
      },
    };
    const originalNatural = {
      ...progress.natural.low,
      passedMidis: [...progress.natural.low.passedMidis],
      parkedMidis: [...progress.natural.low.parkedMidis],
    };
    const originalChromatic = {
      ...progress.chromatic.low,
      passedMidis: [...progress.chromatic.low.passedMidis],
      parkedMidis: [...progress.chromatic.low.parkedMidis],
    };

    const restored = restoreMidiAsPending(progress, "low", 48);

    expect(restored.natural.low).toEqual({
      passedMidis: [50],
      parkedMidis: [52],
      cyclesCompleted: 2,
    });
    expect(restored.chromatic.low).toEqual({
      passedMidis: [49],
      parkedMidis: [51],
      cyclesCompleted: 3,
    });
    expect(progress.natural.low).toEqual(originalNatural);
    expect(progress.chromatic.low).toEqual(originalChromatic);
    expect(buildProfileFamilyQueue(restored, "natural", "low", "descending", 48)[0]).toBe(48);
    expect(buildProfileFamilyQueue(restored, "chromatic", "low", "descending", 48)[0]).toBe(48);
  });

  it("restores an accidental baseline only in the note set that can train it", () => {
    const empty = normalizeProgress(null);
    const progress: LoopProgress = {
      natural: {
        ...empty.natural,
        low: { passedMidis: [48], parkedMidis: [50], cyclesCompleted: 1 },
      },
      chromatic: {
        ...empty.chromatic,
        low: { passedMidis: [49, 50], parkedMidis: [49, 51], cyclesCompleted: 2 },
      },
    };

    const restored = restoreMidiAsPending(progress, "low", 49);

    expect(restored.natural.low).toEqual(progress.natural.low);
    expect(restored.chromatic.low).toEqual({
      passedMidis: [50],
      parkedMidis: [51],
      cyclesCompleted: 2,
    });
    expect(buildProfileFamilyQueue(restored, "natural", "low", "ascending", 49)).not.toContain(49);
    expect(buildProfileFamilyQueue(restored, "chromatic", "low", "ascending", 49)[0]).toBe(49);
  });
});

describe("baseline-routed family progression", () => {
  it.each([
    [36, ["deep", "low", "middle", "high"]],
    [48, ["low", "deep", "middle", "high"]],
    [60, ["middle", "low", "deep", "high"]],
    [72, ["high", "middle", "low", "deep"]],
  ] as const)("routes outward from baseline MIDI %i", (baselineMidi, expectedOrder) => {
    expect(profileFamilyOrder(baselineMidi)).toEqual(expectedOrder);
  });

  it("cycles C3 through Low, Deep, Middle, High, then wraps to Low", () => {
    const progress = normalizeProgress(null);
    let familyId: RangeFamilyId = "low";
    const transitions = Array.from({ length: 4 }, () => {
      const next = nextProfileFamily(familyId, progress, "natural", "ascending", 48)!;
      familyId = next.familyId;
      return [next.familyId, next.wrapped] as const;
    });

    expect(transitions).toEqual([
      ["deep", false],
      ["middle", false],
      ["high", false],
      ["low", true],
    ]);
  });

  it("skips any family whose actual queue is empty and only selects a family with a target", () => {
    const empty = normalizeProgress(null);
    const progress: LoopProgress = {
      natural: {
        ...empty.natural,
        deep: {
          passedMidis: targetsForFamily("deep", "natural"),
          parkedMidis: [],
          cyclesCompleted: 0,
        },
        middle: {
          passedMidis: [],
          parkedMidis: targetsForFamily("middle", "natural"),
          cyclesCompleted: 0,
        },
      },
      chromatic: empty.chromatic,
    };

    const next = nextProfileFamily("low", progress, "natural", "descending", 48);

    expect(next).toEqual({ familyId: "high", wrapped: false });
    expect(buildProfileFamilyQueue(
      progress,
      "natural",
      next!.familyId,
      "descending",
      48,
    ).length).toBeGreaterThan(0);
  });

  it("returns null when every routed family is fully parked", () => {
    const progress = withFullyParkedFamilies(
      "natural",
      RANGE_FAMILIES.map((family) => family.id),
    );

    expect(nextProfileFamily("low", progress, "natural", "ascending", 48)).toBeNull();
  });
});

describe("range-loop cross-note-set parking", () => {
  it("parks a shared natural pitch in both note sets and removes prior passes", () => {
    const progress = normalizeProgress({
      natural: { middle: { passedMidis: [60, 62] } },
      chromatic: { middle: { passedMidis: [60, 61, 62] } },
    });

    const parked = parkMidiAcrossNoteSets(progress, "middle", 60);

    expect(parked.natural.middle).toMatchObject({
      passedMidis: [62],
      parkedMidis: [60],
    });
    expect(parked.chromatic.middle).toMatchObject({
      passedMidis: [61, 62],
      parkedMidis: [60],
    });
    expect(progress.natural.middle).toMatchObject({
      passedMidis: [60, 62],
      parkedMidis: [],
    });
  });

  it("parks an accidental only in the chromatic note set", () => {
    const progress = normalizeProgress({
      natural: { middle: { passedMidis: [60, 62] } },
      chromatic: { middle: { passedMidis: [60, 61, 62] } },
    });

    const parked = parkMidiAcrossNoteSets(progress, "middle", 61);

    expect(parked.natural.middle).toEqual(progress.natural.middle);
    expect(parked.chromatic.middle).toMatchObject({
      passedMidis: [60, 62],
      parkedMidis: [61],
    });
  });

  it("rechecks selected pitches across both note sets while retaining other parked notes", () => {
    const progress = normalizeProgress({
      natural: { middle: { parkedMidis: [60, 62, 64], cyclesCompleted: 2 } },
      chromatic: { middle: { parkedMidis: [60, 61, 62, 63, 64], cyclesCompleted: 3 } },
    });
    const originalNaturalParked = [...progress.natural.middle.parkedMidis];
    const originalChromaticParked = [...progress.chromatic.middle.parkedMidis];

    const rechecked = recheckMidisAcrossNoteSets(
      progress,
      "middle",
      new Set([60, 61, 64]),
    );

    expect(rechecked.natural.middle).toEqual({
      passedMidis: [],
      parkedMidis: [62],
      cyclesCompleted: 2,
    });
    expect(rechecked.chromatic.middle).toEqual({
      passedMidis: [],
      parkedMidis: [62, 63],
      cyclesCompleted: 3,
    });
    expect(progress.natural.middle.parkedMidis).toEqual(originalNaturalParked);
    expect(progress.chromatic.middle.parkedMidis).toEqual(originalChromaticParked);
  });
});
