import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASELINE_MIDI,
  MAXIMUM_OBSERVATIONS_PER_NOTE,
  MINIMUM_EDGE_OBSERVATIONS,
  RANGE_PROFILE_MAX_MIDI,
  RANGE_PROFILE_MIN_MIDI,
  VOCAL_PROFILE_STORAGE_KEY,
  cleanStableBounds,
  createDefaultRangeProfile,
  manualAccuracyEdges,
  normalizeRangeProfile,
  pitchStableBounds,
  rangeBoundsForMidis,
  recordRangeEvidence,
  setRangeProfileBaseline,
  suggestedAccuracyEdges,
  summarizeRangeEvidence,
  toggleProfileObservation,
  toggleRegisterShift,
  type PersonalRangeProfile,
  type RangeEvidenceInput,
} from "../apps/web/src/features/range-loop/profile";

const BASE_TIME_MS = Date.parse("2026-08-22T12:00:00.000Z");
const REQUIRED_HOLD_MS = 3_000;

function evidenceInput(
  midi: number,
  overrides: Partial<RangeEvidenceInput> = {},
): RangeEvidenceInput {
  return {
    midi,
    supportMode: "solo",
    toleranceCents: 20,
    requiredHoldMs: REQUIRED_HOLD_MS,
    resetCount: 0,
    timeToAcquireMs: 500,
    medianErrorCents: 4,
    stabilityCents: 5,
    observedAt: new Date(BASE_TIME_MS).toISOString(),
    ...overrides,
  };
}

function addSamples(
  profile: PersonalRangeProfile,
  midi: number,
  count: number,
  overrides: Partial<RangeEvidenceInput> = {},
): PersonalRangeProfile {
  let next = profile;
  const existingCount = profile.evidenceByMidi[String(midi)]?.length ?? 0;
  for (let index = 0; index < count; index += 1) {
    next = recordRangeEvidence(next, evidenceInput(midi, {
      ...overrides,
      observedAt: new Date(BASE_TIME_MS + (existingCount + index) * 1_000).toISOString(),
    }));
  }
  return next;
}

describe("personal range-profile defaults and baseline", () => {
  it("starts at C3 without claiming that the default anchor proves a stable range", () => {
    const profile = createDefaultRangeProfile();

    expect(DEFAULT_BASELINE_MIDI).toBe(48);
    expect(VOCAL_PROFILE_STORAGE_KEY).toBe("hum.vocal-profile");
    expect(profile).toEqual({
      baseline: { midi: 48, source: "default", updatedAt: null },
      cleanStableMidis: [],
      accuracyChallengeMidis: [],
      registerShifts: [],
      evidenceByMidi: {},
    });
    expect(pitchStableBounds(profile)).toEqual({ lowMidi: null, highMidi: null });
    expect(cleanStableBounds(profile)).toEqual({ lowMidi: null, highMidi: null });
    expect(manualAccuracyEdges(profile)).toEqual({ lowMidi: null, highMidi: null });
  });

  it("returns independent defaults and accepts a validated custom starting anchor", () => {
    const first = createDefaultRangeProfile();
    const second = createDefaultRangeProfile();
    first.cleanStableMidis.push(48);

    expect(second.cleanStableMidis).toEqual([]);
    expect(createDefaultRangeProfile(52).baseline).toEqual({
      midi: 52,
      source: "default",
      updatedAt: null,
    });
    expect(() => createDefaultRangeProfile(35)).toThrow(RangeError);
    expect(() => createDefaultRangeProfile(48.5)).toThrow(RangeError);
    expect(() => createDefaultRangeProfile(84)).toThrow(RangeError);
  });

  it("changes the baseline immutably, records its provenance, and canonicalizes its timestamp", () => {
    const profile = addSamples(createDefaultRangeProfile(), 48, 1);
    const changed = setRangeProfileBaseline(
      profile,
      50,
      "hum-anchor",
      "2026-08-22T08:30:00-04:00",
    );

    expect(changed.baseline).toEqual({
      midi: 50,
      source: "hum-anchor",
      updatedAt: "2026-08-22T12:30:00.000Z",
    });
    expect(changed.evidenceByMidi).toBe(profile.evidenceByMidi);
    expect(profile.baseline).toEqual({ midi: 48, source: "default", updatedAt: null });
  });

  it("reinterprets manual accuracy edges around a new baseline without deleting observations", () => {
    let profile = createDefaultRangeProfile();
    for (const midi of [46, 48, 50, 52]) {
      profile = toggleProfileObservation(profile, "accuracy", midi);
    }
    expect(manualAccuracyEdges(profile)).toEqual({ lowMidi: 46, highMidi: 50 });

    const moved = setRangeProfileBaseline(profile, 51, "manual", "2026-08-22T12:00:00Z");
    expect(manualAccuracyEdges(moved)).toEqual({ lowMidi: 50, highMidi: 52 });
    expect(moved.accuracyChallengeMidis).toEqual([46, 48, 50, 52]);
  });

  it("rejects invalid baseline MIDI, provenance, and timestamps", () => {
    const profile = createDefaultRangeProfile();

    expect(() => setRangeProfileBaseline(profile, 35)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 84)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 48.25)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 48, "imported" as never)).toThrow(RangeError);
    expect(() => setRangeProfileBaseline(profile, 48, "manual", "not-a-date")).toThrow(RangeError);
  });
});

describe("personal range-profile normalization", () => {
  it("falls back safely for absent or non-object persisted values", () => {
    const expected = createDefaultRangeProfile();

    expect(normalizeRangeProfile(null)).toEqual(expected);
    expect(normalizeRangeProfile(undefined)).toEqual(expected);
    expect(normalizeRangeProfile("corrupt")).toEqual(expected);
    expect(normalizeRangeProfile([])).toEqual(expected);
  });

  it("sanitizes, sorts, deduplicates, and canonicalizes a persisted profile", () => {
    const candidate = {
      baseline: {
        midi: 50,
        source: "hum-anchor",
        updatedAt: "2026-08-22T08:30:00-04:00",
      },
      cleanStableMidis: [83, 36, 48, 36, 35, 84, 48.5, "52"],
      accuracyChallengeMidis: [55, 44, 55, -1, 128, Number.NaN],
      registerShifts: [
        { midi: 64, ascending: true, descending: false },
        { midi: 60, ascending: true, descending: false },
        { midi: 60, ascending: false, descending: true },
        { midi: 62, ascending: false, descending: false },
        { midi: 35, ascending: true, descending: true },
      ],
      evidenceByMidi: {
        48: [
          {
            supportMode: "solo",
            toleranceCents: 20,
            requiredHoldMs: REQUIRED_HOLD_MS,
            resetCount: 2,
            timeToAcquireMs: 900,
            absoluteCenterErrorCents: -1,
            stabilityCents: Number.NaN,
            observedAt: "2026-08-22T08:30:02-04:00",
          },
          {
            supportMode: "octave",
            toleranceCents: 25,
            requiredHoldMs: REQUIRED_HOLD_MS,
            resetCount: 1,
            timeToAcquireMs: 700,
            absoluteCenterErrorCents: 6,
            stabilityCents: 8,
            observedAt: "2026-08-22T08:30:01-04:00",
          },
          {
            supportMode: "unison",
            toleranceCents: 20,
            requiredHoldMs: REQUIRED_HOLD_MS,
            resetCount: 0,
            timeToAcquireMs: 200,
            observedAt: "2026-08-22T12:30:00Z",
          },
        ],
        35: [{
          supportMode: "solo",
          toleranceCents: 20,
          requiredHoldMs: REQUIRED_HOLD_MS,
          resetCount: 0,
          timeToAcquireMs: 200,
          observedAt: "2026-08-22T12:30:00Z",
        }],
        60: "not-an-array",
      },
      ignored: "field",
    };

    const normalized = normalizeRangeProfile(candidate);

    expect(normalized).toEqual({
      baseline: {
        midi: 50,
        source: "hum-anchor",
        updatedAt: "2026-08-22T12:30:00.000Z",
      },
      cleanStableMidis: [36, 48, 83],
      accuracyChallengeMidis: [44, 55],
      registerShifts: [
        { midi: 60, ascending: true, descending: true },
        { midi: 64, ascending: true, descending: false },
      ],
      evidenceByMidi: {
        48: [
          {
            supportMode: "unison",
            toleranceCents: 20,
            requiredHoldMs: REQUIRED_HOLD_MS,
            resetCount: 0,
            timeToAcquireMs: 200,
            absoluteCenterErrorCents: undefined,
            stabilityCents: undefined,
            observedAt: "2026-08-22T12:30:00.000Z",
          },
          {
            supportMode: "octave",
            toleranceCents: 25,
            requiredHoldMs: REQUIRED_HOLD_MS,
            resetCount: 1,
            timeToAcquireMs: 700,
            absoluteCenterErrorCents: 6,
            stabilityCents: 8,
            observedAt: "2026-08-22T12:30:01.000Z",
          },
          {
            supportMode: "solo",
            toleranceCents: 20,
            requiredHoldMs: REQUIRED_HOLD_MS,
            resetCount: 2,
            timeToAcquireMs: 900,
            absoluteCenterErrorCents: undefined,
            stabilityCents: undefined,
            observedAt: "2026-08-22T12:30:02.000Z",
          },
        ],
      },
    });
    expect(normalizeRangeProfile(normalized)).toEqual(normalized);
  });

  it("uses C3 and default provenance for malformed baseline fields", () => {
    expect(normalizeRangeProfile({
      baseline: { midi: 60.5, source: "guessed", updatedAt: "yesterday" },
    }).baseline).toEqual({ midi: 48, source: "default", updatedAt: null });
  });

  it("retains only the newest bounded observations in chronological order", () => {
    const observations = Array.from(
      { length: MAXIMUM_OBSERVATIONS_PER_NOTE + 3 },
      (_, index) => ({
        supportMode: "solo",
        toleranceCents: 20,
        requiredHoldMs: REQUIRED_HOLD_MS,
        resetCount: index,
        timeToAcquireMs: index * 100,
        observedAt: new Date(BASE_TIME_MS + index * 1_000).toISOString(),
      }),
    ).reverse();

    const normalized = normalizeRangeProfile({ evidenceByMidi: { 48: observations } });
    const retained = normalized.evidenceByMidi["48"]!;

    expect(retained).toHaveLength(MAXIMUM_OBSERVATIONS_PER_NOTE);
    expect(retained.map((observation) => observation.resetCount)).toEqual(
      Array.from({ length: MAXIMUM_OBSERVATIONS_PER_NOTE }, (_, index) => index + 3),
    );
  });

  it("rejects noncanonical persisted MIDI keys instead of preserving aliases", () => {
    const first = {
      supportMode: "solo",
      toleranceCents: 20,
      requiredHoldMs: REQUIRED_HOLD_MS,
      resetCount: 1,
      timeToAcquireMs: 500,
      observedAt: new Date(BASE_TIME_MS).toISOString(),
    };
    const second = {
      ...first,
      resetCount: 2,
      observedAt: new Date(BASE_TIME_MS + 1_000).toISOString(),
    };

    const normalized = normalizeRangeProfile({
      evidenceByMidi: { "048": [first], "48.0": [second] },
    });

    expect(normalized.evidenceByMidi).toEqual({});
    expect(normalizeRangeProfile(normalized)).toEqual(normalized);
  });
});

describe("range evidence recording and summaries", () => {
  it("records successful hold evidence immutably and converts signed error to magnitude", () => {
    const profile = createDefaultRangeProfile();
    const recorded = recordRangeEvidence(profile, evidenceInput(48, {
      resetCount: 2,
      timeToAcquireMs: 1_250,
      medianErrorCents: -7,
      stabilityCents: 9,
      observedAt: "2026-08-22T08:30:00-04:00",
    }));

    expect(profile.evidenceByMidi).toEqual({});
    expect(recorded).not.toBe(profile);
    expect(recorded.evidenceByMidi).not.toBe(profile.evidenceByMidi);
    expect(recorded.evidenceByMidi["48"]).toEqual([{
      supportMode: "solo",
      toleranceCents: 20,
      requiredHoldMs: REQUIRED_HOLD_MS,
      resetCount: 2,
      timeToAcquireMs: 1_250,
      absoluteCenterErrorCents: 7,
      stabilityCents: 9,
      observedAt: "2026-08-22T12:30:00.000Z",
    }]);
    expect(pitchStableBounds(recorded)).toEqual({ lowMidi: 48, highMidi: 48 });
  });

  it("expands proven pitch bounds only when successful evidence is explicitly recorded", () => {
    let profile = createDefaultRangeProfile();
    profile = recordRangeEvidence(profile, evidenceInput(48));
    profile = recordRangeEvidence(profile, evidenceInput(RANGE_PROFILE_MIN_MIDI));
    profile = recordRangeEvidence(profile, evidenceInput(RANGE_PROFILE_MAX_MIDI));

    expect(pitchStableBounds(profile)).toEqual({
      lowMidi: RANGE_PROFILE_MIN_MIDI,
      highMidi: RANGE_PROFILE_MAX_MIDI,
    });
    expect(profile.baseline.midi).toBe(48);
    expect(cleanStableBounds(profile)).toEqual({ lowMidi: null, highMidi: null });
  });

  it("keeps observations isolated by physical MIDI and keeps only the newest cap", () => {
    let profile = createDefaultRangeProfile();
    for (let index = MAXIMUM_OBSERVATIONS_PER_NOTE + 2; index >= 0; index -= 1) {
      profile = recordRangeEvidence(profile, evidenceInput(48, {
        resetCount: index,
        timeToAcquireMs: index * 100,
        observedAt: new Date(BASE_TIME_MS + index * 1_000).toISOString(),
      }));
    }
    profile = recordRangeEvidence(profile, evidenceInput(50, { resetCount: 99 }));

    expect(profile.evidenceByMidi["48"]).toHaveLength(MAXIMUM_OBSERVATIONS_PER_NOTE);
    expect(profile.evidenceByMidi["48"]!.map((item) => item.resetCount)).toEqual(
      Array.from({ length: MAXIMUM_OBSERVATIONS_PER_NOTE }, (_, index) => index + 3),
    );
    expect(profile.evidenceByMidi["50"]).toHaveLength(1);
  });

  it("keeps a separate bounded history for each support, tolerance, and hold duration", () => {
    let profile = createDefaultRangeProfile();
    for (let index = 0; index < MAXIMUM_OBSERVATIONS_PER_NOTE + 2; index += 1) {
      profile = recordRangeEvidence(profile, evidenceInput(48, {
        supportMode: "solo",
        toleranceCents: 20,
        requiredHoldMs: 3_000,
        resetCount: index,
        observedAt: new Date(BASE_TIME_MS + index * 1_000).toISOString(),
      }));
      profile = recordRangeEvidence(profile, evidenceInput(48, {
        supportMode: "octave",
        toleranceCents: 10,
        requiredHoldMs: 5_000,
        resetCount: index,
        observedAt: new Date(BASE_TIME_MS + 50_000 + index * 1_000).toISOString(),
      }));
    }

    expect(profile.evidenceByMidi["48"]).toHaveLength(MAXIMUM_OBSERVATIONS_PER_NOTE * 2);
    expect(summarizeRangeEvidence(profile, 48, "solo", 20, 3_000)?.observationCount).toBe(MAXIMUM_OBSERVATIONS_PER_NOTE);
    expect(summarizeRangeEvidence(profile, 48, "octave", 10, 5_000)?.observationCount).toBe(MAXIMUM_OBSERVATIONS_PER_NOTE);
  });

  it("keeps evidence from different hold durations out of comparable summaries", () => {
    let profile = createDefaultRangeProfile();
    profile = recordRangeEvidence(profile, evidenceInput(48, { requiredHoldMs: 1_500 }));
    profile = recordRangeEvidence(profile, evidenceInput(48, {
      requiredHoldMs: 8_000,
      observedAt: new Date(BASE_TIME_MS + 1_000).toISOString(),
    }));

    expect(summarizeRangeEvidence(profile, 48, "solo", 20, 1_500)?.observationCount).toBe(1);
    expect(summarizeRangeEvidence(profile, 48, "solo", 20, 8_000)?.observationCount).toBe(1);
  });

  it("summarizes matching mode and tolerance while using separate optional-metric denominators", () => {
    let profile = createDefaultRangeProfile();
    profile = recordRangeEvidence(profile, evidenceInput(48, {
      resetCount: 0,
      timeToAcquireMs: 500,
      medianErrorCents: -10,
      stabilityCents: 4,
    }));
    profile = recordRangeEvidence(profile, evidenceInput(48, {
      resetCount: 1,
      timeToAcquireMs: 1_000,
      medianErrorCents: undefined,
      stabilityCents: undefined,
      observedAt: new Date(BASE_TIME_MS + 1_000).toISOString(),
    }));
    profile = recordRangeEvidence(profile, evidenceInput(48, {
      resetCount: 2,
      timeToAcquireMs: 1_500,
      medianErrorCents: 20,
      stabilityCents: 8,
      observedAt: new Date(BASE_TIME_MS + 2_000).toISOString(),
    }));
    profile = recordRangeEvidence(profile, evidenceInput(48, {
      supportMode: "octave",
      resetCount: 50,
      timeToAcquireMs: 50_000,
      observedAt: new Date(BASE_TIME_MS + 3_000).toISOString(),
    }));
    profile = recordRangeEvidence(profile, evidenceInput(48, {
      toleranceCents: 20.5,
      resetCount: 50,
      timeToAcquireMs: 50_000,
      observedAt: new Date(BASE_TIME_MS + 4_000).toISOString(),
    }));

    expect(summarizeRangeEvidence(profile, 48, "solo", 20, REQUIRED_HOLD_MS)).toEqual({
      observationCount: 3,
      averageResets: 1,
      averageAcquireMs: 1_000,
      centerErrorSampleCount: 2,
      averageAbsoluteCenterErrorCents: 15,
      stabilitySampleCount: 2,
      averageStabilityCents: 6,
    });
    expect(summarizeRangeEvidence(profile, 48, "major-third", 20, REQUIRED_HOLD_MS)).toBeNull();
    expect(summarizeRangeEvidence(profile, 50, "solo", 20, REQUIRED_HOLD_MS)).toBeNull();
  });

  it("includes tolerance values inside half a cent but excludes the exact half-cent boundary", () => {
    let profile = createDefaultRangeProfile();
    profile = recordRangeEvidence(profile, evidenceInput(48, { toleranceCents: 19.51 }));
    profile = recordRangeEvidence(profile, evidenceInput(48, {
      toleranceCents: 19.5,
      observedAt: new Date(BASE_TIME_MS + 1_000).toISOString(),
    }));

    expect(summarizeRangeEvidence(profile, 48, "solo", 20, REQUIRED_HOLD_MS)?.observationCount).toBe(1);
  });

  it("validates the support and tolerance conditions used by summaries and suggestions", () => {
    const profile = createDefaultRangeProfile();

    expect(() => summarizeRangeEvidence(profile, 48, "duet" as never, 20, REQUIRED_HOLD_MS)).toThrow(RangeError);
    expect(() => summarizeRangeEvidence(profile, 48, "solo", 0, REQUIRED_HOLD_MS)).toThrow(RangeError);
    expect(() => summarizeRangeEvidence(profile, 48, "solo", 101, REQUIRED_HOLD_MS)).toThrow(RangeError);
    expect(() => suggestedAccuracyEdges(profile, "octave", Number.NaN, REQUIRED_HOLD_MS)).toThrow(RangeError);
  });

  it("rejects invalid MIDI, mode, tolerances, counts, metrics, and timestamps", () => {
    const profile = createDefaultRangeProfile();
    const record = (overrides: Partial<RangeEvidenceInput>) => recordRangeEvidence(
      profile,
      evidenceInput(48, overrides),
    );

    expect(() => record({ midi: 35 })).toThrow(RangeError);
    expect(() => record({ midi: 83.5 })).toThrow(RangeError);
    expect(() => record({ supportMode: "duet" as never })).toThrow(RangeError);
    expect(() => record({ toleranceCents: 0 })).toThrow(RangeError);
    expect(() => record({ toleranceCents: 101 })).toThrow(RangeError);
    expect(() => record({ requiredHoldMs: 0 })).toThrow(RangeError);
    expect(() => record({ requiredHoldMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => record({ resetCount: -1 })).toThrow(RangeError);
    expect(() => record({ resetCount: 1.5 })).toThrow(RangeError);
    expect(() => record({ timeToAcquireMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => record({ medianErrorCents: Number.NaN })).toThrow(RangeError);
    expect(() => record({ stabilityCents: -1 })).toThrow(RangeError);
    expect(() => record({ observedAt: "not-a-date" })).toThrow(RangeError);
  });
});

describe("manual observations, bounds, and register shifts", () => {
  it("toggles clean and accuracy observations independently, immutably, and in MIDI order", () => {
    const initial = createDefaultRangeProfile();
    const clean60 = toggleProfileObservation(initial, "clean", 60);
    const clean48 = toggleProfileObservation(clean60, "clean", 48);
    const withAccuracy = toggleProfileObservation(clean48, "accuracy", 48);
    const cleanRemoved = toggleProfileObservation(withAccuracy, "clean", 48);

    expect(initial.cleanStableMidis).toEqual([]);
    expect(withAccuracy.cleanStableMidis).toEqual([48, 60]);
    expect(withAccuracy.accuracyChallengeMidis).toEqual([48]);
    expect(cleanRemoved.cleanStableMidis).toEqual([60]);
    expect(cleanRemoved.accuracyChallengeMidis).toEqual([48]);
    expect(cleanStableBounds(withAccuracy)).toEqual({ lowMidi: 48, highMidi: 60 });
  });

  it("finds the nearest marked accuracy challenge on each side of the baseline", () => {
    let profile = createDefaultRangeProfile();
    for (const midi of [36, 44, 47, 48, 50, 55, 83]) {
      profile = toggleProfileObservation(profile, "accuracy", midi);
    }

    expect(manualAccuracyEdges(profile)).toEqual({ lowMidi: 47, highMidi: 50 });
  });

  it("computes bounded extrema and ignores invalid values", () => {
    expect(rangeBoundsForMidis([83, 48, 36, 60, 36, 35, 84, 48.5, Number.NaN]))
      .toEqual({ lowMidi: 36, highMidi: 83 });
    expect(rangeBoundsForMidis([35, 84, Number.NaN])).toEqual({ lowMidi: null, highMidi: null });
  });

  it("tracks ascending and descending register-shift reports independently", () => {
    let profile = createDefaultRangeProfile();
    const initial = profile;
    profile = toggleRegisterShift(profile, 60, "ascending");
    profile = toggleRegisterShift(profile, 55, "descending");
    profile = toggleRegisterShift(profile, 60, "descending");

    expect(initial.registerShifts).toEqual([]);
    expect(profile.registerShifts).toEqual([
      { midi: 55, ascending: false, descending: true },
      { midi: 60, ascending: true, descending: true },
    ]);

    profile = toggleRegisterShift(profile, 60, "ascending");
    expect(profile.registerShifts).toContainEqual({ midi: 60, ascending: false, descending: true });
    profile = toggleRegisterShift(profile, 60, "descending");
    expect(profile.registerShifts).toEqual([{ midi: 55, ascending: false, descending: true }]);
  });

  it("accepts profile boundaries and rejects out-of-range manual markers", () => {
    let profile = createDefaultRangeProfile();
    profile = toggleProfileObservation(profile, "clean", RANGE_PROFILE_MIN_MIDI);
    profile = toggleProfileObservation(profile, "clean", RANGE_PROFILE_MAX_MIDI);
    profile = toggleRegisterShift(profile, RANGE_PROFILE_MIN_MIDI, "ascending");
    profile = toggleRegisterShift(profile, RANGE_PROFILE_MAX_MIDI, "descending");

    expect(cleanStableBounds(profile)).toEqual({
      lowMidi: RANGE_PROFILE_MIN_MIDI,
      highMidi: RANGE_PROFILE_MAX_MIDI,
    });
    expect(() => toggleProfileObservation(profile, "clean", RANGE_PROFILE_MIN_MIDI - 1)).toThrow(RangeError);
    expect(() => toggleProfileObservation(profile, "accuracy", RANGE_PROFILE_MAX_MIDI + 1)).toThrow(RangeError);
    expect(() => toggleRegisterShift(profile, 48.5, "ascending")).toThrow(RangeError);
  });
});

describe("cautious accuracy-edge suggestions", () => {
  it("requires the minimum comparable evidence at both baseline and candidate", () => {
    expect(MINIMUM_EDGE_OBSERVATIONS).toBe(3);
    let profile = addSamples(createDefaultRangeProfile(), 48, MINIMUM_EDGE_OBSERVATIONS);
    profile = addSamples(profile, 50, MINIMUM_EDGE_OBSERVATIONS - 1, { resetCount: 3 });
    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS)).toEqual({ lowMidi: null, highMidi: null });

    profile = addSamples(profile, 50, 1, { resetCount: 3 });
    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS)).toEqual({ lowMidi: null, highMidi: 50 });

    let insufficientBaseline = addSamples(createDefaultRangeProfile(), 48, MINIMUM_EDGE_OBSERVATIONS - 1);
    insufficientBaseline = addSamples(insufficientBaseline, 47, MINIMUM_EDGE_OBSERVATIONS, { resetCount: 3 });
    expect(suggestedAccuracyEdges(insufficientBaseline, "solo", 20, REQUIRED_HOLD_MS))
      .toEqual({ lowMidi: null, highMidi: null });
  });

  it("reports the first repeated friction point moving outward in each direction", () => {
    let profile = addSamples(createDefaultRangeProfile(), 48, 3);
    profile = addSamples(profile, 45, 3, { resetCount: 2 });
    profile = addSamples(profile, 47, 3, { resetCount: 2 });
    profile = addSamples(profile, 50, 3, { resetCount: 2 });
    profile = addSamples(profile, 52, 3, { resetCount: 2 });

    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS)).toEqual({ lowMidi: 47, highMidi: 50 });
  });

  it.each([
    ["two additional average resets", { resetCount: 2 }],
    ["one reset plus 1.5 seconds slower acquisition", { resetCount: 1, timeToAcquireMs: 2_000 }],
    ["one reset plus six cents more center error", { resetCount: 1, medianErrorCents: 10 }],
    ["one reset plus six cents more instability", { resetCount: 1, stabilityCents: 11 }],
  ] as const)("suggests an emerging edge for %s", (_label, friction) => {
    let profile = addSamples(createDefaultRangeProfile(), 48, 3);
    profile = addSamples(profile, 49, 3, friction);

    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS).highMidi).toBe(49);
  });

  it.each([
    ["2.5 seconds slower acquisition", { timeToAcquireMs: 3_000 }],
    ["ten cents more center error", { medianErrorCents: 14 }],
    ["ten cents more instability", { stabilityCents: 15 }],
  ] as const)("accepts a repeated strong signal without requiring reset friction: %s", (_label, friction) => {
    let profile = addSamples(createDefaultRangeProfile(), 48, 3);
    profile = addSamples(profile, 49, 3, friction);

    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS).highMidi).toBe(49);
  });

  it("does not overstate isolated subthreshold differences or one moderate signal", () => {
    let profile = addSamples(createDefaultRangeProfile(), 48, 3);
    profile = addSamples(profile, 49, 3, {
      resetCount: 0,
      timeToAcquireMs: 1_999,
      medianErrorCents: 9.9,
      stabilityCents: 10.9,
    });
    profile = addSamples(profile, 50, 3, {
      resetCount: 1,
      timeToAcquireMs: 1_999,
      medianErrorCents: 9.9,
      stabilityCents: 10.9,
    });

    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS)).toEqual({ lowMidi: null, highMidi: null });
  });

  it("does not infer center-error or stability friction from fewer than three optional samples", () => {
    let profile = addSamples(createDefaultRangeProfile(), 48, 3);
    profile = addSamples(profile, 49, 1, {
      medianErrorCents: 40,
      stabilityCents: 40,
    });
    profile = addSamples(profile, 49, 2, {
      medianErrorCents: undefined,
      stabilityCents: undefined,
    });

    expect(summarizeRangeEvidence(profile, 49, "solo", 20, REQUIRED_HOLD_MS)).toMatchObject({
      observationCount: 3,
      centerErrorSampleCount: 1,
      stabilitySampleCount: 1,
    });
    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS)).toEqual({ lowMidi: null, highMidi: null });
  });

  it("does not mix assisted-mode or materially different-tolerance evidence", () => {
    let profile = addSamples(createDefaultRangeProfile(), 48, 3);
    profile = addSamples(profile, 49, 3, { supportMode: "octave", resetCount: 4 });
    profile = addSamples(profile, 49, 3, { toleranceCents: 20.5, resetCount: 4 });

    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS)).toEqual({ lowMidi: null, highMidi: null });

    profile = addSamples(profile, 49, 3, { supportMode: "solo", toleranceCents: 20, resetCount: 2 });
    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS).highMidi).toBe(49);
  });

  it("uses the changed baseline and requires evidence for that new reference note", () => {
    let profile = addSamples(createDefaultRangeProfile(), 48, 3);
    profile = addSamples(profile, 52, 3, { resetCount: 2 });
    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS).highMidi).toBe(52);

    profile = setRangeProfileBaseline(profile, 50, "manual", "2026-08-22T12:30:00Z");
    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS)).toEqual({ lowMidi: null, highMidi: null });

    profile = addSamples(profile, 50, 3);
    expect(suggestedAccuracyEdges(profile, "solo", 20, REQUIRED_HOLD_MS).highMidi).toBe(52);
  });
});
