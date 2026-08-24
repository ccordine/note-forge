import { describe, expect, it } from "vitest";

import {
  createSongAnalysisChunks,
  resampleMonoPcm,
} from "../apps/web/src/features/voice-arcade/song-analysis-pcm";
import {
  SONG_LANE_TOLERANCE_CENTS,
  toleranceCentsForDifficulty,
} from "../apps/web/src/features/voice-arcade/song-lane-options";
import type {
  SongLaneAnalysisOptions,
} from "../apps/web/src/features/voice-arcade/song-lane-types";
import { analyzeSongLanes } from "../apps/web/src/features/voice-arcade/song-lanes";

const SAMPLE_RATE = 8_000;

function sine(
  frequencyHz: number,
  seconds: number,
  amplitude = 0.6,
  sampleRate = SAMPLE_RATE,
): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * sampleRate) },
    (_, index) => amplitude * Math.sin(2 * Math.PI * frequencyHz * index / sampleRate),
  );
}

function silence(seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate));
}

function join(...parts: readonly Float32Array[]): Float32Array {
  const joined = new Float32Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function frequencyForMidi(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

const TEST_OPTIONS: SongLaneAnalysisOptions = {
  frameSizeSamples: 512,
  hopSizeSamples: 128,
  minFrequencyHz: 80,
  maxFrequencyHz: 800,
  minimumConfidence: 0.7,
  rmsThreshold: 0.005,
  minimumLaneSeconds: 0.1,
  mergeGapSeconds: 0.1,
};

describe("song target-lane extraction", () => {
  it("extracts ordered chromatic lanes from synthesized melody changes", () => {
    const pcm = join(
      sine(frequencyForMidi(60), 0.55),
      sine(frequencyForMidi(64), 0.55),
      sine(frequencyForMidi(67), 0.55),
    );

    const analysis = analyzeSongLanes(pcm, SAMPLE_RATE, TEST_OPTIONS);

    expect(analysis.durationSeconds).toBeCloseTo(1.65, 6);
    expect(analysis.lanes.map((lane) => lane.sourceMidi)).toEqual([60, 64, 67]);
    expect(analysis.lanes.map((lane) => lane.targetMidi)).toEqual([60, 64, 67]);
    expect(analysis.lanes.every((lane) => lane.durationSeconds > 0.4)).toBe(true);
    expect(analysis.voicedCoverage).toBeGreaterThan(0.9);
    expect(analysis.sourceMidiRange).toEqual({ minMidi: 60, maxMidi: 67 });
  });

  it("returns a valid empty analysis for silence", () => {
    const analysis = analyzeSongLanes(silence(1), SAMPLE_RATE, TEST_OPTIONS);

    expect(analysis.lanes).toEqual([]);
    expect(analysis.voicedFrameCount).toBe(0);
    expect(analysis.voicedCoverage).toBe(0);
    expect(analysis.sourceMidiRange).toBeNull();
    expect(analysis.targetMidiRange).toBeNull();
    expect(analysis.transposeSemitones).toBe(0);
  });

  it("merges a short unvoiced gap between matching notes", () => {
    const pcm = join(
      sine(frequencyForMidi(60), 0.4),
      silence(0.06),
      sine(frequencyForMidi(60), 0.4),
    );

    const analysis = analyzeSongLanes(pcm, SAMPLE_RATE, TEST_OPTIONS);

    expect(analysis.lanes).toHaveLength(1);
    expect(analysis.lanes[0]).toMatchObject({ sourceMidi: 60, targetMidi: 60 });
    expect(analysis.lanes[0].durationSeconds).toBeGreaterThan(0.75);
  });

  it("downsamples standard decoded-audio rates before detecting pitch", () => {
    const sourceRate = 44_100;
    const analysis = analyzeSongLanes(
      sine(frequencyForMidi(60), 0.6, 0.6, sourceRate),
      sourceRate,
      { minimumLaneSeconds: 0.1 },
    );

    expect(analysis.analysisSampleRate).toBe(8_000);
    expect(analysis.lanes.map((lane) => lane.sourceMidi)).toEqual([60]);
  });

  it("is deterministic and leaves uploaded PCM untouched", () => {
    const pcm = join(
      sine(frequencyForMidi(60), 0.3),
      sine(frequencyForMidi(62), 0.3),
    );
    const original = pcm.slice();

    const first = analyzeSongLanes(pcm, SAMPLE_RATE, TEST_OPTIONS);
    const second = analyzeSongLanes(pcm, SAMPLE_RATE, TEST_OPTIONS);

    expect(second).toEqual(first);
    expect(pcm).toEqual(original);
  });

  it("globally transposes a fitting contour into the supplied vocal range", () => {
    const pcm = join(
      sine(frequencyForMidi(72), 0.45),
      sine(frequencyForMidi(74), 0.45),
      sine(frequencyForMidi(76), 0.45),
    );
    const analysis = analyzeSongLanes(pcm, SAMPLE_RATE, {
      ...TEST_OPTIONS,
      vocalRange: { minMidi: 48, maxMidi: 60 },
    });

    expect(analysis.transposeSemitones).toBe(-16);
    expect(analysis.lanes.map((lane) => lane.targetMidi)).toEqual([56, 58, 60]);
    expect(analysis.lanes.every((lane) => !lane.wasClippedToRange)).toBe(true);
    expect(analysis.targetMidiRange).toEqual({ minMidi: 56, maxMidi: 60 });
    expect(analysis.vocalRange).toEqual({ minMidi: 48, maxMidi: 60 });
  });

  it("clips only when a source contour is wider than the vocal range", () => {
    const pcm = join(
      sine(frequencyForMidi(48), 0.4),
      sine(frequencyForMidi(60), 0.4),
      sine(frequencyForMidi(72), 0.4),
    );
    const analysis = analyzeSongLanes(pcm, SAMPLE_RATE, {
      ...TEST_OPTIONS,
      vocalRange: { minMidi: 55, maxMidi: 60 },
    });

    expect(analysis.lanes.every((lane) =>
      lane.targetMidi >= 55 && lane.targetMidi <= 60
    )).toBe(true);
    expect(analysis.clippedLaneCount).toBeGreaterThan(0);
  });
});

describe("song lane difficulty and deterministic work units", () => {
  it("makes every successive difficulty lane tighter", () => {
    const tolerances = (["easy", "medium", "hard", "expert"] as const)
      .map(toleranceCentsForDifficulty);
    expect(tolerances).toEqual([45, 30, 18, 10]);
    expect(SONG_LANE_TOLERANCE_CENTS).toEqual({
      easy: 45,
      medium: 30,
      hard: 18,
      expert: 10,
    });

    const pcm = sine(frequencyForMidi(60), 0.5);
    const easy = analyzeSongLanes(pcm, SAMPLE_RATE, {
      ...TEST_OPTIONS,
      difficulty: "easy",
    });
    const expert = analyzeSongLanes(pcm, SAMPLE_RATE, {
      ...TEST_OPTIONS,
      difficulty: "expert",
    });
    expect(easy.lanes[0].upperMidi - easy.lanes[0].lowerMidi).toBeCloseTo(0.9);
    expect(expert.lanes[0].upperMidi - expert.lanes[0].lowerMidi).toBeCloseTo(0.2);
  });

  it("enumerates complete, stable chunks ending at progress 1", () => {
    const chunks = createSongAnalysisChunks(2_000, SAMPLE_RATE, TEST_OPTIONS);

    expect(chunks[0]).toMatchObject({
      index: 0,
      startSample: 0,
      endSample: 512,
    });
    expect(chunks.at(-1)).toMatchObject({
      endSample: 2_000,
      progress: 1,
    });
    expect(chunks.every((chunk) => chunk.total === chunks.length)).toBe(true);
    expect(createSongAnalysisChunks(0, SAMPLE_RATE, TEST_OPTIONS)).toEqual([]);
  });

  it("downsamples locally without mutating the source", () => {
    const source = Float32Array.from([0, 1, 0, -1, 0, 1, 0, -1]);
    const original = source.slice();

    const result = resampleMonoPcm(source, 8, 4);

    expect(result).toEqual(Float32Array.from([0.5, -0.5, 0.5, -0.5]));
    expect(source).toEqual(original);
  });

  it("rejects invalid PCM and analysis/range/difficulty settings", () => {
    expect(() => analyzeSongLanes([0, 1] as never, SAMPLE_RATE)).toThrow(TypeError);
    expect(() => analyzeSongLanes(Float32Array.of(0, Number.NaN), SAMPLE_RATE))
      .toThrow(/pcm\[1\]/);
    expect(() => analyzeSongLanes(new Float32Array(), 0)).toThrow(/sampleRate/);
    expect(() => analyzeSongLanes(new Float32Array(), SAMPLE_RATE, {
      ...TEST_OPTIONS,
      frameSizeSamples: 200,
    })).toThrow(/frameSizeSamples is too small/);
    expect(() => analyzeSongLanes(new Float32Array(), SAMPLE_RATE, {
      ...TEST_OPTIONS,
      vocalRange: { minMidi: 61, maxMidi: 60 },
    })).toThrow(/vocalRange/);
    expect(() => toleranceCentsForDifficulty("nightmare" as never))
      .toThrow(/difficulty/);
    expect(() => analyzeSongLanes(new Float32Array(), SAMPLE_RATE, {
      ...TEST_OPTIONS,
      difficulty: "nightmare" as never,
    })).toThrow(/difficulty/);
  });
});
