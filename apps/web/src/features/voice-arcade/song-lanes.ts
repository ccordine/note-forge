import {
  extractSongPitchFrames,
  resampleMonoPcm,
  validateSongPcm,
} from "./song-analysis-pcm";
import { resolveSongLaneOptions } from "./song-lane-options";
import type {
  ResolvedSongLaneOptions,
  SongLaneAnalysis,
  SongLaneAnalysisOptions,
  SongPitchFrame,
  SongTargetLane,
  VocalMidiRange,
} from "./song-lane-types";

interface MutableLaneRun {
  startSeconds: number;
  endSeconds: number;
  sourceMidi: number;
  confidenceTotal: number;
  voicedFrameCount: number;
  voicedSeconds: number;
}

const EPSILON = 1e-9;

function mergeMatchingRuns(
  runs: readonly MutableLaneRun[],
  maximumGapSeconds: number,
): MutableLaneRun[] {
  const merged: MutableLaneRun[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (
      previous !== undefined
      && previous.sourceMidi === run.sourceMidi
      && run.startSeconds - previous.endSeconds <= maximumGapSeconds + EPSILON
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, run.endSeconds);
      previous.confidenceTotal += run.confidenceTotal;
      previous.voicedFrameCount += run.voicedFrameCount;
      previous.voicedSeconds += run.voicedSeconds;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function bridgeShortInterruptions(
  runs: readonly MutableLaneRun[],
  minimumLaneSeconds: number,
): MutableLaneRun[] {
  const bridged = runs.map((run) => ({ ...run }));
  let index = 1;
  while (index < bridged.length - 1) {
    const previous = bridged[index - 1];
    const current = bridged[index];
    const next = bridged[index + 1];
    if (
      current.endSeconds - current.startSeconds + EPSILON < minimumLaneSeconds
      && previous.sourceMidi === next.sourceMidi
      && current.startSeconds - previous.endSeconds <= EPSILON
      && next.startSeconds - current.endSeconds <= EPSILON
    ) {
      previous.endSeconds = next.endSeconds;
      previous.confidenceTotal += next.confidenceTotal;
      previous.voicedFrameCount += next.voicedFrameCount;
      previous.voicedSeconds += next.voicedSeconds;
      bridged.splice(index, 2);
      continue;
    }
    index += 1;
  }
  return bridged;
}

function laneRunsFromFrames(
  frames: readonly SongPitchFrame[],
  options: ResolvedSongLaneOptions,
): MutableLaneRun[] {
  const runs: MutableLaneRun[] = [];
  for (const frame of frames) {
    if (frame.quantizedMidi === null) continue;
    const frameSeconds = Math.max(0, frame.endSeconds - frame.startSeconds);
    const previous = runs.at(-1);
    if (
      previous !== undefined
      && previous.sourceMidi === frame.quantizedMidi
      && frame.startSeconds - previous.endSeconds <= EPSILON
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, frame.endSeconds);
      previous.confidenceTotal += frame.confidence;
      previous.voicedFrameCount += 1;
      previous.voicedSeconds += frameSeconds;
    } else {
      runs.push({
        startSeconds: frame.startSeconds,
        endSeconds: frame.endSeconds,
        sourceMidi: frame.quantizedMidi,
        confidenceTotal: frame.confidence,
        voicedFrameCount: 1,
        voicedSeconds: frameSeconds,
      });
    }
  }
  const gapMerged = mergeMatchingRuns(runs, options.mergeGapSeconds);
  const bridged = bridgeShortInterruptions(gapMerged, options.minimumLaneSeconds);
  return bridged.filter((run) => (
    run.endSeconds - run.startSeconds + EPSILON >= options.minimumLaneSeconds
  ));
}

function transposeForRange(
  runs: readonly MutableLaneRun[],
  range: VocalMidiRange | null,
): number {
  if (range === null || runs.length === 0) return 0;
  const sourceValues = runs.map((run) => run.sourceMidi);
  const sourceMinimum = Math.min(...sourceValues);
  const sourceMaximum = Math.max(...sourceValues);
  const minimumShift = range.minMidi - sourceMinimum;
  const maximumShift = range.maxMidi - sourceMaximum;
  if (minimumShift <= maximumShift) {
    if (minimumShift <= 0 && maximumShift >= 0) return 0;
    return minimumShift > 0 ? minimumShift : maximumShift;
  }
  const sourceCenter = (sourceMinimum + sourceMaximum) / 2;
  const rangeCenter = (range.minMidi + range.maxMidi) / 2;
  return Math.round(rangeCenter - sourceCenter);
}

function midiRange(values: readonly number[]): VocalMidiRange | null {
  if (values.length === 0) return null;
  return { minMidi: Math.min(...values), maxMidi: Math.max(...values) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function targetLanesFromRuns(
  runs: readonly MutableLaneRun[],
  options: ResolvedSongLaneOptions,
): {
  lanes: SongTargetLane[];
  transposeSemitones: number;
  clippedLaneCount: number;
} {
  const transposeSemitones = transposeForRange(runs, options.vocalRange);
  let clippedLaneCount = 0;
  const toleranceMidi = options.toleranceCents / 100;
  const lanes = runs.map<SongTargetLane>((run, index) => {
    const transposedMidi = run.sourceMidi + transposeSemitones;
    const targetMidi = options.vocalRange === null
      ? transposedMidi
      : clamp(transposedMidi, options.vocalRange.minMidi, options.vocalRange.maxMidi);
    const wasClippedToRange = targetMidi !== transposedMidi;
    if (wasClippedToRange) clippedLaneCount += 1;
    const durationSeconds = run.endSeconds - run.startSeconds;
    return {
      id: `song-lane-${index + 1}`,
      startSeconds: run.startSeconds,
      endSeconds: run.endSeconds,
      durationSeconds,
      sourceMidi: run.sourceMidi,
      targetMidi,
      lowerMidi: targetMidi - toleranceMidi,
      upperMidi: targetMidi + toleranceMidi,
      toleranceCents: options.toleranceCents,
      averageConfidence: run.confidenceTotal / run.voicedFrameCount,
      voicedFrameCount: run.voicedFrameCount,
      voicedSeconds: Math.min(durationSeconds, run.voicedSeconds),
      wasClippedToRange,
    };
  });
  return { lanes, transposeSemitones, clippedLaneCount };
}

/** Convert mono PCM into chromatic, time-aligned singing lanes locally. */
export function analyzeSongLanes(
  pcm: Float32Array,
  sampleRate: number,
  options: SongLaneAnalysisOptions = {},
): SongLaneAnalysis {
  validateSongPcm(pcm);
  const resolved = resolveSongLaneOptions(sampleRate, options);
  const durationSeconds = pcm.length / sampleRate;
  const analysisPcm = resampleMonoPcm(pcm, sampleRate, resolved.analysisSampleRate);
  const frames = extractSongPitchFrames(analysisPcm, durationSeconds, resolved);
  const runs = laneRunsFromFrames(frames, resolved);
  const { lanes, transposeSemitones, clippedLaneCount } = targetLanesFromRuns(runs, resolved);
  const voicedFrames = frames.filter((frame) => frame.quantizedMidi !== null);
  const voicedSeconds = voicedFrames.reduce(
    (total, frame) => total + Math.max(0, frame.endSeconds - frame.startSeconds),
    0,
  );
  return {
    durationSeconds,
    sourceSampleRate: sampleRate,
    analysisSampleRate: resolved.analysisSampleRate,
    frames,
    lanes,
    difficulty: resolved.difficulty,
    toleranceCents: resolved.toleranceCents,
    vocalRange: resolved.vocalRange === null ? null : { ...resolved.vocalRange },
    transposeSemitones,
    clippedLaneCount,
    sourceMidiRange: midiRange(lanes.map((lane) => lane.sourceMidi)),
    targetMidiRange: midiRange(lanes.map((lane) => lane.targetMidi)),
    voicedFrameCount: voicedFrames.length,
    voicedCoverage: durationSeconds === 0
      ? 0
      : Math.min(1, voicedSeconds / durationSeconds),
  };
}
