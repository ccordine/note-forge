import { describe, expect, it } from "vitest";
import {
  createNoteFamilySession,
  makePromptTrial,
  reduceNoteFamilySession,
} from "../apps/web/src/features/ear-training/note-family-session";
import { createEmptyNoteFamilyProgress } from "../apps/web/src/features/ear-training/trials";

describe("direct note-family session", () => {
  it("replaces low with any selected family without an unlock state", () => {
    const initial = createNoteFamilySession("letters", () => 0, "start");
    const trial = makePromptTrial("letters", "high", initial.progress.high, "A", () => 0, "high-start");
    const selected = reduceNoteFamilySession(initial, {
      type: "replace-trial",
      activeFamilyId: "high",
      anchorLetter: "A",
      trial,
    });
    expect(selected.activeFamilyId).toBe("high");
    expect(selected.trial.note.familyId).toBe("high");
    expect(selected.answerLetter).toBeNull();
    expect(Object.keys(selected)).not.toContain("highestUnlockedFamilyId");
  });

  it("records one answer and ignores a second answer for the same prompt", () => {
    const initial = createNoteFamilySession("letters", () => 0, "start");
    const answered = reduceNoteFamilySession(initial, { type: "answer", letter: "C" });
    const duplicate = reduceNoteFamilySession(answered, { type: "answer", letter: "D" });
    expect(answered.progress.low.C).toEqual({ attempts: 1, correct: 1, correctStreak: 1 });
    expect(duplicate).toBe(answered);
  });

  it("does not overwrite in-session evidence when storage hydration resolves late", () => {
    const initial = createNoteFamilySession("letters", () => 0, "start");
    const answered = reduceNoteFamilySession(initial, { type: "answer", letter: "C" });
    const stored = createEmptyNoteFamilyProgress();
    stored.low.C = { attempts: 50, correct: 50, correctStreak: 50 };
    const hydrated = reduceNoteFamilySession(answered, { type: "hydrate", progress: stored });
    expect(hydrated.progress.low.C).toEqual({ attempts: 1, correct: 1, correctStreak: 1 });
    expect(hydrated.storage.status).toBe("ready");
  });
});
