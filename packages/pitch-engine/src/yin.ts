import { pitchValuesFromFrequency } from "./pitch";
import type {
  PitchDetectionReason,
  YinDetectorOptions,
  YinOptions,
  YinPitchFrame,
} from "./types";

const DEFAULT_MIN_FREQUENCY = 65;
const DEFAULT_MAX_FREQUENCY = 1_200;
const DEFAULT_YIN_THRESHOLD = 0.15;
const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_RMS_THRESHOLD = 0.005;
const DEFAULT_A4_FREQUENCY = 440;

interface ResolvedOptions {
  sampleRate: number;
  minFrequency: number;
  maxFrequency: number;
  analysisWindowSize?: number;
  yinThreshold: number;
  minConfidence: number;
  rmsThreshold: number;
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
    minFrequency: options.minFrequency ?? DEFAULT_MIN_FREQUENCY,
    maxFrequency: options.maxFrequency ?? DEFAULT_MAX_FREQUENCY,
    analysisWindowSize: options.analysisWindowSize,
    yinThreshold: options.yinThreshold ?? DEFAULT_YIN_THRESHOLD,
    minConfidence: options.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    rmsThreshold: options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD,
    a4Frequency: options.a4Frequency ?? DEFAULT_A4_FREQUENCY,
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

/**
 * Estimate one monophonic fundamental with the YIN difference function.
 *
 * The raw signal is never snapped before scoring: frequencyHz and midiFloat are
 * continuous. Invalid or non-periodic buffers return an explicit unvoiced frame.
 */
export function detectPitch(
  samples: Float32Array,
  options: YinOptions,
): YinPitchFrame {
  const resolved = resolveOptions(options);
  const measured = rootMeanSquare(samples);

  if (!measured.valid) {
    return frameWithoutPitch(resolved, 0, 0, "invalid-samples");
  }
  if (measured.rms < resolved.rmsThreshold) {
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
  const difference = new Float64Array(maximumTau + 2);
  const yin = new Float64Array(maximumTau + 2);

  for (let tau = 1; tau <= maximumTau + 1; tau += 1) {
    let sum = 0;
    for (let index = 0; index < analysisWindow; index += 1) {
      const delta = samples[index] - samples[index + tau];
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

  let selectedTau = -1;
  let bestTau = minimumTau;
  for (let tau = minimumTau; tau <= maximumTau; tau += 1) {
    if (yin[tau] < yin[bestTau]) {
      bestTau = tau;
    }

    if (yin[tau] < resolved.yinThreshold) {
      selectedTau = tau;
      while (
        selectedTau + 1 <= maximumTau &&
        yin[selectedTau + 1] < yin[selectedTau]
      ) {
        selectedTau += 1;
      }
      break;
    }
  }

  if (selectedTau < 0) {
    const bestYinValue = yin[bestTau];
    return frameWithoutPitch(
      resolved,
      measured.rms,
      clampUnit(1 - bestYinValue),
      "no-periodic-candidate",
      bestYinValue,
    );
  }

  const yinValue = yin[selectedTau];
  const confidence = clampUnit(1 - yinValue);
  if (confidence < resolved.minConfidence) {
    return frameWithoutPitch(
      resolved,
      measured.rms,
      confidence,
      "below-confidence-threshold",
      yinValue,
    );
  }

  const periodSamples = parabolicPeriod(
    yin,
    selectedTau,
    1,
    maximumTau + 1,
  );
  const frequencyHz = resolved.sampleRate / periodSamples;
  // Parabolic interpolation can land a fraction of a cent beyond an inclusive
  // configured boundary. Keep that measurement continuous while rejecting
  // candidates that are musically outside the requested range.
  const rangeToleranceRatio = 2 ** (1 / 1_200);

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
  };
}

/** Fixed-configuration convenience wrapper for repeated browser audio chunks. */
export class YinDetector {
  readonly options: Readonly<YinDetectorOptions>;

  constructor(options: YinDetectorOptions) {
    // Resolve once here so configuration errors fail before microphone capture.
    resolveOptions(options);
    this.options = Object.freeze({ ...options });
  }

  detect(samples: Float32Array, timeSeconds = 0): YinPitchFrame {
    return detectPitch(samples, { ...this.options, timeSeconds });
  }
}
