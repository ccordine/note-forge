import { describe, expect, it } from "vitest";
import { createToneMapCourse } from "../apps/web/src/features/ear-training/tone-map-model";
import {
  classifyStoredToneMap,
  mayWriteToneMapStorage,
} from "../apps/web/src/features/ear-training/tone-map-storage";

function stored(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    course: createToneMapCourse("stored-course"),
    responseMode: "keyboard",
    challengeMode: "single",
    simonLength: 3,
    ...overrides,
  };
}

describe("tone-map stored-state authority", () => {
  it("distinguishes a missing value from invalid data and never writes over invalid data", () => {
    const missing = classifyStoredToneMap(undefined);
    const corrupt = classifyStoredToneMap(null);
    const retiredRandomCurriculum = classifyStoredToneMap(stored({ version: 1 }));
    const unsupported = classifyStoredToneMap(stored({ version: 3 }));

    expect(missing).toEqual({ kind: "missing" });
    expect(corrupt).toMatchObject({ kind: "invalid" });
    expect(retiredRandomCurriculum).toMatchObject({ kind: "invalid" });
    expect(unsupported).toMatchObject({ kind: "invalid" });
    expect(mayWriteToneMapStorage(true, missing)).toBe(true);
    expect(mayWriteToneMapStorage(true, corrupt)).toBe(false);
    expect(mayWriteToneMapStorage(true, unsupported)).toBe(false);
    expect(mayWriteToneMapStorage(false, missing)).toBe(false);
  });

  it("strictly restores supported single and keyboard-Simon configurations", () => {
    expect(classifyStoredToneMap(stored())).toMatchObject({
      kind: "valid",
      state: { responseMode: "keyboard", challengeMode: "single", simonLength: 3 },
    });
    expect(classifyStoredToneMap(stored({
      responseMode: "voice",
      challengeMode: "single",
      simonLength: 8,
    }))).toMatchObject({ kind: "valid" });
    expect(classifyStoredToneMap(stored({
      responseMode: "keyboard",
      challengeMode: "simon",
      simonLength: 2,
    }))).toMatchObject({ kind: "valid" });
  });

  it.each([
    { responseMode: "voice", challengeMode: "simon" },
    { responseMode: "mixed", challengeMode: "simon" },
    { responseMode: "invalid", challengeMode: "single" },
    { responseMode: "keyboard", challengeMode: "invalid" },
  ])("rejects invalid response/challenge configuration %#", (configuration) => {
    expect(classifyStoredToneMap(stored(configuration))).toMatchObject({ kind: "invalid" });
  });

  it.each([1, 9, 2.5, null, undefined])("rejects invalid Simon length %s", (simonLength) => {
    expect(classifyStoredToneMap(stored({ simonLength }))).toMatchObject({ kind: "invalid" });
  });
});
