import { pitchValuesFromFrequency } from "./pitch";
import { recentPeriodConfidence } from "./recent-period-confidence";
import { YinScratchWorkspace } from "./yin-workspace";
import {
  YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS,
  type PitchDetectionReason,
  type YinOptions,
  type YinPitchFrame,
  type YinRawCandidate,
} from "./types";
/** Canonical full-depth, zero-floor policy for direct and live callers. */
export const YIN_DETECTOR_DEFAULTS = Object.freeze({
  minFrequency: 45,
  maxFrequency: 1_200,
  yinThreshold: 0.08,
  minConfidence: 0.55,
  rmsThreshold: 0,
  currentEdgeSpanSamples: 0,
  a4Frequency: 440,
});

/**
 * When noise keeps every trough just above the absolute threshold, prefer the
 * earliest trough whose residual aperiodicity is still comparable with the
 * global best. This stays inside YIN candidate selection: it neither inspects
 * harmonic spectra nor transposes the selected period afterward.
 */
const COMPARABLE_MINIMUM_APERIODICITY_RATIO = 1.25;
const MINIMUM_DENSE_PERIOD_SAMPLES = 24;
const SPARSE_PERIOD_YIN_THRESHOLD = 0.1;
interface ResolvedOptions {
  sampleRate: number;
  minFrequency: number;
  maxFrequency: number;
  analysisWindowSize?: number;
  yinThreshold: number;
  minConfidence: number;
  rmsThreshold: number;
  currentEdgeSpanSamples: number;
  a4Frequency: number;
  timeSeconds: number;
}
function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}
function requireUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}
function resolveOptions(options: YinOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    sampleRate: options.sampleRate,
    minFrequency: options.minFrequency ?? YIN_DETECTOR_DEFAULTS.minFrequency,
    maxFrequency: options.maxFrequency ?? YIN_DETECTOR_DEFAULTS.maxFrequency,
    analysisWindowSize: options.analysisWindowSize,
    yinThreshold: options.yinThreshold ?? YIN_DETECTOR_DEFAULTS.yinThreshold,
    minConfidence: options.minConfidence ?? YIN_DETECTOR_DEFAULTS.minConfidence,
    rmsThreshold: options.rmsThreshold ?? YIN_DETECTOR_DEFAULTS.rmsThreshold,
    currentEdgeSpanSamples: options.currentEdgeSpanSamples ?? YIN_DETECTOR_DEFAULTS.currentEdgeSpanSamples,
    a4Frequency: options.a4Frequency ?? YIN_DETECTOR_DEFAULTS.a4Frequency,
    timeSeconds: options.timeSeconds ?? 0,
  };
  requireFinitePositive(resolved.sampleRate, "sampleRate");
  requireFinitePositive(resolved.minFrequency, "minFrequency");
  requireFinitePositive(resolved.maxFrequency, "maxFrequency");
  requireFinitePositive(resolved.a4Frequency, "a4Frequency");
  requireUnitInterval(resolved.yinThreshold, "yinThreshold");
  requireUnitInterval(resolved.minConfidence, "minConfidence");
  if (!Number.isFinite(resolved.rmsThreshold) || resolved.rmsThreshold < 0) {
    throw new RangeError("rmsThreshold must be a finite non-negative number");
  }
  if (!Number.isSafeInteger(resolved.currentEdgeSpanSamples) || resolved.currentEdgeSpanSamples < 0) {
    throw new RangeError("currentEdgeSpanSamples must be a non-negative safe integer");
  }
  if (!Number.isFinite(resolved.timeSeconds) || resolved.timeSeconds < 0) {
    throw new RangeError("timeSeconds must be a finite non-negative number");
  }
  if (resolved.minFrequency >= resolved.maxFrequency) {
    throw new RangeError("minFrequency must be lower than maxFrequency");
  }
  if (resolved.maxFrequency >= resolved.sampleRate / 2) {
    throw new RangeError("maxFrequency must be below the Nyquist frequency");
  }
  if (
    resolved.analysisWindowSize !== undefined &&
    (!Number.isInteger(resolved.analysisWindowSize) ||
      resolved.analysisWindowSize <= 0)
  ) {
    throw new RangeError("analysisWindowSize must be a positive integer");
  }
  return resolved;
}

function frameWithoutPitch(
  options: ResolvedOptions,
  rms: number,
  confidence: number,
  reason: Exclude<PitchDetectionReason, "detected">,
  yinValue: number | null = null,
  rawCandidate: Readonly<YinRawCandidate> | null = null,
): YinPitchFrame {
  return {
    timeSeconds: options.timeSeconds,
    frequencyHz: null,
    midiFloat: null,
    nearestMidi: null,
    centsFromNearest: null,
    rms,
    confidence,
    voiced: false,
    detector: "yin",
    periodSamples: null,
    yinValue,
    reason,
    rawCandidate,
  };
}

function rootMeanSquare(samples: Float32Array): {
  rms: number;
  valid: boolean;
} {
  if (samples.length === 0) {
    return { rms: 0, valid: true };
  }

  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample)) {
      return { rms: 0, valid: false };
    }
    sumSquares += sample * sample;
  }

  return { rms: Math.sqrt(sumSquares / samples.length), valid: true };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Refines an integer lag by fitting a parabola through its YIN neighbors. */
function parabolicPeriod(
  yin: Float64Array,
  tau: number,
  lowerBound: number,
  upperBound: number,
): number {
  if (tau <= lowerBound || tau >= upperBound) {
    return tau;
  }

  const previous = yin[tau - 1];
  const current = yin[tau];
  const next = yin[tau + 1];
  const denominator = previous - 2 * current + next;

  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-15) {
    return tau;
  }

  const offset = 0.5 * (previous - next) / denominator;
  return tau + Math.min(1, Math.max(-1, offset));
}

function rawCandidateAt(
  samples: Float32Array,
  yin: Float64Array,
  tau: number,
  maximumTau: number,
  sampleRate: number,
  currentEdgeSpanSamples: number,
): Readonly<YinRawCandidate> {
  const periodSamples = parabolicPeriod(yin, tau, 1, maximumTau + 1);
  const yinValue = yin[tau];
  return Object.freeze({
    frequencyHz: sampleRate / periodSamples,
    periodSamples,
    yinValue,
    confidence: Math.min(
      clampUnit(1 - yinValue),
      recentPeriodConfidence(samples, tau, currentEdgeSpanSamples),
    ),
  });
}

/**
 * @internal
 *
 * Estimate one monophonic fundamental with the YIN difference function.
 *
 * The raw signal is never snapped before scoring: frequencyHz and midiFloat are
 * continuous. Invalid or non-periodic buffers return an explicit unvoiced frame.
 */
export function detectPitchWithWorkspace(
  samples: Float32Array,
  options: YinOptions,
  workspace: YinScratchWorkspace,
): YinPitchFrame {
  const resolved = resolveOptions(options);
  const measured = rootMeanSquare(samples);

  if (!measured.valid) {
    return frameWithoutPitch(resolved, 0, 0, "invalid-samples");
  }
  // Exact digital silence is cheaply observable without imposing a nonzero
  // amplitude admission floor. Any finite nonzero periodic evidence reaches
  // the periodicity detector, however quiet it is.
  if (measured.rms === 0 || measured.rms < resolved.rmsThreshold) {
    return frameWithoutPitch(
      resolved,
      measured.rms,
      0,
      "below-rms-threshold",
    );
  }

  const minimumTau = Math.max(
    2,
    Math.floor(resolved.sampleRate / resolved.maxFrequency),
  );
  const requestedMaximumTau = Math.ceil(
    resolved.sampleRate / resolved.minFrequency,
  );
  const interpolationMargin = 1;
  const availableWindow = samples.length - requestedMaximumTau -
    interpolationMargin;
  const analysisWindow = resolved.analysisWindowSize ??
    Math.min(Math.floor(samples.length / 2), availableWindow);

  if (
    analysisWindow < 2 ||
    availableWindow < analysisWindow ||
    requestedMaximumTau <= minimumTau
  ) {
    return frameWithoutPitch(
      resolved,
      measured.rms,
      0,
      "insufficient-samples",
    );
  }

  const maximumTau = requestedMaximumTau;
  workspace.prepareLagBuffers(maximumTau + 2);
  const difference = workspace.differenceBuffer();
  const yin = workspace.normalizedDifferenceBuffer();
  // Select candidates from a fixed current region, not an older window prefix
  // that can disagree with the current-edge evidence at an abrupt transition.
  const analysisStart = resolved.currentEdgeSpanSamples > 0 ? samples.length - analysisWindow - maximumTau - 1 : 0;
  for (let tau = 1; tau <= maximumTau + 1; tau += 1) {
    let sum = 0;
    for (let index = 0; index < analysisWindow; index += 1) {
      const delta = samples[analysisStart + index] - samples[analysisStart + index + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
  }
  yin[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maximumTau + 1; tau += 1) {
    runningSum += difference[tau];
    yin[tau] = runningSum === 0 ? 1 : (difference[tau] * tau) / runningSum;
  }
  let bestTau = minimumTau;
  for (let tau = minimumTau; tau <= maximumTau; tau += 1) {
    if (yin[tau] < yin[bestTau]) {
      bestTau = tau;
    }
  }

  const bestYinValue = yin[bestTau];
  const bestConfidence = clampUnit(1 - bestYinValue);
  // With fewer than 24 samples at the top of the search range, an integer-lag
  // YIN trough is necessarily coarser. Admit the same 0.10 ceiling used by the
  // canonical threshold matrix, then retain continuous parabolic estimation.
  const resolutionAwareThreshold = minimumTau < MINIMUM_DENSE_PERIOD_SAMPLES
    ? Math.max(resolved.yinThreshold, SPARSE_PERIOD_YIN_THRESHOLD)
    : resolved.yinThreshold;
  const candidateCeiling = Math.min(
    1 - resolved.minConfidence,
    Math.max(
      resolutionAwareThreshold,
      bestYinValue * COMPARABLE_MINIMUM_APERIODICITY_RATIO,
    ),
  );
  const basinExitCeiling = Math.min(1, candidateCeiling * 2);
  let selectedTau = -1;
  for (let tau = minimumTau; tau <= maximumTau; tau += 1) {
    if (yin[tau] > candidateCeiling) continue;

    selectedTau = tau;
    while (
      tau + 1 <= maximumTau
      && yin[tau + 1] <= basinExitCeiling
    ) {
      tau += 1;
      if (yin[tau] < yin[selectedTau]) selectedTau = tau;
    }
    break;
  }

  if (selectedTau < 0) {
    const rawCandidate = rawCandidateAt(
      samples,
      yin,
      bestTau,
      maximumTau,
      resolved.sampleRate,
      resolved.currentEdgeSpanSamples,
    );
    return frameWithoutPitch(
      resolved,
      measured.rms,
      bestConfidence,
      "no-periodic-candidate",
      bestYinValue,
      rawCandidate,
    );
  }

  const rawCandidate = rawCandidateAt(
    samples,
    yin,
    selectedTau,
    maximumTau,
    resolved.sampleRate,
    resolved.currentEdgeSpanSamples,
  );
  const yinValue = yin[selectedTau];
  const yinConfidence = clampUnit(1 - yinValue);
  const currentConfidence = Math.min(
    yinConfidence,
    recentPeriodConfidence(samples, selectedTau, resolved.currentEdgeSpanSamples),
  );
  if (currentConfidence < resolved.minConfidence) {
    return frameWithoutPitch(
      resolved,
      measured.rms,
      currentConfidence,
      "below-confidence-threshold",
      yinValue,
      rawCandidate,
    );
  }

  const periodSamples = parabolicPeriod(
    yin,
    selectedTau,
    1,
    maximumTau + 1,
  );
  const frequencyHz = resolved.sampleRate / periodSamples;
  const confidence = currentConfidence;
  // Parabolic interpolation can land a fraction of a cent beyond an inclusive
  // configured boundary. Keep that measurement continuous while rejecting
  // candidates that are musically outside the requested range.
  const rangeToleranceRatio = 2 ** (
    YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS / 1_200
  );

  if (
    !Number.isFinite(frequencyHz) ||
    frequencyHz < resolved.minFrequency / rangeToleranceRatio ||
    frequencyHz > resolved.maxFrequency * rangeToleranceRatio
  ) {
    return frameWithoutPitch(
      resolved,
      measured.rms,
      confidence,
      "frequency-out-of-range",
      yinValue,
      rawCandidate,
    );
  }

  const pitch = pitchValuesFromFrequency(frequencyHz, resolved.a4Frequency);
  return {
    timeSeconds: resolved.timeSeconds,
    ...pitch,
    rms: measured.rms,
    confidence,
    voiced: true,
    detector: "yin",
    periodSamples,
    yinValue,
    reason: "detected",
    rawCandidate,
  };
}
