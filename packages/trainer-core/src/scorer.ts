import type {
  AttemptMetrics,
  NoteTarget,
  PitchFrame,
  VibratoMetrics,
  VolumeEnvelopePoint,
  VolumeMetrics,
} from "./types";

export interface VibratoScoringOptions {
  minimumDepthCents?: number;
  minimumRateHz?: number;
  maximumRateHz?: number;
  minimumCycles?: number;
}

export interface SustainedNoteScoringOptions {
  /** Symmetric target lane. Defaults to 20 cents. */
  toleranceCents?: number;
  /** Timestamp of the prompt in the same clock domain as each frame. */
  promptTimeSeconds?: number;
  minimumConfidence?: number;
  /** Robust attack estimate window beginning at the first analyzable frame. */
  attackWindowSeconds?: number;
  /** A larger gap ends a continuous hold. Inferred from frame cadence by default. */
  maximumVoicedGapSeconds?: number;
  volumeEnvelopePoints?: number;
  vibrato?: VibratoScoringOptions;
}

interface AnalyzedFrame {
  frame: PitchFrame;
  midiFloat: number;
  errorCents: number;
}

const DEFAULT_TOLERANCE_CENTS = 20;
const DEFAULT_MINIMUM_CONFIDENCE = 0.5;
const DEFAULT_ATTACK_WINDOW_SECONDS = 0.08;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const quantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
};

const median = (values: readonly number[]): number => quantile(values, 0.5);

const rootMeanSquare = (values: readonly number[]): number =>
  Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);

const sampleStandardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length,
  );
};

const finiteMidi = (frame: PitchFrame): number | null => {
  if (frame.midiFloat !== null && Number.isFinite(frame.midiFloat)) {
    return frame.midiFloat;
  }
  if (frame.frequencyHz !== null && frame.frequencyHz > 0 && Number.isFinite(frame.frequencyHz)) {
    return 69 + 12 * Math.log2(frame.frequencyHz / 440);
  }
  return null;
};

const linearSlope = (times: readonly number[], values: readonly number[]): number => {
  if (times.length < 2) return 0;
  const averageTime = mean(times);
  const averageValue = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < times.length; index += 1) {
    const centeredTime = times[index] - averageTime;
    numerator += centeredTime * (values[index] - averageValue);
    denominator += centeredTime * centeredTime;
  }
  return denominator > 0 ? numerator / denominator : 0;
};

const inferHopSeconds = (frames: readonly PitchFrame[]): number => {
  const hops: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const hop = frames[index].timeSeconds - frames[index - 1].timeSeconds;
    if (hop > 0 && Number.isFinite(hop)) hops.push(hop);
  }
  return hops.length > 0 ? median(hops) : 0;
};

const longestContinuousRun = (
  frames: readonly AnalyzedFrame[],
  maximumGapSeconds: number,
): AnalyzedFrame[] => {
  if (frames.length < 2) return [...frames];
  let bestStart = 0;
  let bestEnd = 0;
  let currentStart = 0;
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].frame.timeSeconds - frames[index - 1].frame.timeSeconds > maximumGapSeconds) {
      if (index - 1 - currentStart > bestEnd - bestStart) {
        bestStart = currentStart;
        bestEnd = index - 1;
      }
      currentStart = index;
    }
  }
  if (frames.length - 1 - currentStart > bestEnd - bestStart) {
    bestStart = currentStart;
    bestEnd = frames.length - 1;
  }
  return frames.slice(bestStart, bestEnd + 1);
};

const downsampleVolume = (
  frames: readonly PitchFrame[],
  requestedPoints: number,
): VolumeEnvelopePoint[] => {
  if (frames.length === 0 || requestedPoints <= 0) return [];
  const pointCount = Math.min(frames.length, Math.max(1, Math.floor(requestedPoints)));
  const result: VolumeEnvelopePoint[] = [];
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const start = Math.floor((pointIndex * frames.length) / pointCount);
    const end = Math.max(start + 1, Math.floor(((pointIndex + 1) * frames.length) / pointCount));
    const slice = frames.slice(start, end);
    result.push({
      timeSeconds: mean(slice.map((frame) => frame.timeSeconds)),
      rms: mean(slice.map((frame) => Math.max(0, frame.rms))),
    });
  }
  return result;
};

const scoreVolume = (frames: readonly PitchFrame[], requestedPoints: number): VolumeMetrics | undefined => {
  const rmsValues = frames.map((frame) => frame.rms).filter((rms) => rms >= 0 && Number.isFinite(rms));
  if (rmsValues.length === 0) return undefined;
  let minimumRms = Number.POSITIVE_INFINITY;
  let maximumRms = Number.NEGATIVE_INFINITY;
  for (const rms of rmsValues) {
    minimumRms = Math.min(minimumRms, rms);
    maximumRms = Math.max(maximumRms, rms);
  }
  const floor = 1e-12;
  return {
    meanRms: mean(rmsValues),
    minimumRms,
    maximumRms,
    dynamicRangeDb: 20 * Math.log10(Math.max(maximumRms, floor) / Math.max(minimumRms, floor)),
    envelope: downsampleVolume(frames, requestedPoints),
  };
};

const positiveZeroCrossingTimes = (times: readonly number[], values: readonly number[]): number[] => {
  const crossings: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const before = values[index - 1];
    const after = values[index];
    if (before <= 0 && after > 0) {
      const span = after - before;
      const fraction = span === 0 ? 0 : -before / span;
      crossings.push(times[index - 1] + fraction * (times[index] - times[index - 1]));
    }
  }
  return crossings;
};

interface VibratoAnalysis {
  metrics: VibratoMetrics;
  adjustedStabilityCents?: number;
}

interface SinusoidFit {
  residualRms: number;
  sineCoefficient: number;
  cosineCoefficient: number;
}

const fitSinusoid = (
  times: readonly number[],
  residual: readonly number[],
  frequencyHz: number,
): SinusoidFit | undefined => {
  let sineSquared = 0;
  let cosineSquared = 0;
  let sineCosine = 0;
  let residualSine = 0;
  let residualCosine = 0;
  for (let index = 0; index < residual.length; index += 1) {
    const angle = 2 * Math.PI * frequencyHz * times[index];
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    sineSquared += sine * sine;
    cosineSquared += cosine * cosine;
    sineCosine += sine * cosine;
    residualSine += residual[index] * sine;
    residualCosine += residual[index] * cosine;
  }
  const determinant = sineSquared * cosineSquared - sineCosine * sineCosine;
  if (Math.abs(determinant) <= 1e-12) return undefined;
  const sineCoefficient =
    (residualSine * cosineSquared - residualCosine * sineCosine) / determinant;
  const cosineCoefficient =
    (residualCosine * sineSquared - residualSine * sineCosine) / determinant;
  const nonPeriodicResidual = residual.map((value, index) => {
    const angle = 2 * Math.PI * frequencyHz * times[index];
    return value - sineCoefficient * Math.sin(angle) - cosineCoefficient * Math.cos(angle);
  });
  return {
    residualRms: rootMeanSquare(nonPeriodicResidual),
    sineCoefficient,
    cosineCoefficient,
  };
};

const analyzeVibrato = (
  frames: readonly AnalyzedFrame[],
  options: VibratoScoringOptions,
): VibratoAnalysis | undefined => {
  if (frames.length < 4) return undefined;
  const times = frames.map((item) => item.frame.timeSeconds);
  const errors = frames.map((item) => item.errorCents);
  const timeOrigin = times[0];
  const relativeTimes = times.map((time) => time - timeOrigin);
  const slope = linearSlope(relativeTimes, errors);
  const averageTime = mean(relativeTimes);
  const averageError = mean(errors);
  const detrended = errors.map((error, index) => error - (averageError + slope * (relativeTimes[index] - averageTime)));
  const depthCents = (quantile(detrended, 0.95) - quantile(detrended, 0.05)) / 2;
  const centerCents = median(errors);
  const minimumDepthCents = options.minimumDepthCents ?? 5;
  const minimumRateHz = options.minimumRateHz ?? 3;
  const maximumRateHz = options.maximumRateHz ?? 9;
  if (
    !Number.isFinite(minimumDepthCents) ||
    minimumDepthCents < 0 ||
    !Number.isFinite(minimumRateHz) ||
    minimumRateHz <= 0 ||
    !Number.isFinite(maximumRateHz) ||
    maximumRateHz <= minimumRateHz
  ) {
    throw new RangeError("Vibrato depth and rate bounds must be finite, positive, and ordered.");
  }
  const minimumCycles = Math.max(1, Math.floor(options.minimumCycles ?? 2));
  const crossings = positiveZeroCrossingTimes(relativeTimes, detrended);
  const periods: number[] = [];
  for (let index = 1; index < crossings.length; index += 1) {
    const period = crossings[index] - crossings[index - 1];
    if (period >= 1 / maximumRateHz && period <= 1 / minimumRateHz) periods.push(period);
  }
  const enoughCycles = periods.length >= minimumCycles;
  const detected = depthCents >= minimumDepthCents && enoughCycles;
  if (!detected) {
    return {
      metrics: {
        detected: false,
        centerCents,
        depthCents,
        cycleCount: periods.length,
      },
    };
  }

  const medianPeriod = median(periods);
  const crossingRateHz = 1 / medianPeriod;
  const coefficientOfVariation = medianPeriod > 0 ? sampleStandardDeviation(periods) / medianPeriod : 1;
  const regularity = clamp(1 - coefficientOfVariation * 2, 0, 1);

  // Refine the crossing estimate against a fitted sinusoid. Crossing times can
  // move slightly after detrending; the fit keeps a clean vibrato from leaking
  // into the adjusted stability metric.
  const searchRadius = Math.min(1, crossingRateHz * 0.12);
  const searchStart = Math.max(minimumRateHz, crossingRateHz - searchRadius);
  const searchEnd = Math.min(maximumRateHz, crossingRateHz + searchRadius);
  const searchSteps = 160;
  const centeredForFit = errors.map((error) => error - averageError);
  let rateHz = crossingRateHz;
  let bestFit = fitSinusoid(relativeTimes, centeredForFit, rateHz);
  for (let step = 0; step <= searchSteps; step += 1) {
    const candidateRate = searchStart + ((searchEnd - searchStart) * step) / searchSteps;
    const candidateFit = fitSinusoid(relativeTimes, centeredForFit, candidateRate);
    if (candidateFit && (!bestFit || candidateFit.residualRms < bestFit.residualRms)) {
      rateHz = candidateRate;
      bestFit = candidateFit;
    }
  }

  return {
    metrics: {
      detected: true,
      centerCents,
      depthCents,
      rateHz,
      regularity,
      cycleCount: periods.length,
    },
    adjustedStabilityCents: bestFit?.residualRms,
  };
};

/**
 * Scores continuous pitch observations without knowing how audio was captured or
 * which detector produced them. The raw contour remains untouched and unsnapped.
 */
export function scoreSustainedNote(
  frames: readonly PitchFrame[],
  target: NoteTarget,
  options: SustainedNoteScoringOptions = {},
): AttemptMetrics {
  if (!Number.isFinite(target.midi) || !Number.isFinite(target.centsOffset)) {
    throw new TypeError("The target must contain finite midi and centsOffset values.");
  }
  const toleranceCents = options.toleranceCents ?? DEFAULT_TOLERANCE_CENTS;
  if (!(toleranceCents > 0) || !Number.isFinite(toleranceCents)) {
    throw new RangeError("toleranceCents must be a positive finite number.");
  }
  const requestedMinimumConfidence = options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;
  if (!Number.isFinite(requestedMinimumConfidence)) {
    throw new RangeError("minimumConfidence must be finite.");
  }
  const minimumConfidence = clamp(requestedMinimumConfidence, 0, 1);
  const attackWindowSeconds = options.attackWindowSeconds ?? DEFAULT_ATTACK_WINDOW_SECONDS;
  if (!Number.isFinite(attackWindowSeconds) || attackWindowSeconds < 0) {
    throw new RangeError("attackWindowSeconds must be a non-negative finite number.");
  }
  const sortedFrames = [...frames]
    .filter((frame) => Number.isFinite(frame.timeSeconds))
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
  const voicedCandidates = sortedFrames.filter((frame) => frame.voiced && finiteMidi(frame) !== null);
  const detectorConfidence =
    voicedCandidates.length > 0
      ? mean(
          voicedCandidates.map((frame) =>
            Number.isFinite(frame.confidence) ? clamp(frame.confidence, 0, 1) : 0,
          ),
        )
      : undefined;
  const targetMidiFloat = target.midi + target.centsOffset / 100;
  const analyzed: AnalyzedFrame[] = [];
  for (const frame of voicedCandidates) {
    if (!Number.isFinite(frame.confidence) || frame.confidence < minimumConfidence) continue;
    const midiFloat = finiteMidi(frame);
    if (midiFloat === null) continue;
    analyzed.push({
      frame,
      midiFloat,
      errorCents: 100 * (midiFloat - targetMidiFloat),
    });
  }

  const metrics: AttemptMetrics = {
    detectorConfidence,
    voicedFrameCount: voicedCandidates.length,
    analyzedFrameCount: analyzed.length,
    totalFrameCount: frames.length,
    volume: scoreVolume(sortedFrames, options.volumeEnvelopePoints ?? 64),
  };
  if (analyzed.length === 0) return metrics;

  const errors = analyzed.map((item) => item.errorCents);
  const times = analyzed.map((item) => item.frame.timeSeconds);
  const medianErrorCents = median(errors);
  const attackEnd = analyzed[0].frame.timeSeconds + attackWindowSeconds;
  const attackErrors = analyzed
    .filter((item) => item.frame.timeSeconds <= attackEnd)
    .map((item) => item.errorCents);
  const inferredHop = inferHopSeconds(sortedFrames);
  const maximumGapSeconds =
    options.maximumVoicedGapSeconds ?? Math.max(0.1, inferredHop > 0 ? inferredHop * 3 : 0.1);
  if (!Number.isFinite(maximumGapSeconds) || maximumGapSeconds <= 0) {
    throw new RangeError("maximumVoicedGapSeconds must be a positive finite number.");
  }
  const continuousRun = longestContinuousRun(analyzed, maximumGapSeconds);
  const runStart = continuousRun[0].frame.timeSeconds;
  const runEnd = continuousRun[continuousRun.length - 1].frame.timeSeconds;
  const promptTimeSeconds = options.promptTimeSeconds ?? sortedFrames[0]?.timeSeconds ?? runStart;
  const centeredErrors = errors.map((error) => error - medianErrorCents);
  const vibratoAnalysis = analyzeVibrato(continuousRun, options.vibrato ?? {});

  metrics.attackErrorCents = median(attackErrors);
  metrics.medianErrorCents = medianErrorCents;
  metrics.meanAbsoluteErrorCents = mean(errors.map(Math.abs));
  metrics.stabilityCents = rootMeanSquare(centeredErrors);
  metrics.vibratoAdjustedStabilityCents =
    vibratoAnalysis?.adjustedStabilityCents ?? metrics.stabilityCents;
  metrics.driftCentsPerSecond = linearSlope(times, errors);
  // MIDI/cents conversion is floating-point; preserve inclusive lane edges.
  const toleranceEpsilon = Math.max(1e-9, toleranceCents * 1e-10);
  metrics.inToleranceRatio =
    errors.filter((error) => Math.abs(error) <= toleranceCents + toleranceEpsilon).length / errors.length;
  metrics.onsetLatencyMs = Math.max(0, (analyzed[0].frame.timeSeconds - promptTimeSeconds) * 1_000);
  metrics.holdDurationMs = Math.max(0, (runEnd - runStart) * 1_000);
  if (vibratoAnalysis) {
    metrics.vibrato = vibratoAnalysis.metrics;
    metrics.vibratoCenterCents = vibratoAnalysis.metrics.centerCents;
    metrics.vibratoDepthCents = vibratoAnalysis.metrics.depthCents;
    metrics.vibratoRateHz = vibratoAnalysis.metrics.rateHz;
    metrics.vibratoRegularity = vibratoAnalysis.metrics.regularity;
  }
  return metrics;
}
