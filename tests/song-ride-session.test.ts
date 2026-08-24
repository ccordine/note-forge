import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import type { SongLaneAnalysis, SongTargetLane } from "../apps/web/src/features/voice-arcade/song-lane-types";
import {
  createSongScoreRuntime,
  finishSongRide,
  INITIAL_SONG_RIDE_SESSION,
  observeSongLane,
  reduceSongRideSession,
  songHud,
} from "../apps/web/src/features/voice-arcade/song-ride-session";

const SAMPLE_RATE = 48_000;
const WINDOW = 4_096;
const HOP = 960;

function lane(id = "lane-1", startSeconds = 0, endSeconds = 1): SongTargetLane {
  return {
    id,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    sourceMidi: 60,
    targetMidi: 60,
    lowerMidi: 59.8,
    upperMidi: 60.2,
    toleranceCents: 20,
    averageConfidence: 0.95,
    voicedFrameCount: 12,
    voicedSeconds: endSeconds - startSeconds,
    wasClippedToRange: false,
  };
}

function analysis(lanes: SongTargetLane[] = [lane()]): SongLaneAnalysis {
  return {
    durationSeconds: 1,
    sourceSampleRate: SAMPLE_RATE,
    analysisSampleRate: 6_000,
    frames: [],
    lanes,
    difficulty: "easy",
    toleranceCents: 20,
    vocalRange: { minMidi: 48, maxMidi: 72 },
    transposeSemitones: 0,
    clippedLaneCount: 0,
    sourceMidiRange: { minMidi: 60, maxMidi: 60 },
    targetMidiRange: { minMidi: 60, maxMidi: 60 },
    voicedFrameCount: 12,
    voicedCoverage: 1,
  };
}

function observation(
  endSample: number,
  options: Readonly<{
    midi?: number | null;
    confidence?: number;
    continuityEpoch?: number;
    discontinuity?: boolean;
  }> = {},
): PitchObservation {
  const midi = options.midi === undefined ? 60 : options.midi;
  const voiced = midi !== null;
  return {
    observationKind: voiced ? "voiced" : "unvoiced",
    timeSeconds: (endSample - WINDOW / 2) / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    startSample: endSample - WINDOW,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: options.continuityEpoch ?? 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: options.discontinuity ?? false,
    frequencyHz: midi === null ? null : 440 * 2 ** ((midi - 69) / 12),
    midiFloat: midi,
    nearestMidi: midi === null ? null : Math.round(midi),
    centsFromNearest: midi === null ? null : (midi - Math.round(midi)) * 100,
    rms: voiced ? 0.02 : 0,
    confidence: options.confidence ?? (voiced ? 0.96 : 0),
    voiced,
    detector: "yin",
    periodSamples: voiced ? 184 : null,
    yinValue: voiced ? 0.04 : null,
    reason: voiced ? "detected" : "below-rms-threshold",
    periodicity: voiced ? 0.96 : 0,
  };
}

describe("Song Ride sample-coordinate scoring", () => {
  it("credits only consecutive authoritative PCM hops", () => {
    const runtime = createSongScoreRuntime();
    const target = lane();
    observeSongLane(runtime, target, observation(WINDOW));
    observeSongLane(runtime, target, observation(WINDOW + HOP));
    expect(runtime.laneMetrics.get(target.id)).toMatchObject({
      observedSeconds: 0.02,
      voicedSeconds: 0.02,
      inLaneSeconds: 0.02,
    });
    expect(songHud(runtime, target).accuracyPercent).toBe(100);
  });

  it("does not fabricate credit across duplicate, reordered, missing, or discontinuous samples", () => {
    const runtime = createSongScoreRuntime();
    const target = lane();
    observeSongLane(runtime, target, observation(WINDOW));
    observeSongLane(runtime, target, observation(WINDOW));
    observeSongLane(runtime, target, observation(WINDOW - HOP));
    observeSongLane(runtime, target, observation(WINDOW + HOP * 2));
    observeSongLane(runtime, target, observation(WINDOW + HOP * 3, { continuityEpoch: 1, discontinuity: true }));
    expect(runtime.laneMetrics.get(target.id)).toBeUndefined();
  });

  it("treats unvoiced windows as live observed time without inventing pitch", () => {
    const runtime = createSongScoreRuntime();
    const target = lane();
    observeSongLane(runtime, target, observation(WINDOW));
    observeSongLane(runtime, target, observation(WINDOW + HOP, { midi: null }));
    const metrics = runtime.laneMetrics.get(target.id)!;
    expect(metrics.observedSeconds).toBeCloseTo(0.02, 10);
    expect(metrics.voicedSeconds).toBe(0);
    expect(metrics.inLaneSeconds).toBe(0);
  });

  it("produces a bounded result from the section actually played", () => {
    const runtime = createSongScoreRuntime();
    const chart = analysis();
    observeSongLane(runtime, chart.lanes[0]!, observation(WINDOW));
    observeSongLane(runtime, chart.lanes[0]!, observation(WINDOW + HOP));
    const result = finishSongRide(runtime, chart, 0.5, false);
    expect(result.playedSeconds).toBe(0.5);
    expect(result.completionPercent).toBe(50);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("Song Ride workflow reducer", () => {
  it("shows one current stage and preserves progress through pause/resume", () => {
    const track = { name: "test.wav", sizeBytes: 10, url: "blob:test" };
    const chart = analysis();
    const ready = reduceSongRideSession(INITIAL_SONG_RIDE_SESSION, {
      type: "analysis-ready",
      track,
      analysis: chart,
      status: "ready",
    });
    const playing = reduceSongRideSession(ready, { type: "run-started" });
    const progressed = reduceSongRideSession(playing, {
      type: "run-progress",
      currentTime: 0.42,
      liveObservation: null,
      hud: { ...playing.hud, score: 75 },
    });
    const paused = reduceSongRideSession(progressed, { type: "run-paused", status: "paused" });
    const resumed = reduceSongRideSession(paused, { type: "run-resumed" });
    expect(resumed).toMatchObject({ phase: "playing", currentTime: 0.42 });
    expect(resumed.hud.score).toBe(75);
  });
});
