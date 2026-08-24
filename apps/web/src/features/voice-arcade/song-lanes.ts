import {
  detectPitch,
  smoothPitchFrames,
  type PitchFrame,
} from "@noteforge/pitch-engine";
import { splitMidiPitch } from "@noteforge/music-core";

export type SongLaneDifficulty = "easy" | "medium" | "hard" | "expert";

export interface VocalMidiRange {
  minMidi: number;
  maxMidi: number;
}

export interface SongLaneAnalysisOptions {
  /** Analysis rate after deterministic local downsampling. Defaults to 8 kHz. */
  analysisSampleRate?: number;
  frameSizeSamples?: number;
  hopSizeSamples?: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  minimumConfidence?: number;
  rmsThreshold?: number;
  a4Frequency?: number;
  smoothingRadius?: number;
  quantizationHysteresisCents?: number;
  minimumLaneSeconds?: number;
  mergeGapSeconds?: number;
  vocalRange?: VocalMidiRange;
  difficulty?: SongLaneDifficulty;
  /** Overrides the difficulty preset while retaining its label. */
  toleranceCents?: number;
}

export interface SongAnalysisChunk {
  index: number;
  total: number;
  startSample: number;
  endSample: number;
  centerSample: number;
  timeSeconds: number;
  progress: number;
}

export interface SongPitchFrame extends PitchFrame {
  frameIndex: number;
  startSeconds: number;
  endSeconds: number;
  quantizedMidi: number | null;
}

export interface SongTargetLane {
  id: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sourceMidi: number;
  targetMidi: number;
  lowerMidi: number;
  upperMidi: number;
  toleranceCents: number;
  averageConfidence: number;
  voicedFrameCount: number;
  voicedSeconds: number;
  /** True only when an over-wide source contour had to be clipped after transposition. */
  wasClippedToRange: boolean;
}

export interface SongLaneAnalysis {
  durationSeconds: number;
  sourceSampleRate: number;
  analysisSampleRate: number;
  frames: SongPitchFrame[];
  lanes: SongTargetLane[];
  difficulty: SongLaneDifficulty;
  toleranceCents: number;
  vocalRange: VocalMidiRange | null;
  transposeSemitones: number;
  clippedLaneCount: number;
  sourceMidiRange: VocalMidiRange | null;
  targetMidiRange: VocalMidiRange | null;
  voicedFrameCount: number;
  voicedCoverage: number;
}

interface ResolvedSongLaneOptions {
  analysisSampleRate: number;
  frameSizeSamples: number;
  hopSizeSamples: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
  minimumConfidence: number;
  rmsThreshold: number;
  a4Frequency: number;
  smoothingRadius: number;
  quantizationHysteresisCents: number;
  minimumLaneSeconds: number;
  mergeGapSeconds: number;
  vocalRange: VocalMidiRange | null;
  difficulty: SongLaneDifficulty;
  toleranceCents: number;
}

interface MutableLaneRun {
  startSeconds: number;
  endSeconds: number;
  sourceMidi: number;
  confidenceTotal: number;
  voicedFrameCount: number;
  voicedSeconds: number;
}

const DEFAULT_ANALYSIS_SAMPLE_RATE = 8_000;
const DEFAULT_MIN_FREQUENCY_HZ = 65;
const DEFAULT_MAX_FREQUENCY_HZ = 1_200;

export const SONG_LANE_TOLERANCE_CENTS: Readonly<
  Record<SongLaneDifficulty, number>
> = Object.freeze({
  easy: 45,
  medium: 30,
  hard: 18,
  expert: 10,
});

const DIFFICULTIES = new Set<SongLaneDifficulty>([
  "easy",
  "medium",
  "hard",
  "expert",
]);

const EPSILON = 1e-9;

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function requireUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function requireSampleCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("sampleCount must be a non-negative safe integer");
  }
}

function cloneAndValidateRange(range: VocalMidiRange | undefined): VocalMidiRange | null {
  if (range === undefined) return null;
  if (typeof range !== "object" || range === null) {
    throw new TypeError("vocalRange must be an object");
  }
  const { minMidi, maxMidi } = range;
  if (
    !Number.isInteger(minMidi) ||
    !Number.isInteger(maxMidi) ||
    minMidi < 0 ||
    maxMidi > 127 ||
    minMidi > maxMidi
  ) {
    throw new RangeError(
      "vocalRange must contain integer MIDI bounds from 0 to 127 with minMidi <= maxMidi",
    );
  }
  return { minMidi, maxMidi };
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value));
}

function resolveOptions(
  sourceSampleRate: number,
  options: SongLaneAnalysisOptions = {},
): ResolvedSongLaneOptions {
  requireFinitePositive(sourceSampleRate, "sampleRate");
  if (typeof options !== "object" || options === null) {
    throw new TypeError("options must be an object");
  }

  const analysisSampleRate = options.analysisSampleRate ??
    Math.min(sourceSampleRate, DEFAULT_ANALYSIS_SAMPLE_RATE);
  requireFinitePositive(analysisSampleRate, "analysisSampleRate");
  if (analysisSampleRate > sourceSampleRate) {
    throw new RangeError("analysisSampleRate cannot exceed sampleRate");
  }

  const minFrequencyHz = options.minFrequencyHz ?? DEFAULT_MIN_FREQUENCY_HZ;
  const maxFrequencyHz = options.maxFrequencyHz ??
    Math.min(DEFAULT_MAX_FREQUENCY_HZ, analysisSampleRate * 0.45);
  requireFinitePositive(minFrequencyHz, "minFrequencyHz");
  requireFinitePositive(maxFrequencyHz, "maxFrequencyHz");
  if (minFrequencyHz >= maxFrequencyHz) {
    throw new RangeError("minFrequencyHz must be lower than maxFrequencyHz");
  }
  if (maxFrequencyHz >= analysisSampleRate / 2) {
    throw new RangeError(
      "maxFrequencyHz must be below half of analysisSampleRate",
    );
  }

  const defaultFrameSize = nextPowerOfTwo(
    Math.max(256, analysisSampleRate * 0.05),
  );
  const frameSizeSamples = options.frameSizeSamples ?? defaultFrameSize;
  const hopSizeSamples = options.hopSizeSamples ??
    Math.max(1, Math.floor(frameSizeSamples / 4));
  requirePositiveInteger(frameSizeSamples, "frameSizeSamples");
  requirePositiveInteger(hopSizeSamples, "hopSizeSamples");
  if (hopSizeSamples > frameSizeSamples) {
    throw new RangeError("hopSizeSamples cannot exceed frameSizeSamples");
  }

  const largestLag = Math.ceil(analysisSampleRate / minFrequencyHz);
  if (frameSizeSamples < 2 * (largestLag + 1)) {
    throw new RangeError(
      "frameSizeSamples is too small for minFrequencyHz at analysisSampleRate",
    );
  }

  const minimumConfidence = options.minimumConfidence ?? 0.78;
  const rmsThreshold = options.rmsThreshold ?? 0.008;
  const a4Frequency = options.a4Frequency ?? 440;
  requireUnitInterval(minimumConfidence, "minimumConfidence");
  requireFiniteNonNegative(rmsThreshold, "rmsThreshold");
  requireFinitePositive(a4Frequency, "a4Frequency");

  const smoothingRadius = options.smoothingRadius ?? 1;
  if (!Number.isInteger(smoothingRadius) || smoothingRadius < 0) {
    throw new RangeError("smoothingRadius must be a non-negative integer");
  }

  const quantizationHysteresisCents = options.quantizationHysteresisCents ?? 15;
  requireFiniteNonNegative(
    quantizationHysteresisCents,
    "quantizationHysteresisCents",
  );
  if (quantizationHysteresisCents >= 50) {
    throw new RangeError("quantizationHysteresisCents must be below 50");
  }

  const minimumLaneSeconds = options.minimumLaneSeconds ?? 0.12;
  const mergeGapSeconds = options.mergeGapSeconds ?? 0.09;
  requireFiniteNonNegative(minimumLaneSeconds, "minimumLaneSeconds");
  requireFiniteNonNegative(mergeGapSeconds, "mergeGapSeconds");

  const difficulty = options.difficulty ?? "medium";
  if (!DIFFICULTIES.has(difficulty)) {
    throw new RangeError(
      "difficulty must be easy, medium, hard, or expert",
    );
  }
  const toleranceCents = options.toleranceCents ??
    SONG_LANE_TOLERANCE_CENTS[difficulty];
  requireFinitePositive(toleranceCents, "toleranceCents");
  if (toleranceCents > 100) {
    throw new RangeError("toleranceCents cannot exceed 100");
  }

  return {
    analysisSampleRate,
    frameSizeSamples,
    hopSizeSamples,
    minFrequencyHz,
    maxFrequencyHz,
    minimumConfidence,
    rmsThreshold,
    a4Frequency,
    smoothingRadius,
    quantizationHysteresisCents,
    minimumLaneSeconds,
    mergeGapSeconds,
    vocalRange: cloneAndValidateRange(options.vocalRange),
    difficulty,
    toleranceCents,
  };
}

function validatePcm(pcm: Float32Array): void {
  if (!(pcm instanceof Float32Array)) {
    throw new TypeError("pcm must be a Float32Array containing mono samples");
  }
  for (let index = 0; index < pcm.length; index += 1) {
    if (!Number.isFinite(pcm[index])) {
      throw new RangeError(`pcm[${index}] must be finite`);
    }
  }
}

/**
 * Area-average resampling is deterministic, cheap, and attenuates high-frequency
 * content before the monophonic detector. The input is never modified.
 */
export function resampleMonoPcm(
  pcm: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  validatePcm(pcm);
  requireFinitePositive(sourceSampleRate, "sourceSampleRate");
  requireFinitePositive(targetSampleRate, "targetSampleRate");
  if (targetSampleRate > sourceSampleRate) {
    throw new RangeError("targetSampleRate cannot exceed sourceSampleRate");
  }
  if (targetSampleRate === sourceSampleRate) return pcm.slice();

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.floor(pcm.length / ratio);
  const output = new Float32Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceStart = outputIndex * ratio;
    const sourceEnd = Math.min(pcm.length, (outputIndex + 1) * ratio);
    const firstSourceIndex = Math.floor(sourceStart);
    const finalSourceIndex = Math.ceil(sourceEnd);
    let weightedSum = 0;
    let totalWeight = 0;

    for (
      let sourceIndex = firstSourceIndex;
      sourceIndex < finalSourceIndex;
      sourceIndex += 1
    ) {
      const overlap = Math.max(
        0,
        Math.min(sourceEnd, sourceIndex + 1) -
          Math.max(sourceStart, sourceIndex),
      );
      if (overlap > 0 && sourceIndex < pcm.length) {
        weightedSum += pcm[sourceIndex] * overlap;
        totalWeight += overlap;
      }
    }
    output[outputIndex] = totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  return output;
}

function chunksForResolvedOptions(
  sampleCount: number,
  options: ResolvedSongLaneOptions,
): SongAnalysisChunk[] {
  if (sampleCount === 0) return [];

  const frameSize = Math.min(options.frameSizeSamples, sampleCount);
  const starts: number[] = [0];
  if (sampleCount > frameSize) {
    for (
      let start = options.hopSizeSamples;
      start + frameSize <= sampleCount;
      start += options.hopSizeSamples
    ) {
      starts.push(start);
    }
    const finalStart = sampleCount - frameSize;
    if (starts.at(-1) !== finalStart) starts.push(finalStart);
  }

  const total = starts.length;
  return starts.map((startSample, index) => {
    const endSample = startSample + frameSize;
    const centerSample = (startSample + endSample) / 2;
    return {
      index,
      total,
      startSample,
      endSample,
      centerSample,
      timeSeconds: centerSample / options.analysisSampleRate,
      progress: (index + 1) / total,
    };
  });
}

/**
 * Enumerate stable work units for a progress bar or future Web Worker without
 * performing pitch detection. `sampleCount` and `sampleRate` describe the
 * source PCM; returned sample offsets address the deterministic analysis-rate
 * buffer produced by `resampleMonoPcm`.
 */
export function createSongAnalysisChunks(
  sampleCount: number,
  sampleRate: number,
  options: SongLaneAnalysisOptions = {},
): SongAnalysisChunk[] {
  requireSampleCount(sampleCount);
  const resolved = resolveOptions(sampleRate, options);
  const analysisSampleCount = Math.floor(
    sampleCount * resolved.analysisSampleRate / sampleRate,
  );
  return chunksForResolvedOptions(analysisSampleCount, resolved);
}

function quantizeFrames(
  frames: readonly SongPitchFrame[],
  hysteresisCents: number,
): SongPitchFrame[] {
  let previousMidi: number | null = null;
  return frames.map((frame) => {
    if (!frame.voiced || frame.midiFloat === null || !Number.isFinite(frame.midiFloat)) {
      previousMidi = null;
      return { ...frame, quantizedMidi: null };
    }

    const nearestMidi = splitMidiPitch(frame.midiFloat).nearestMidi;
    const quantizedMidi = previousMidi !== null &&
        Math.abs(frame.midiFloat - previousMidi) * 100 <=
          50 + hysteresisCents
      ? previousMidi
      : nearestMidi;
    previousMidi = quantizedMidi;
    return { ...frame, quantizedMidi };
  });
}

function extractPitchFrames(
  pcm: Float32Array,
  durationSeconds: number,
  options: ResolvedSongLaneOptions,
): SongPitchFrame[] {
  const chunks = chunksForResolvedOptions(pcm.length, options);
  const detected = chunks.map<SongPitchFrame>((chunk) => ({
    ...detectPitch(pcm.subarray(chunk.startSample, chunk.endSample), {
      sampleRate: options.analysisSampleRate,
      minFrequency: options.minFrequencyHz,
      maxFrequency: options.maxFrequencyHz,
      minConfidence: options.minimumConfidence,
      rmsThreshold: options.rmsThreshold,
      a4Frequency: options.a4Frequency,
      timeSeconds: chunk.timeSeconds,
    }),
    frameIndex: chunk.index,
    startSeconds: 0,
    endSeconds: durationSeconds,
    quantizedMidi: null,
  }));

  const smoothed = smoothPitchFrames(detected, {
    radius: options.smoothingRadius,
    minSamples: 2 * options.smoothingRadius + 1,
    maxFrameGapSeconds: Math.max(
      0.1,
      (options.hopSizeSamples / options.analysisSampleRate) * 1.5,
    ),
    a4Frequency: options.a4Frequency,
  });

  const timed = smoothed.map((frame, index): SongPitchFrame => {
    const previous = smoothed[index - 1];
    const next = smoothed[index + 1];
    const startSeconds = previous === undefined
      ? 0
      : (previous.timeSeconds + frame.timeSeconds) / 2;
    const endSeconds = next === undefined
      ? durationSeconds
      : (frame.timeSeconds + next.timeSeconds) / 2;
    return {
      ...frame,
      startSeconds: Math.max(0, Math.min(durationSeconds, startSeconds)),
      endSeconds: Math.max(0, Math.min(durationSeconds, endSeconds)),
    };
  });

  return quantizeFrames(timed, options.quantizationHysteresisCents);
}

function mergeMatchingRuns(
  runs: readonly MutableLaneRun[],
  maximumGapSeconds: number,
): MutableLaneRun[] {
  const merged: MutableLaneRun[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.sourceMidi === run.sourceMidi &&
      run.startSeconds - previous.endSeconds <= maximumGapSeconds + EPSILON
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
      current.endSeconds - current.startSeconds + EPSILON < minimumLaneSeconds &&
      previous.sourceMidi === next.sourceMidi &&
      current.startSeconds - previous.endSeconds <= EPSILON &&
      next.startSeconds - current.endSeconds <= EPSILON
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
      previous !== undefined &&
      previous.sourceMidi === frame.quantizedMidi &&
      frame.startSeconds - previous.endSeconds <= EPSILON
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
  const bridged = bridgeShortInterruptions(
    gapMerged,
    options.minimumLaneSeconds,
  );
  return bridged.filter(
    (run) =>
      run.endSeconds - run.startSeconds + EPSILON >= options.minimumLaneSeconds,
  );
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
      : clamp(
        transposedMidi,
        options.vocalRange.minMidi,
        options.vocalRange.maxMidi,
      );
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

export function toleranceCentsForDifficulty(
  difficulty: SongLaneDifficulty,
): number {
  if (!DIFFICULTIES.has(difficulty)) {
    throw new RangeError(
      "difficulty must be easy, medium, hard, or expert",
    );
  }
  return SONG_LANE_TOLERANCE_CENTS[difficulty];
}

/**
 * Convert mono PCM into chromatic, time-aligned singing lanes entirely locally.
 * The function is synchronous and deterministic; identical samples/options yield
 * byte-for-byte equivalent numeric output.
 */
export function analyzeSongLanes(
  pcm: Float32Array,
  sampleRate: number,
  options: SongLaneAnalysisOptions = {},
): SongLaneAnalysis {
  validatePcm(pcm);
  const resolved = resolveOptions(sampleRate, options);
  const durationSeconds = pcm.length / sampleRate;
  const analysisPcm = resampleMonoPcm(
    pcm,
    sampleRate,
    resolved.analysisSampleRate,
  );
  const frames = extractPitchFrames(analysisPcm, durationSeconds, resolved);
  const runs = laneRunsFromFrames(frames, resolved);
  const { lanes, transposeSemitones, clippedLaneCount } =
    targetLanesFromRuns(runs, resolved);
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
