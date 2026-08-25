import type { PitchObservation } from "@/audio/note-input";
import { clamp } from "@/lib/numeric";

export interface AttemptScoringProfile {
  readonly targetMidiFloat?: number;
  readonly toleranceCents?: number;
  readonly minimumConfidence?: number;
  readonly maximumVoicedGapSeconds?: number;
  readonly envelopeCycleSeconds?: number;
}

const MIDI_MINIMUM = 29;
const MIDI_MAXIMUM = 88;
const MIDI_BINS_PER_SEMITONE = 100;
const MIDI_BIN_COUNT = (MIDI_MAXIMUM - MIDI_MINIMUM) * MIDI_BINS_PER_SEMITONE;
const PHASE_BIN_COUNT = 32;
const RMS_BIN_COUNT = 32;
const ENVELOPE_BIN_COUNT = PHASE_BIN_COUNT * RMS_BIN_COUNT;
const HISTOGRAM_CHUNK_SIZE = 64;
type BoundedHistogram = readonly (readonly number[])[];

export interface AttemptScoringAggregate {
  readonly totalFrameCount: number;
  readonly voicedCandidateCount: number;
  readonly analyzedFrameCount: number;
  readonly confidenceSum: number;
  readonly midiSum: number;
  readonly midiSquaredSum: number;
  readonly pitchHistogram: BoundedHistogram;
  readonly pitchHistogramMidiSums: BoundedHistogram;
  readonly inToleranceFrameCount: number;
  readonly absoluteErrorCentsSum: number;
  readonly rmsFrameCount: number;
  readonly rmsSum: number;
  readonly minimumRms: number;
  readonly maximumRms: number;
  readonly envelopeCounts: BoundedHistogram;
  readonly envelopeRmsSums: BoundedHistogram;
  readonly envelopeMinimumRms: number;
  readonly envelopeMaximumRms: number;
}

function emptyHistogram(binCount: number): BoundedHistogram {
  return Array.from(
    { length: Math.ceil(binCount / HISTOGRAM_CHUNK_SIZE) },
    (_, chunkIndex) => Array.from({
      length: Math.min(HISTOGRAM_CHUNK_SIZE, binCount - chunkIndex * HISTOGRAM_CHUNK_SIZE),
    }, () => 0),
  );
}

export function createAttemptScoringAggregate(): AttemptScoringAggregate {
  return {
    totalFrameCount: 0,
    voicedCandidateCount: 0,
    analyzedFrameCount: 0,
    confidenceSum: 0,
    midiSum: 0,
    midiSquaredSum: 0,
    pitchHistogram: emptyHistogram(MIDI_BIN_COUNT),
    pitchHistogramMidiSums: emptyHistogram(MIDI_BIN_COUNT),
    inToleranceFrameCount: 0,
    absoluteErrorCentsSum: 0,
    rmsFrameCount: 0,
    rmsSum: 0,
    minimumRms: Number.POSITIVE_INFINITY,
    maximumRms: Number.NEGATIVE_INFINITY,
    envelopeCounts: emptyHistogram(ENVELOPE_BIN_COUNT),
    envelopeRmsSums: emptyHistogram(ENVELOPE_BIN_COUNT),
    envelopeMinimumRms: Number.POSITIVE_INFINITY,
    envelopeMaximumRms: Number.NEGATIVE_INFINITY,
  };
}

function midiBin(midiFloat: number): number {
  return clamp(
    Math.floor((midiFloat - MIDI_MINIMUM) * MIDI_BINS_PER_SEMITONE),
    0,
    MIDI_BIN_COUNT - 1,
  );
}

function increment(values: BoundedHistogram, index: number, amount: number): BoundedHistogram {
  const chunkIndex = Math.floor(index / HISTOGRAM_CHUNK_SIZE);
  const valueIndex = index % HISTOGRAM_CHUNK_SIZE;
  const chunk = values[chunkIndex]!.slice();
  chunk[valueIndex] = (chunk[valueIndex] ?? 0) + amount;
  const next = values.slice();
  next[chunkIndex] = chunk;
  return next;
}

function forEachBin(
  histogram: BoundedHistogram,
  visit: (value: number, index: number) => void,
): void {
  histogram.forEach((chunk, chunkIndex) => {
    chunk.forEach((value, valueIndex) => {
      visit(value, chunkIndex * HISTOGRAM_CHUNK_SIZE + valueIndex);
    });
  });
}

function histogramValue(histogram: BoundedHistogram, index: number): number {
  return histogram[Math.floor(index / HISTOGRAM_CHUNK_SIZE)]?.[
    index % HISTOGRAM_CHUNK_SIZE
  ] ?? 0;
}

export function advanceAttemptScoringAggregate(
  aggregate: Readonly<AttemptScoringAggregate>,
  observation: Readonly<PitchObservation>,
  elapsedSeconds: number,
  profile: Readonly<AttemptScoringProfile> | null,
  pitchAdmitted: boolean,
): AttemptScoringAggregate {
  const validRms = Number.isFinite(observation.rms) && observation.rms >= 0;
  const envelopeRms = validRms && observation.rms >= 1e-6;
  let envelopeCounts = aggregate.envelopeCounts;
  let envelopeRmsSums = aggregate.envelopeRmsSums;
  if (envelopeRms && profile?.envelopeCycleSeconds) {
    const phase = ((elapsedSeconds % profile.envelopeCycleSeconds)
      + profile.envelopeCycleSeconds) % profile.envelopeCycleSeconds
      / profile.envelopeCycleSeconds;
    const phaseBin = Math.min(PHASE_BIN_COUNT - 1, Math.floor(phase * PHASE_BIN_COUNT));
    const rmsBin = Math.min(RMS_BIN_COUNT - 1, Math.floor(Math.min(1, observation.rms) * RMS_BIN_COUNT));
    const bin = phaseBin * RMS_BIN_COUNT + rmsBin;
    envelopeCounts = increment(envelopeCounts, bin, 1);
    envelopeRmsSums = increment(envelopeRmsSums, bin, observation.rms);
  }

  const voicedCandidate = pitchAdmitted
    && observation.voiced
    && observation.midiFloat !== null
    && Number.isFinite(observation.midiFloat)
    && Number.isFinite(observation.confidence)
    && observation.confidence >= 0
    && observation.confidence <= 1;
  const analyzed = voicedCandidate
    && observation.confidence >= (profile?.minimumConfidence ?? 0.5);
  const midiFloat = analyzed ? observation.midiFloat! : 0;
  const targetError = analyzed && profile?.targetMidiFloat !== undefined
    ? 100 * (midiFloat - profile.targetMidiFloat)
    : null;
  const inTolerance = targetError !== null
    && profile?.toleranceCents !== undefined
    && Math.abs(targetError) <= profile.toleranceCents + 1e-9;

  return {
    totalFrameCount: aggregate.totalFrameCount + 1,
    voicedCandidateCount: aggregate.voicedCandidateCount + (voicedCandidate ? 1 : 0),
    analyzedFrameCount: aggregate.analyzedFrameCount + (analyzed ? 1 : 0),
    confidenceSum: aggregate.confidenceSum + (voicedCandidate ? observation.confidence : 0),
    midiSum: aggregate.midiSum + midiFloat,
    midiSquaredSum: aggregate.midiSquaredSum + midiFloat * midiFloat,
    pitchHistogram: analyzed
      ? increment(aggregate.pitchHistogram, midiBin(midiFloat), 1)
      : aggregate.pitchHistogram,
    pitchHistogramMidiSums: analyzed
      ? increment(aggregate.pitchHistogramMidiSums, midiBin(midiFloat), midiFloat)
      : aggregate.pitchHistogramMidiSums,
    inToleranceFrameCount: aggregate.inToleranceFrameCount + (inTolerance ? 1 : 0),
    absoluteErrorCentsSum: aggregate.absoluteErrorCentsSum
      + (targetError === null ? 0 : Math.abs(targetError)),
    rmsFrameCount: aggregate.rmsFrameCount + (validRms ? 1 : 0),
    rmsSum: aggregate.rmsSum + (validRms ? observation.rms : 0),
    minimumRms: validRms ? Math.min(aggregate.minimumRms, observation.rms) : aggregate.minimumRms,
    maximumRms: validRms ? Math.max(aggregate.maximumRms, observation.rms) : aggregate.maximumRms,
    envelopeCounts,
    envelopeRmsSums,
    envelopeMinimumRms: envelopeRms
      ? Math.min(aggregate.envelopeMinimumRms, observation.rms)
      : aggregate.envelopeMinimumRms,
    envelopeMaximumRms: envelopeRms
      ? Math.max(aggregate.envelopeMaximumRms, observation.rms)
      : aggregate.envelopeMaximumRms,
  };
}

export function aggregateMedianMidi(
  aggregate: Readonly<AttemptScoringAggregate>,
): number | null {
  if (aggregate.analyzedFrameCount === 0) return null;
  const midpoint = aggregate.analyzedFrameCount / 2;
  let count = 0;
  for (let index = 0; index < MIDI_BIN_COUNT; index += 1) {
    count += histogramValue(aggregate.pitchHistogram, index);
    if (count >= midpoint) {
      const binCount = histogramValue(aggregate.pitchHistogram, index);
      return histogramValue(aggregate.pitchHistogramMidiSums, index) / binCount;
    }
  }
  return null;
}

export function aggregatePitchCountWithin(
  aggregate: Readonly<AttemptScoringAggregate>,
  targetMidiFloat: number,
  toleranceCents: number,
): number {
  let count = 0;
  forEachBin(aggregate.pitchHistogram, (binCount, index) => {
    const midi = binCount > 0
      ? histogramValue(aggregate.pitchHistogramMidiSums, index) / binCount
      : MIDI_MINIMUM + (index + 0.5) / MIDI_BINS_PER_SEMITONE;
    if (Math.abs(100 * (midi - targetMidiFloat)) <= toleranceCents + 0.5) count += binCount;
  });
  return count;
}

export function aggregateAbsoluteErrorCents(
  aggregate: Readonly<AttemptScoringAggregate>,
  targetMidiFloat: number,
): number {
  let sum = 0;
  forEachBin(aggregate.pitchHistogram, (binCount, index) => {
    const midi = binCount > 0
      ? histogramValue(aggregate.pitchHistogramMidiSums, index) / binCount
      : MIDI_MINIMUM + (index + 0.5) / MIDI_BINS_PER_SEMITONE;
    sum += binCount * Math.abs(100 * (midi - targetMidiFloat));
  });
  return sum;
}

export function aggregateEnvelopeScore(
  aggregate: Readonly<AttemptScoringAggregate>,
  points: readonly number[],
  interpolate: (points: readonly number[], progress: number) => number,
): number | undefined {
  const minimum = aggregate.envelopeMinimumRms;
  const maximum = aggregate.envelopeMaximumRms;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return undefined;
  if (maximum - minimum < 1e-5) {
    return points.every((point) => Math.abs(point - points[0]!) < 0.05) ? 100 : 0;
  }
  let count = 0;
  let error = 0;
  forEachBin(aggregate.envelopeCounts, (binCount, index) => {
    if (binCount === 0) return;
    const phaseBin = Math.floor(index / RMS_BIN_COUNT);
    const meanRms = histogramValue(aggregate.envelopeRmsSums, index) / binCount;
    const actual = (meanRms - minimum) / (maximum - minimum);
    const progress = (phaseBin + 0.5) / PHASE_BIN_COUNT;
    error += binCount * Math.abs(actual - interpolate(points, progress));
    count += binCount;
  });
  return count >= 4 ? Math.max(0, (1 - error / count) * 100) : undefined;
}
