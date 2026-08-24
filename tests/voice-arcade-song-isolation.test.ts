import { describe, expect, it } from "vitest";

import {
  SONG_ISOLATION_MATCH_TOLERANCE_CENTS,
  SONG_ISOLATION_REQUIRED_CONSECUTIVE_MATCHES,
  chooseSongIsolationSegment,
  classifySongIsolationEvidence,
  emptySongIsolationEvidence,
  sourceMidisNearPlaybackTime,
  updateSongIsolationEvidence,
} from "../apps/web/src/features/voice-arcade/song-isolation";
import type { SongTargetLane } from "../apps/web/src/features/voice-arcade/song-lanes";

function lane(
  id: string,
  startSeconds: number,
  endSeconds: number,
  sourceMidi: number,
  averageConfidence = 0.9,
): SongTargetLane {
  return {
    id,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    sourceMidi,
    targetMidi: sourceMidi - 12,
    lowerMidi: sourceMidi - 12.3,
    upperMidi: sourceMidi - 11.7,
    toleranceCents: 30,
    averageConfidence,
    voicedFrameCount: 8,
    voicedSeconds: endSeconds - startSeconds,
    wasClippedToRange: false,
  };
}

function pitch(midiFloat: number | null, voiced = midiFloat !== null, confidence = 0.9) {
  return { voiced, midiFloat, confidence };
}

describe("Song Rail playback-isolation preflight", () => {
  it("selects a bounded representative window around the densest stable contour", () => {
    const lanes = [
      lane("thin", 0.2, 0.45, 60, 0.75),
      lane("dense-1", 5, 6.2, 64),
      lane("dense-2", 6.2, 7.3, 67),
    ];

    const segment = chooseSongIsolationSegment(lanes, 10);

    expect(segment.durationSeconds).toBe(2.4);
    expect(segment.startSeconds).toBeGreaterThanOrEqual(4.7);
    expect(segment.endSeconds).toBeLessThanOrEqual(7.6);
    expect(segment.startSeconds).toBeGreaterThanOrEqual(0);
    expect(segment.endSeconds).toBeLessThanOrEqual(10);
  });

  it("uses nearby source notes rather than transposed target notes", () => {
    const lanes = [lane("a", 1, 1.5, 72), lane("b", 1.5, 2, 76)];

    expect(sourceMidisNearPlaybackTime(lanes, 1.56)).toEqual([72, 76]);
    expect(sourceMidisNearPlaybackTime(lanes, 3)).toEqual([]);
  });

  it("locks scoring after repeated source-contour matches", () => {
    let evidence = emptySongIsolationEvidence();
    for (let index = 0; index < SONG_ISOLATION_REQUIRED_CONSECUTIVE_MATCHES; index += 1) {
      evidence = updateSongIsolationEvidence(evidence, pitch(60.1), [60]);
    }

    expect(classifySongIsolationEvidence(evidence, 0.8, 2.4)).toBe("leak");
  });

  it("also catches intermittent repeated matches without requiring one uninterrupted run", () => {
    let evidence = emptySongIsolationEvidence();
    for (let index = 0; index < 6; index += 1) {
      evidence = updateSongIsolationEvidence(evidence, pitch(64), [64]);
      evidence = updateSongIsolationEvidence(evidence, pitch(null, false, 0), [64]);
    }

    expect(evidence.maximumConsecutiveMatches).toBe(1);
    expect(classifySongIsolationEvidence(evidence, 1.2, 2.4)).toBe("leak");
  });

  it("treats octave harmonics of the source as leakage", () => {
    let evidence = emptySongIsolationEvidence();
    for (let index = 0; index < SONG_ISOLATION_REQUIRED_CONSECUTIVE_MATCHES; index += 1) {
      evidence = updateSongIsolationEvidence(evidence, pitch(72.1), [60]);
    }

    expect(classifySongIsolationEvidence(evidence, 0.8, 2.4)).toBe("leak");
  });

  it("passes only after fresh comparable frames and real playback advancement", () => {
    let evidence = emptySongIsolationEvidence();
    for (let index = 0; index < 8; index += 1) {
      evidence = updateSongIsolationEvidence(evidence, pitch(null, false, 0), [60]);
    }

    expect(classifySongIsolationEvidence(evidence, 0.8, 2.4)).toBe("pass");
    expect(classifySongIsolationEvidence(evidence, 0.2, 2.4)).toBe("no-data");
  });

  it("rejects missing microphone frames or source-comparable timing as no-data", () => {
    let tooFew = emptySongIsolationEvidence();
    for (let index = 0; index < 5; index += 1) {
      tooFew = updateSongIsolationEvidence(tooFew, pitch(null, false, 0), [60]);
    }
    let noContour = emptySongIsolationEvidence();
    for (let index = 0; index < 8; index += 1) {
      noContour = updateSongIsolationEvidence(noContour, pitch(null, false, 0), []);
    }

    expect(classifySongIsolationEvidence(tooFew, 1, 2.4)).toBe("no-data");
    expect(classifySongIsolationEvidence(noContour, 1, 2.4)).toBe("no-data");
  });

  it("uses an inclusive conservative cents boundary", () => {
    const boundaryMidi = 60 + SONG_ISOLATION_MATCH_TOLERANCE_CENTS / 100;
    const inside = updateSongIsolationEvidence(emptySongIsolationEvidence(), pitch(boundaryMidi), [60]);
    const outside = updateSongIsolationEvidence(emptySongIsolationEvidence(), pitch(boundaryMidi + 0.001), [60]);

    expect(inside.matchingFrames).toBe(1);
    expect(outside.matchingFrames).toBe(0);
  });

  it("rejects missing source lanes and invalid durations", () => {
    expect(() => chooseSongIsolationSegment([], 2)).toThrow(/source lane/);
    expect(() => chooseSongIsolationSegment([lane("a", 0, 1, 60)], 0)).toThrow(/duration/);
  });
});
