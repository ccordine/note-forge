import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASELINE_MIDI,
  RANGE_PROFILE_MAX_MIDI,
  RANGE_PROFILE_MIN_MIDI,
  VOCAL_PROFILE_STORAGE_KEY,
  createDefaultRangeProfile,
  normalizeRangeProfile,
  rangeBoundsForMidis,
  setRangeProfileBaseline,
  toggleRegisterShift,
  usableRangeBounds,
} from "../apps/web/src/features/range-loop/profile";

describe("personal range profile", () => {
  it("starts with a neutral C3 baseline and no fabricated usable range", () => {
    expect(DEFAULT_BASELINE_MIDI).toBe(48);
    expect(VOCAL_PROFILE_STORAGE_KEY).toBe("hum.vocal-profile");
    expect(createDefaultRangeProfile()).toEqual({
      baseline: { midi: 48, source: "default", updatedAt: null },
      usableMidis: [],
      registerShifts: [],
    });
  });

  it("returns independent defaults and validates the starting anchor", () => {
    const first = createDefaultRangeProfile();
    const second = createDefaultRangeProfile();
    first.usableMidis.push(48);

    expect(second.usableMidis).toEqual([]);
    expect(createDefaultRangeProfile(52).baseline.midi).toBe(52);
    for (const invalid of [29, 48.5, 87, Number.NaN]) {
      expect(() => createDefaultRangeProfile(invalid)).toThrow(RangeError);
    }
  });

  it("changes baseline provenance immutably and canonicalizes its timestamp", () => {
    const profile = {
      ...createDefaultRangeProfile(),
      usableMidis: [47, 48, 49],
    };
    const changed = setRangeProfileBaseline(
      profile,
      50,
      "hum-anchor",
      "2026-08-22T08:30:00-04:00",
    );

    expect(changed).toEqual({
      baseline: {
        midi: 50,
        source: "hum-anchor",
        updatedAt: "2026-08-22T12:30:00.000Z",
      },
      usableMidis: [47, 48, 49],
      registerShifts: [],
    });
    expect(profile.baseline).toEqual({ midi: 48, source: "default", updatedAt: null });
    expect(changed.usableMidis).toBe(profile.usableMidis);
  });

  it("rejects invalid baseline MIDI, provenance, and timestamps", () => {
    const profile = createDefaultRangeProfile();
    expect(() => setRangeProfileBaseline(profile, 29)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 87)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 48.25)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 48, "imported" as never)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 48, "manual", "not-a-date")).toThrow(RangeError);
  });
});

describe("range-profile normalization", () => {
  it("falls back safely for absent and non-object persisted values", () => {
    const expected = createDefaultRangeProfile();
    for (const candidate of [null, undefined, "corrupt", []]) {
      expect(normalizeRangeProfile(candidate)).toEqual(expected);
    }
  });

  it("normalizes only current authority and drops obsolete stored fields", () => {
    const normalized = normalizeRangeProfile({
      baseline: {
        midi: 50,
        source: "hum-anchor",
        updatedAt: "2026-08-22T08:30:00-04:00",
      },
      usableMidis: [83, 36, 48, 36, 35, 84, 48.5, "52"],
      registerShifts: [
        { midi: 64, ascending: true, descending: false },
        { midi: 60, ascending: true, descending: false },
        { midi: 60, ascending: false, descending: true },
        { midi: 62, ascending: false, descending: false },
        { midi: 35, ascending: true, descending: true },
      ],
      obsoleteHistory: { 48: [{ score: 12 }] },
      ignored: "field",
    });

    expect(normalized).toEqual({
      baseline: {
        midi: 50,
        source: "hum-anchor",
        updatedAt: "2026-08-22T12:30:00.000Z",
      },
      usableMidis: [35, 36, 48, 83, 84],
      registerShifts: [
        { midi: 35, ascending: true, descending: true },
        { midi: 60, ascending: true, descending: true },
        { midi: 64, ascending: true, descending: false },
      ],
    });
    expect(normalizeRangeProfile(normalized)).toEqual(normalized);
  });

  it("uses the default baseline fields when persisted baseline data is malformed", () => {
    expect(normalizeRangeProfile({
      baseline: { midi: 60.5, source: "guessed", updatedAt: "yesterday" },
    }).baseline).toEqual({ midi: 48, source: "default", updatedAt: null });
  });
});

describe("usable bounds and register shifts", () => {
  it("computes profile-bounded extrema without widening from invalid values", () => {
    expect(rangeBoundsForMidis([83, 48, 36, 60, 35, 84, 48.5, Number.NaN]))
      .toEqual({ lowMidi: 35, highMidi: 84 });
    expect(rangeBoundsForMidis([29, 87, Number.NaN]))
      .toEqual({ lowMidi: null, highMidi: null });
    expect(usableRangeBounds({
      ...createDefaultRangeProfile(),
      usableMidis: [46, 47, 48, 49],
    })).toEqual({ lowMidi: 46, highMidi: 49 });
  });

  it("tracks ascending and descending register shifts independently", () => {
    let profile = createDefaultRangeProfile();
    profile = toggleRegisterShift(profile, 60, "ascending");
    profile = toggleRegisterShift(profile, 55, "descending");
    profile = toggleRegisterShift(profile, 60, "descending");
    expect(profile.registerShifts).toEqual([
      { midi: 55, ascending: false, descending: true },
      { midi: 60, ascending: true, descending: true },
    ]);

    profile = toggleRegisterShift(profile, 60, "ascending");
    profile = toggleRegisterShift(profile, 60, "descending");
    expect(profile.registerShifts).toEqual([
      { midi: 55, ascending: false, descending: true },
    ]);
  });

  it("accepts profile boundaries and rejects invalid shift markers", () => {
    let profile = createDefaultRangeProfile();
    profile = toggleRegisterShift(profile, RANGE_PROFILE_MIN_MIDI, "ascending");
    profile = toggleRegisterShift(profile, RANGE_PROFILE_MAX_MIDI, "descending");
    expect(profile.registerShifts).toHaveLength(2);
    expect(() => toggleRegisterShift(profile, 48.5, "ascending")).toThrow(RangeError);
    expect(() => toggleRegisterShift(profile, 48, "sideways" as never)).toThrow(RangeError);
  });
});
