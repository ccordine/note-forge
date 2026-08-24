import { splitMidiPitch } from "@noteforge/music-core";
import { detectPitch, smoothPitchFrames } from "@noteforge/pitch-engine";
import { resolveSongLaneOptions } from "./song-lane-options";
import type {
  ResolvedSongLaneOptions,
  SongAnalysisChunk,
  SongLaneAnalysisOptions,
  SongPitchFrame,
} from "./song-lane-types";

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function requireSampleCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("sampleCount must be a non-negative safe integer");
  }
}

export function validateSongPcm(pcm: Float32Array): void {
  if (!(pcm instanceof Float32Array)) {
    throw new TypeError("pcm must be a Float32Array containing mono samples");
  }
  for (let index = 0; index < pcm.length; index += 1) {
    if (!Number.isFinite(pcm[index])) {
      throw new RangeError(`pcm[${index}] must be finite`);
    }
  }
}

/** Deterministic area-average downsampling; the input is never modified. */
export function resampleMonoPcm(
  pcm: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  validateSongPcm(pcm);
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
    for (let sourceIndex = firstSourceIndex; sourceIndex < finalSourceIndex; sourceIndex += 1) {
      const overlap = Math.max(
        0,
        Math.min(sourceEnd, sourceIndex + 1) - Math.max(sourceStart, sourceIndex),
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

export function createSongAnalysisChunks(
  sampleCount: number,
  sampleRate: number,
  options: SongLaneAnalysisOptions = {},
): SongAnalysisChunk[] {
  requireSampleCount(sampleCount);
  const resolved = resolveSongLaneOptions(sampleRate, options);
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
    const quantizedMidi = previousMidi !== null
      && Math.abs(frame.midiFloat - previousMidi) * 100 <= 50 + hysteresisCents
      ? previousMidi
      : nearestMidi;
    previousMidi = quantizedMidi;
    return { ...frame, quantizedMidi };
  });
}

export function extractSongPitchFrames(
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
