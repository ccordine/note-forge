import { describe, expect, it } from "vitest";
import {
  INITIAL_SONG_WORKSPACE,
  reduceSongWorkspace,
  type VoiceTake,
} from "../apps/web/src/features/song-lab/song-workspace";

function loadedState() {
  return reduceSongWorkspace(INITIAL_SONG_WORKSPACE, {
    type: "song-loaded",
    song: {
      url: "blob:phrase",
      fileName: "phrase.wav",
      duration: 12,
      peaks: [0.2, 0.8],
    },
  });
}

describe("song workspace reducer", () => {
  it("loads one track into the configure stage and resets prior workflow state", () => {
    const dirty = {
      ...INITIAL_SONG_WORKSPACE,
      stage: "review" as const,
      practicePass: "mutate" as const,
      phraseNote: "old",
      recordingStatus: "active" as const,
    };
    const next = reduceSongWorkspace(dirty, {
      type: "song-loaded",
      song: {
        url: "blob:new",
        fileName: "new.wav",
        duration: 5.5,
        peaks: [0.1, 1],
      },
    });

    expect(next).toMatchObject({
      stage: "configure",
      audioUrl: "blob:new",
      fileName: "new.wav",
      duration: 5.5,
      loopStart: 0,
      loopEnd: 5.5,
      practicePass: "shadow",
      phraseNote: "",
      recordingStatus: "idle",
    });
  });

  it("keeps loop boundaries legal in one pure authority", () => {
    const loaded = loadedState();
    const movedStart = reduceSongWorkspace(loaded, { type: "loop-start-changed", time: 99 });
    expect(movedStart.loopStart).toBeCloseTo(loaded.loopEnd - 0.1);

    const movedEnd = reduceSongWorkspace(movedStart, { type: "loop-end-changed", time: 0 });
    expect(movedEnd.loopEnd).toBeCloseTo(movedStart.loopStart + 0.1);
    expect(movedEnd.loopEnd).toBeLessThanOrEqual(loaded.duration);
  });

  it("renders only an explicitly selected workflow stage", () => {
    const configured = loadedState();
    const practicing = reduceSongWorkspace(configured, { type: "stage-changed", stage: "practice" });
    const reviewing = reduceSongWorkspace(practicing, { type: "stage-changed", stage: "review" });
    expect([configured.stage, practicing.stage, reviewing.stage]).toEqual([
      "configure",
      "practice",
      "review",
    ]);
  });

  it("cannot hide an opening or active recorder behind another workflow stage", () => {
    const practice = reduceSongWorkspace(loadedState(), {
      type: "stage-changed",
      stage: "practice",
    });
    const opening = reduceSongWorkspace(practice, { type: "recording-starting" });
    const hiddenWhileOpening = reduceSongWorkspace(opening, {
      type: "stage-changed",
      stage: "configure",
    });
    const active = reduceSongWorkspace(opening, { type: "recording-started" });
    const hiddenWhileActive = reduceSongWorkspace(active, {
      type: "stage-changed",
      stage: "review",
    });
    const stopped = reduceSongWorkspace(active, { type: "recording-stopped" });
    const review = reduceSongWorkspace(stopped, { type: "stage-changed", stage: "review" });

    expect(hiddenWhileOpening).toBe(opening);
    expect(hiddenWhileActive).toBe(active);
    expect(opening.stage).toBe("practice");
    expect(active.stage).toBe("practice");
    expect(review.stage).toBe("review");
  });

  it("caps markers without mutating the prior state", () => {
    const loaded = loadedState();
    const first = reduceSongWorkspace(loaded, {
      type: "marker-added",
      marker: { time: 1.25, type: "breath" },
      maximum: 1,
    });
    const capped = reduceSongWorkspace(first, {
      type: "marker-added",
      marker: { time: 2, type: "phrase" },
      maximum: 1,
    });
    expect(loaded.markers).toHaveLength(0);
    expect(first.markers).toEqual([{ time: 1.25, type: "breath" }]);
    expect(capped).toBe(first);
  });

  it("moves a completed explicit take into review and caps temporary takes", () => {
    const take = (id: string): VoiceTake => ({ id, url: `blob:${id}`, createdAt: new Date(0) });
    let state = loadedState();
    state = reduceSongWorkspace(state, { type: "stage-changed", stage: "practice" });
    state = reduceSongWorkspace(state, { type: "take-added", take: take("one"), maximum: 2 });
    state = reduceSongWorkspace(state, { type: "stage-changed", stage: "practice" });
    state = reduceSongWorkspace(state, { type: "take-added", take: take("two"), maximum: 2 });
    state = reduceSongWorkspace(state, { type: "take-added", take: take("three"), maximum: 2 });

    expect(state.stage).toBe("review");
    expect(state.takes.map(({ id }) => id)).toEqual(["three", "two"]);
  });
});
