import { pitchValuesFromFrequency } from "./pitch";
import type {
  PitchDetectionReason,
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

let cachedHannWindow = new Float64Array(0);

function hannWindow(length: number): Float64Array {
  if (cachedHannWindow.length === length) return cachedHannWindow;
  const window = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos(
      2 * Math.PI * index / (length - 1),
    );
  }
  cachedHannWindow = window;
  return window;
}

/** Hann-windowed single-frequency magnitude used only to disambiguate octaves. */
function sinusoidalMagnitude(
  samples: Float32Array,
  sampleRate: number,
  frequencyHz: number,
): number {
  if (samples.length < 2 || frequencyHz <= 0 || frequencyHz >= sampleRate / 2) {
    return 0;
  }
  let real = 0;
  let imaginary = 0;
  let weightSum = 0;
  const window = hannWindow(samples.length);
  const angularStep = 2 * Math.PI * frequencyHz / sampleRate;
  const oscillatorCosine = Math.cos(angularStep);
  const oscillatorSine = Math.sin(angularStep);
  let phaseCosine = 1;
  let phaseSine = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const weight = window[index]!;
    const weighted = samples[index] * weight;
    real += weighted * phaseCosine;
    imaginary -= weighted * phaseSine;
    weightSum += weight;
    const nextCosine = phaseCosine * oscillatorCosine
      - phaseSine * oscillatorSine;
    phaseSine = phaseSine * oscillatorCosine
      + phaseCosine * oscillatorSine;
    phaseCosine = nextCosine;
  }
  return weightSum === 0 ? 0 : 2 * Math.hypot(real, imaginary) / weightSum;
}

/**
 * Refine YIN's time-domain estimate against the signal's harmonic spectrum.
 *
 * Additive room noise can move a broad low-frequency YIN minimum by several
 * tenths of a semitone even when YIN still chose the correct note. Evaluating a
 * small cents-wide neighborhood at the fundamental and its harmonics supplies
 * independent evidence without snapping the result to a tempered note.
 */
function refineFrequencyFromHarmonics(
  samples: Float32Array,
  sampleRate: number,
  initialFrequencyHz: number,
  confidence: number,
  maximumFrequency: number,
): { frequencyHz: number; supportsConfidence: boolean } {
  // The broad low-frequency YIN trough is the one susceptible to room hum.
  // Higher-confidence candidates already have enough evidence for only a
  // narrow low-register refinement. We spend a wider pass solely on uncertain
  // candidates, where additive noise can move YIN by more than a semitone.
  const uncertain = confidence < 0.9;
  const sparseUpperBoundary = initialFrequencyHz >= maximumFrequency * 0.9
    && sampleRate / initialFrequencyHz < 24;
  if (!uncertain && initialFrequencyHz >= 160 && !sparseUpperBoundary) {
    return { frequencyHz: initialFrequencyHz, supportsConfidence: false };
  }

  const searchRadiusCents = uncertain ? 160 : 36;
  const coarseStepCents = uncertain ? 5 : 4;
  const MAXIMUM_HARMONIC = 4;

  const harmonicScore = (frequencyHz: number): number => {
    let score = 0;
    for (let harmonic = 1; harmonic <= MAXIMUM_HARMONIC; harmonic += 1) {
      const harmonicFrequency = frequencyHz * harmonic;
      if (harmonicFrequency >= sampleRate / 2) break;
      const magnitude = sinusoidalMagnitude(
        samples,
        sampleRate,
        harmonicFrequency,
      );
      // Equal partial energy lets an uncertain harmonic family outvote nearby
      // hum. High-confidence refinement keeps its low-harmonic weighting for
      // maximum clean-signal precision near configured boundaries.
      score += magnitude * magnitude / (uncertain ? 1 : harmonic);
    }
    return score;
  };

  const centers = [initialFrequencyHz];
  if (uncertain && initialFrequencyHz * 2 <= maximumFrequency) {
    // This lets independent harmonic evidence undo a noise-induced
    // subharmonic choice without ever snapping toward a tempered note.
    centers.push(initialFrequencyHz * 2);
  }

  const bestByCenter = centers.map((centerFrequencyHz) => {
    let bestCents = 0;
    let bestScore = -1;
    const scores: number[] = [];
    for (
      let cents = -searchRadiusCents;
      cents <= searchRadiusCents;
      cents += coarseStepCents
    ) {
      const frequencyHz = centerFrequencyHz * 2 ** (cents / 1_200);
      // Permit the fitting neighborhood to cross a configured boundary so a
      // candidate exactly on that boundary still has symmetric evidence. The
      // final refined result is range-checked below before it can be emitted.
      const score = harmonicScore(frequencyHz);
      scores.push(score);
      if (score > bestScore) {
        bestScore = score;
        bestCents = cents;
      }
    }

    const bestIndex = Math.round(
      (bestCents + searchRadiusCents) / coarseStepCents,
    );
    let refinedCents = bestCents;
    if (bestIndex > 0 && bestIndex < scores.length - 1) {
      const previous = scores[bestIndex - 1]!;
      const current = scores[bestIndex]!;
      const next = scores[bestIndex + 1]!;
      const denominator = previous - 2 * current + next;
      if (Number.isFinite(denominator) && Math.abs(denominator) > 1e-18) {
        const offset = 0.5 * (previous - next) / denominator;
        refinedCents += Math.max(-1, Math.min(1, offset)) * coarseStepCents;
      }
    }
    return {
      frequencyHz: centerFrequencyHz * 2 ** (refinedCents / 1_200),
      score: bestScore,
    };
  });

  const local = bestByCenter[0]!;
  const doubled = bestByCenter[1];
  const frequencyHz = doubled && doubled.score > local.score * 1.03
    ? doubled.frequencyHz
    : local.frequencyHz;
  let totalHarmonicEnergy = 0;
  let upperHarmonicEnergy = 0;
  for (let harmonic = 1; harmonic <= MAXIMUM_HARMONIC; harmonic += 1) {
    const magnitude = sinusoidalMagnitude(
      samples,
      sampleRate,
      frequencyHz * harmonic,
    );
    const energy = magnitude * magnitude;
    totalHarmonicEnergy += energy;
    if (harmonic >= 3) upperHarmonicEnergy += energy;
  }
  // Independent third/fourth-partial support distinguishes a harmonic voice
  // family from a two-line 50/60 Hz electrical hum. It may raise a marginal
  // YIN periodicity score, but never creates a candidate YIN rejected.
  const supportsConfidence = uncertain
    && totalHarmonicEnergy > 1e-18
    && upperHarmonicEnergy / totalHarmonicEnergy >= 0.015;
  return { frequencyHz, supportsConfidence };
}

/**
 * A weak vocal fundamental with a dominant second harmonic can make the first
 * acceptable YIN minimum one octave high. Prefer the doubled period only when
 * the PCM contains measurable energy at that lower fundamental as independent
 * evidence; a pure high sine therefore stays high.
 */
function correctDominantSecondHarmonic(
  samples: Float32Array,
  yin: Float64Array,
  selectedTau: number,
  maximumTau: number,
  sampleRate: number,
  minimumFrequency: number,
): number {
  const doubled = selectedTau * 2;
  if (doubled > maximumTau || sampleRate / doubled < minimumFrequency) {
    return selectedTau;
  }

  let lowerTau = doubled;
  for (
    let tau = Math.max(selectedTau + 1, doubled - 2);
    tau <= Math.min(maximumTau, doubled + 2);
    tau += 1
  ) {
    if (yin[tau] < yin[lowerTau]) lowerTau = tau;
  }
  // The longer period must itself be strongly periodic. This prevents random
  // low-frequency room energy from overriding a valid high candidate.
  if (yin[lowerTau] > Math.min(0.25, yin[selectedTau] + 0.08)) {
    return selectedTau;
  }

  const candidateFrequency = sampleRate / selectedTau;
  const lowerFrequency = sampleRate / lowerTau;
  const candidateMagnitude = sinusoidalMagnitude(
    samples,
    sampleRate,
    candidateFrequency,
  );
  const lowerMagnitude = sinusoidalMagnitude(
    samples,
    sampleRate,
    lowerFrequency,
  );
  if (candidateMagnitude <= 1e-12) {
    return selectedTau;
  }

  const fundamentalRatio = lowerMagnitude / candidateMagnitude;
  if (lowerFrequency < 80) {
    // A 50/60 Hz electrical line can sit below a real high note and look like
    // octave evidence in an 85 ms window. A low vocal fundamental with a
    // dominant second partial also carries independent odd partials, whereas
    // a line plus the selected high candidate does not. Require both the low
    // fundamental and energy at an odd member of that same harmonic family
    // before correcting a sub-80 Hz octave.
    const thirdMagnitude = sinusoidalMagnitude(
      samples,
      sampleRate,
      lowerFrequency * 3,
    );
    const fifthMagnitude = sinusoidalMagnitude(
      samples,
      sampleRate,
      lowerFrequency * 5,
    );
    const oddHarmonicRatio = Math.hypot(
      thirdMagnitude,
      fifthMagnitude,
    ) / candidateMagnitude;
    if (fundamentalRatio < 0.06 || oddHarmonicRatio < 0.08) {
      return selectedTau;
    }
  } else if (fundamentalRatio < 0.075) {
    return selectedTau;
  }
  return lowerTau;
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

  selectedTau = correctDominantSecondHarmonic(
    samples,
    yin,
    selectedTau,
    maximumTau,
    resolved.sampleRate,
    resolved.minFrequency,
  );
  const yinValue = yin[selectedTau];
  const yinConfidence = clampUnit(1 - yinValue);
  if (yinConfidence < resolved.minConfidence) {
    return frameWithoutPitch(
      resolved,
      measured.rms,
      yinConfidence,
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
  const initialFrequencyHz = resolved.sampleRate / periodSamples;
  const refinement = refineFrequencyFromHarmonics(
    samples,
    resolved.sampleRate,
    initialFrequencyHz,
    yinConfidence,
    resolved.maxFrequency,
  );
  const frequencyHz = refinement.frequencyHz;
  const confidence = refinement.supportsConfidence
    ? Math.max(yinConfidence, 0.6)
    : yinConfidence;
  const refinedPeriodSamples = resolved.sampleRate / frequencyHz;
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
    periodSamples: refinedPeriodSamples,
    yinValue,
    reason: "detected",
  };
}
