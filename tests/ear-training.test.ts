import { describe, expect, it } from "vitest";

import {
  NOTE_FAMILIES,
  NOTE_LETTERS,
  advanceHighestUnlockedFamily,
  createEmptyFamilyEvidence,
  createEmptyNoteFamilyProgress,
  createNoteFamilyTrial,
  createReferenceTrial,
  isFamilyComplete,
  isNoteMastered,
  masteredNoteCount,
  midiForFamilyLetter,
  naturalMidisInFamily,
  normalizeFamilyProgress,
  parseNoteLetterKey,
  pitchClassFromLetterKey,
  recordNoteAttempt,
  unlockedFamilyIdsThrough,
  type FamilyEvidence,
  type NoteFamilyId,
} from "../apps/web/src/features/ear-training/trials";

const masteredFamily = (): FamilyEvidence => Object.fromEntries(
  NOTE_LETTERS.map((letter) => [letter, {
    attempts: 3,
    correct: 3,
    correctStreak: 3,
  }]),
) as FamilyEvidence;

describe("fixed-register note families", () => {
  it("defines three non-overlapping C-through-B families", () => {
    expect(NOTE_FAMILIES).toEqual([
      { id: "low", label: "Low", octave: 3, firstMidi: 48, lastMidi: 59, rangeLabel: "C3–B3" },
      { id: "middle", label: "Middle", octave: 4, firstMidi: 60, lastMidi: 71, rangeLabel: "C4–B4" },
      { id: "high", label: "High", octave: 5, firstMidi: 72, lastMidi: 83, rangeLabel: "C5–B5" },
    ]);
  });

  it.each([
    ["low", [48, 50, 52, 53, 55, 57, 59]],
    ["middle", [60, 62, 64, 65, 67, 69, 71]],
    ["high", [72, 74, 76, 77, 79, 81, 83]],
  ] as const)("keeps every %s target in its exact octave", (familyId, expected) => {
    expect(naturalMidisInFamily(familyId)).toEqual(expected);
    expect(midiForFamilyLetter(familyId, "C")).toBe(expected[0]);
    expect(midiForFamilyLetter(familyId, "B")).toBe(expected[expected.length - 1]);
  });

  it("never wraps C to the top of a family", () => {
    expect(createNoteFamilyTrial("low", () => 0)).toMatchObject({
      targetLetter: "C",
      targetMidi: 48,
    });
    expect(createNoteFamilyTrial("low", () => 0.999999)).toMatchObject({
      targetLetter: "B",
      targetMidi: 59,
    });
  });

  it("uses injected randomness deterministically without leaving the family", () => {
    const samples = [0, 0.15, 0.29, 0.43, 0.58, 0.72, 0.999];

    for (const familyId of ["low", "middle", "high"] satisfies NoteFamilyId[]) {
      const family = NOTE_FAMILIES.find((candidate) => candidate.id === familyId)!;
      const trials = samples.map((sample) => createNoteFamilyTrial(familyId, () => sample));

      expect(trials.map((trial) => trial.targetLetter)).toEqual([...NOTE_LETTERS]);
      expect(trials.every((trial) => (
        trial.octave === family.octave
        && trial.targetMidi >= family.firstMidi
        && trial.targetMidi <= family.lastMidi
      ))).toBe(true);
    }
  });

  it("rejects an invalid injected random source", () => {
    expect(() => createNoteFamilyTrial("low", () => 1)).toThrow(RangeError);
    expect(() => createNoteFamilyTrial("low", () => Number.NaN)).toThrow(RangeError);
  });
});

describe("same-family reference trials", () => {
  it.each(["low", "middle", "high"] satisfies NoteFamilyId[])(
    "keeps both tones inside the %s family",
    (familyId) => {
      const family = NOTE_FAMILIES.find((candidate) => candidate.id === familyId)!;
      const trial = createReferenceTrial(familyId, { rng: () => 0.999 });

      expect(trial.anchorLetter).toBe("A");
      expect(trial.anchorMidi).toBe(midiForFamilyLetter(familyId, "A"));
      expect(trial.targetLetter).not.toBe(trial.anchorLetter);
      expect(trial.anchorMidi).toBeGreaterThanOrEqual(family.firstMidi);
      expect(trial.anchorMidi).toBeLessThanOrEqual(family.lastMidi);
      expect(trial.targetMidi).toBeGreaterThanOrEqual(family.firstMidi);
      expect(trial.targetMidi).toBeLessThanOrEqual(family.lastMidi);
      expect(Math.floor(trial.anchorMidi / 12) - 1).toBe(family.octave);
      expect(Math.floor(trial.targetMidi / 12) - 1).toBe(family.octave);
    },
  );

  it("supports a visible configurable anchor and optional same-note trials", () => {
    const distinct = createReferenceTrial("low", { anchorLetter: "C", rng: () => 0 });
    const same = createReferenceTrial("low", {
      anchorLetter: "C",
      allowSame: true,
      rng: () => 0,
    });

    expect(distinct).toMatchObject({ anchorLetter: "C", anchorMidi: 48, targetLetter: "D", targetMidi: 50 });
    expect(same).toMatchObject({ anchorLetter: "C", anchorMidi: 48, targetLetter: "C", targetMidi: 48 });
  });
});

describe("A–G answer keys", () => {
  it("accepts physical letter keys case-insensitively", () => {
    expect(NOTE_LETTERS.map((letter) => parseNoteLetterKey(letter.toLowerCase())))
      .toEqual([...NOTE_LETTERS]);
    expect(pitchClassFromLetterKey("c")).toBe(0);
    expect(pitchClassFromLetterKey("F")).toBe(5);
    expect(pitchClassFromLetterKey("b")).toBe(11);
  });

  it("does not mistake accidentals, event codes, or controls for note answers", () => {
    for (const key of ["C#", "B♭", "KeyC", "Enter", " ", "ArrowUp", ""]) {
      expect(parseNoteLetterKey(key)).toBeNull();
      expect(pitchClassFromLetterKey(key)).toBeNull();
    }
  });
});

describe("per-note mastery and family unlocks", () => {
  it("requires three consecutive correct answers, regardless of lifetime totals", () => {
    expect(isNoteMastered({ attempts: 2, correct: 2, correctStreak: 2 })).toBe(false);
    expect(isNoteMastered({ attempts: 3, correct: 3, correctStreak: 3 })).toBe(true);
    expect(isNoteMastered({ attempts: 20, correct: 18, correctStreak: 2 })).toBe(false);
    expect(isNoteMastered({ attempts: 20, correct: 3, correctStreak: 3 })).toBe(true);
  });

  it("records immutable lifetime evidence and a live correct streak", () => {
    const original = createEmptyFamilyEvidence();
    let updated = recordNoteAttempt(original, "C", true);
    updated = recordNoteAttempt(updated, "C", true);
    updated = recordNoteAttempt(updated, "C", true);

    expect(original.C).toEqual({ attempts: 0, correct: 0, correctStreak: 0 });
    expect(updated.C).toEqual({ attempts: 3, correct: 3, correctStreak: 3 });
  });

  it("does not become stable from collective right answers separated by misses", () => {
    let evidence = createEmptyFamilyEvidence();
    for (const wasCorrect of [true, true, false, true, true]) {
      evidence = recordNoteAttempt(evidence, "C", wasCorrect);
    }

    expect(evidence.C).toEqual({
      attempts: 5,
      correct: 4,
      correctStreak: 2,
    });
    expect(isNoteMastered(evidence.C)).toBe(false);

    evidence = recordNoteAttempt(evidence, "C", true);
    expect(evidence.C.correctStreak).toBe(3);
    expect(isNoteMastered(evidence.C)).toBe(true);
  });

  it("immediately removes stability after a post-mastery miss", () => {
    let evidence = createEmptyFamilyEvidence();
    evidence = recordNoteAttempt(evidence, "C", true);
    evidence = recordNoteAttempt(evidence, "C", true);
    evidence = recordNoteAttempt(evidence, "C", true);
    expect(isNoteMastered(evidence.C)).toBe(true);

    evidence = recordNoteAttempt(evidence, "C", false);
    expect(evidence.C).toEqual({
      attempts: 4,
      correct: 3,
      correctStreak: 0,
    });
    expect(isNoteMastered(evidence.C)).toBe(false);
  });

  it("counts completion independently for every letter", () => {
    const complete = masteredFamily();
    const incomplete = {
      ...complete,
      B: { attempts: 2, correct: 2, correctStreak: 2 },
    };

    expect(masteredNoteCount(incomplete)).toBe(6);
    expect(isFamilyComplete(incomplete)).toBe(false);
    expect(masteredNoteCount(complete)).toBe(7);
    expect(isFamilyComplete(complete)).toBe(true);
  });

  it("keeps an earned family unlocked when an earlier note later loses stability", () => {
    expect(advanceHighestUnlockedFamily("low", "low", true)).toBe("middle");
    expect(unlockedFamilyIdsThrough("middle")).toEqual(["low", "middle"]);

    expect(advanceHighestUnlockedFamily("middle", "low", false)).toBe("middle");
    expect(unlockedFamilyIdsThrough("middle")).toEqual(["low", "middle"]);

    expect(advanceHighestUnlockedFamily("middle", "middle", true)).toBe("high");
    expect(advanceHighestUnlockedFamily("high", "low", false)).toBe("high");
  });

  it("draws only from notes that still need mastery", () => {
    const evidence = createEmptyFamilyEvidence();
    evidence.C = { attempts: 3, correct: 3, correctStreak: 3 };

    expect(createNoteFamilyTrial("low", () => 0, evidence)).toMatchObject({
      targetLetter: "D",
      targetMidi: 50,
    });
  });
});

describe("stored family evidence migration", () => {
  it("preserves v1 lifetime totals but revokes unprovable latched stability", () => {
    const migrated = normalizeFamilyProgress({
      low: { C: { attempts: 12, correct: 9, mastered: true } },
    }, false);

    expect(migrated.low.C).toEqual({ attempts: 12, correct: 9, correctStreak: 0 });
    expect(isNoteMastered(migrated.low.C)).toBe(false);
  });

  it("restores only valid v2 streak evidence and never trusts a stored badge", () => {
    const restored = normalizeFamilyProgress({
      low: {
        C: { attempts: 10, correct: 8, correctStreak: 2, mastered: true },
        D: { attempts: 4, correct: 3, correctStreak: 99, mastered: false },
      },
    }, true);

    expect(restored.low.C).toEqual({ attempts: 10, correct: 8, correctStreak: 2 });
    expect(isNoteMastered(restored.low.C)).toBe(false);
    expect(restored.low.D.correctStreak).toBe(3);
    expect(isNoteMastered(restored.low.D)).toBe(true);
  });
});
