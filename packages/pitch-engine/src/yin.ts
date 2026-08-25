import { pitchValuesFromFrequency } from "./pitch";
import { recentPeriodConfidence } from "./recent-period-confidence";
import {
  selectHarmonicFamily,
  sinusoidalMagnitude,
} from "./harmonic-family";
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
  yinThreshold: 0.18,
  minConfidence: 0.55,
  rmsThreshold: 0,
  currentEdgeSpanSamples: 0,
  a4Frequency: 440,
});
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
  harmonicAmbiguity = 0,
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
    harmonicAmbiguity,
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
  workspace: YinScratchWorkspace,
): { frequencyHz: number; supportsConfidence: boolean } {
  // The broad low-frequency YIN trough is the one susceptible to room hum.
  // Higher-confidence candidates already have enough evidence for only a
  // narrow low-register refinement. We spend a wider pass solely on uncertain
  // candidates, where additive noise can move YIN by more than a semitone.
  const uncertain = confidence < 0.9;
  const sparsePeriod = sampleRate / initialFrequencyHz < 24;
  if (!uncertain && initialFrequencyHz >= 160 && !sparsePeriod) {
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
        workspace,
      );
      // Equal partial energy lets an uncertain harmonic family outvote nearby
      // hum. High-confidence refinement keeps its low-harmonic weighting for
      // maximum clean-signal precision near configured boundaries.
      score += magnitude * magnitude / (uncertain ? 1 : harmonic);
    }
    return score;
  };

  let bestCents = 0;
  let bestScore = -1;
  const scoreCount = Math.floor(2 * searchRadiusCents / coarseStepCents) + 1;
  const scores = workspace.harmonicScores(scoreCount);
  let scoreIndex = 0;
  for (
    let cents = -searchRadiusCents;
    cents <= searchRadiusCents;
    cents += coarseStepCents
  ) {
    const frequencyHz = initialFrequencyHz * 2 ** (cents / 1_200);
    // Permit the fitting neighborhood to cross a configured boundary so a
    // candidate exactly on that boundary still has symmetric evidence. The
    // final refined result is range-checked below before it can be emitted.
    const score = harmonicScore(frequencyHz);
    scores[scoreIndex] = score;
    scoreIndex += 1;
    if (score > bestScore) {
      bestScore = score;
      bestCents = cents;
    }
  }

  const bestIndex = Math.round(
    (bestCents + searchRadiusCents) / coarseStepCents,
  );
  let refinedCents = bestCents;
  if (bestIndex > 0 && bestIndex < scoreCount - 1) {
    const previous = scores[bestIndex - 1]!;
    const current = scores[bestIndex]!;
    const next = scores[bestIndex + 1]!;
    const denominator = previous - 2 * current + next;
    if (Number.isFinite(denominator) && Math.abs(denominator) > 1e-18) {
      const offset = 0.5 * (previous - next) / denominator;
      refinedCents += Math.max(-1, Math.min(1, offset)) * coarseStepCents;
    }
  }
  const frequencyHz = initialFrequencyHz * 2 ** (refinedCents / 1_200);
  let totalHarmonicEnergy = 0;
  let upperHarmonicEnergy = 0;
  for (let harmonic = 1; harmonic <= MAXIMUM_HARMONIC; harmonic += 1) {
    const magnitude = sinusoidalMagnitude(
      samples,
      sampleRate,
      frequencyHz * harmonic,
      workspace,
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
    const bestConfidence = clampUnit(1 - bestYinValue);
    const rawCandidate = rawCandidateAt(
      samples,
      yin,
      bestTau,
      maximumTau,
      resolved.sampleRate,
      resolved.currentEdgeSpanSamples,
    );
    // The YIN threshold guides selection toward the first strong local
    // minimum. It is not a second, hidden confidence policy: when no minimum
    // crosses it, credible global-best periodic evidence must still reach the
    // public minConfidence decision below.
    if (bestConfidence >= resolved.minConfidence) {
      selectedTau = bestTau;
    } else {
      return frameWithoutPitch(
        resolved,
        measured.rms,
        bestConfidence,
        "no-periodic-candidate",
        bestYinValue,
        rawCandidate,
      );
    }
  }

  const rawCandidate = rawCandidateAt(
    samples,
    yin,
    selectedTau,
    maximumTau,
    resolved.sampleRate,
    resolved.currentEdgeSpanSamples,
  );
  const family = selectHarmonicFamily(
    samples,
    yin,
    selectedTau,
    minimumTau,
    maximumTau,
    resolved.sampleRate,
    resolved.minFrequency,
    resolved.maxFrequency,
    resolved.currentEdgeSpanSamples,
    workspace,
  );
  selectedTau = family.selectedTau;
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
      family.ambiguity,
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
    currentConfidence,
    workspace,
  );
  const frequencyHz = refinement.frequencyHz;
  const confidence = refinement.supportsConfidence
    ? Math.max(currentConfidence, 0.6)
    : currentConfidence;
  const refinedPeriodSamples = resolved.sampleRate / frequencyHz;
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
      family.ambiguity,
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
    rawCandidate,
    harmonicAmbiguity: family.ambiguity,
  };
}
