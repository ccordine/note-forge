import {
  scoreSustainedNote,
  type AttemptMetrics,
  type NoteTarget,
  type PitchFrame,
  type SustainedNoteScoringOptions,
} from "@noteforge/trainer-core";
import type { AttemptRunnerState } from "./attempt-runner";
import {
  aggregateAbsoluteErrorCents,
  aggregateMedianMidi,
  aggregatePitchCountWithin,
} from "./attempt-scoring-aggregate";

export type WeightedPitchFrame = PitchFrame & {
  readonly scoringWeight?: number;
};

function scoringWeight(frame: Readonly<WeightedPitchFrame>): number {
  const weight = frame.scoringWeight ?? 1;
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

export function weightedMedian(
  values: readonly { readonly value: number; readonly weight: number }[],
): number | null {
  const usable = values
    .filter((item) => Number.isFinite(item.value) && item.weight > 0)
    .sort((left, right) => left.value - right.value);
  const totalWeight = usable.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return null;
  const midpoint = totalWeight / 2;
  let cumulativeWeight = 0;
  for (const item of usable) {
    cumulativeWeight += item.weight;
    if (cumulativeWeight >= midpoint) return item.value;
  }
  return usable.at(-1)?.value ?? null;
}

export function weightedFrameRatio(
  frames: readonly Readonly<WeightedPitchFrame>[],
  predicate: (frame: Readonly<WeightedPitchFrame>) => boolean,
): number {
  const totalWeight = frames.reduce((sum, frame) => sum + scoringWeight(frame), 0);
  if (totalWeight <= 0) return 0;
  const matchingWeight = frames.reduce((sum, frame) => (
    predicate(frame) ? sum + scoringWeight(frame) : sum
  ), 0);
  return matchingWeight / totalWeight;
}

function weightedSlope(
  points: readonly {
    readonly time: number;
    readonly value: number;
    readonly weight: number;
  }[],
): number {
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  if (totalWeight <= 0 || points.length < 2) return 0;
  const meanTime = points.reduce(
    (sum, point) => sum + point.time * point.weight,
    0,
  ) / totalWeight;
  const meanValue = points.reduce(
    (sum, point) => sum + point.value * point.weight,
    0,
  ) / totalWeight;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const centeredTime = point.time - meanTime;
    numerator += point.weight * centeredTime * (point.value - meanValue);
    denominator += point.weight * centeredTime * centeredTime;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Score the bounded contour while treating every retained point as the number
 * of authoritative observations it represents. The base scorer still owns
 * attack, temporal-run, vibrato, and envelope analysis; the aggregate metrics
 * below cannot be biased toward the exact recent display ring after archive
 * decimation.
 */
export function scoreWeightedSustainedNote<Configuration>(
  timeline: Readonly<AttemptRunnerState<Configuration>>,
  frames: readonly Readonly<WeightedPitchFrame>[],
  target: NoteTarget,
  options: SustainedNoteScoringOptions = {},
): AttemptMetrics {
  const base = scoreSustainedNote(frames, target, options);
  const aggregate = timeline.scoringAggregate;
  const targetMidiFloat = target.midi + target.centsOffset / 100;
  const minimumConfidence = options.minimumConfidence ?? 0.5;
  const voicedCandidates = frames.filter((frame) => (
    frame.voiced
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat)
    && Number.isFinite(frame.confidence)
    && frame.confidence >= 0
    && frame.confidence <= 1
    && scoringWeight(frame) > 0
  ));
  const analyzed = voicedCandidates.flatMap((frame) => (
    frame.confidence >= minimumConfidence
      ? [{
        frame,
        errorCents: 100 * (frame.midiFloat! - targetMidiFloat),
        weight: scoringWeight(frame),
      }]
      : []
  ));
  const totalFrameCount = aggregate.totalFrameCount;
  const voicedFrameCount = aggregate.voicedCandidateCount;
  const analyzedFrameCount = aggregate.analyzedFrameCount;
  const detectorConfidence = voicedFrameCount > 0
    ? aggregate.confidenceSum / voicedFrameCount
    : undefined;

  const metrics: AttemptMetrics = {
    ...base,
    totalFrameCount,
    voicedFrameCount,
    analyzedFrameCount,
    detectorConfidence,
  };
  if (analyzedFrameCount <= 0) return metrics;

  const aggregateMedianMidiFloat = aggregateMedianMidi(aggregate);
  const medianErrorCents = aggregateMedianMidiFloat === null
    ? weightedMedian(analyzed.map((item) => ({ value: item.errorCents, weight: item.weight })))!
    : 100 * (aggregateMedianMidiFloat - targetMidiFloat);
  const profileMatches = timeline.scoringProfile?.targetMidiFloat === targetMidiFloat
    && timeline.scoringProfile.toleranceCents === (options.toleranceCents ?? 20)
    && (timeline.scoringProfile.minimumConfidence ?? 0.5) === minimumConfidence;
  metrics.medianErrorCents = medianErrorCents;
  metrics.meanAbsoluteErrorCents = (
    profileMatches
      ? aggregate.absoluteErrorCentsSum
      : aggregateAbsoluteErrorCents(aggregate, targetMidiFloat)
  ) / analyzedFrameCount;
  const medianMidi = targetMidiFloat + medianErrorCents / 100;
  const squaredDistanceSum = aggregate.midiSquaredSum
    - 2 * medianMidi * aggregate.midiSum
    + analyzedFrameCount * medianMidi * medianMidi;
  metrics.stabilityCents = 100 * Math.sqrt(Math.max(0, squaredDistanceSum / analyzedFrameCount));
  if (!base.vibrato?.detected) {
    metrics.vibratoAdjustedStabilityCents = metrics.stabilityCents;
  }
  metrics.driftCentsPerSecond = weightedSlope(analyzed.map((item) => ({
    time: item.frame.timeSeconds,
    value: item.errorCents,
    weight: item.weight,
  })));
  const toleranceCents = options.toleranceCents ?? 20;
  const toleranceEpsilon = Math.max(1e-9, toleranceCents * 1e-10);
  metrics.inToleranceRatio = (
    profileMatches
      ? aggregate.inToleranceFrameCount
      : aggregatePitchCountWithin(aggregate, targetMidiFloat, toleranceCents + toleranceEpsilon)
  ) / analyzedFrameCount;

  const longestRun = timeline.longestVoicedRun;
  if (longestRun) {
    metrics.holdDurationMs = Math.max(
      0,
      (longestRun.endedAtSeconds - longestRun.startedAtSeconds) * 1_000,
    );
    const denominator = longestRun.frameCount * longestRun.sumSquaredTimeSeconds
      - longestRun.sumTimeSeconds * longestRun.sumTimeSeconds;
    metrics.driftCentsPerSecond = denominator > 0
      ? 100 * (
        longestRun.frameCount * longestRun.sumTimeMidiProduct
        - longestRun.sumTimeSeconds * longestRun.sumMidiFloat
      ) / denominator
      : 0;
  }

  if (aggregate.rmsFrameCount > 0 && base.volume) {
    const minimumRms = aggregate.minimumRms;
    const maximumRms = aggregate.maximumRms;
    const floor = 1e-12;
    metrics.volume = {
      ...base.volume,
      meanRms: aggregate.rmsSum / aggregate.rmsFrameCount,
      minimumRms,
      maximumRms,
      dynamicRangeDb: 20 * (
        Math.log10(Math.max(maximumRms, floor))
        - Math.log10(Math.max(minimumRms, floor))
      ),
      envelope: timeline.evidenceStride > 1 ? [] : base.volume.envelope,
    };
  }
  if (timeline.evidenceStride > 1) {
    metrics.vibrato = undefined;
    metrics.vibratoCenterCents = undefined;
    metrics.vibratoDepthCents = undefined;
    metrics.vibratoRateHz = undefined;
    metrics.vibratoRegularity = undefined;
    metrics.vibratoAdjustedStabilityCents = metrics.stabilityCents;
  }
  return metrics;
}
