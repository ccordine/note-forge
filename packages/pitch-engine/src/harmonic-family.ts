import { recentPeriodConfidence } from "./recent-period-confidence";
import { YinScratchWorkspace } from "./yin-workspace";

const MAXIMUM_HARMONIC_FAMILY_MULTIPLE = 5;
const MAXIMUM_HARMONIC_FAMILY_PARTIAL = 10;
const MINIMUM_FAMILY_PARTIALS = 3;
const HARMONIC_SUPPORT_RATIO = 0.035;
const MINIMUM_NON_DOMINANT_RATIO = 0.06;
const MINIMUM_PRIMITIVE_OFF_GRID_RATIO = 0.075;
// YIN can prefer a doubled period when broadband noise makes adjacent period
// minima nearly equal. In that case a real octave-down source still has
// measured odd-grid partial energy; a doubled-period artifact has only the
// broadband floor there.
const MAXIMUM_RAISED_OCTAVE_OFF_GRID_RATIO = 0.11;
// A longer period necessarily has more opportunities to explain incidental
// broadband energy. Do not replace YIN's direct candidate for a fractional
// energy tie; a real missing-fundamental family must add material evidence.
const MINIMUM_FAMILY_ENERGY_ADVANTAGE = 1.01;
const MAXIMUM_FAMILY_YIN_VALUE = 0.25;
const MAXIMUM_FAMILY_YIN_REGRESSION = 0.08;
const UNAMBIGUOUS_FAMILY_MARGIN = 0.08;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Hann-windowed single-frequency magnitude over an explicit PCM region. */
export function sinusoidalMagnitude(
  samples: Float32Array,
  sampleRate: number,
  frequencyHz: number,
  workspace: YinScratchWorkspace,
  startSample = 0,
  endSample = samples.length,
): number {
  const sampleCount = endSample - startSample;
  if (
    sampleCount < 2
    || startSample < 0
    || endSample > samples.length
    || frequencyHz <= 0
    || frequencyHz >= sampleRate / 2
  ) {
    return 0;
  }
  let real = 0;
  let imaginary = 0;
  let weightSum = 0;
  const window = workspace.hannWindow(sampleCount);
  const angularStep = 2 * Math.PI * frequencyHz / sampleRate;
  const oscillatorCosine = Math.cos(angularStep);
  const oscillatorSine = Math.sin(angularStep);
  let phaseCosine = 1;
  let phaseSine = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const weight = window[index]!;
    const weighted = samples[startSample + index]! * weight;
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

interface HarmonicSupport {
  readonly supportedIndices: readonly number[];
  readonly greatestCommonDivisor: number;
  readonly nonDominantRatio: number;
  /** Energy on odd indices of this candidate's harmonic grid. */
  readonly octaveOffGridRatio: number;
  /** Energy that cannot be explained by the higher raw candidate's grid. */
  readonly primitiveOffGridRatio: number;
  readonly totalEnergy: number;
}

function greatestCommonDivisor(left: number, right: number): number {
  let first = Math.abs(left);
  let second = Math.abs(right);
  while (second !== 0) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

function supportedGridPartialCount(
  support: Readonly<HarmonicSupport>,
  multiple: number,
): number {
  let count = 0;
  for (const harmonic of support.supportedIndices) {
    if (harmonic % multiple === 0) count += 1;
  }
  return count;
}

function raisedFamilyMultiple(support: Readonly<HarmonicSupport>): number {
  const divisor = support.greatestCommonDivisor;
  if (
    support.supportedIndices.length >= MINIMUM_FAMILY_PARTIALS
    && divisor >= 2
    && divisor <= MAXIMUM_HARMONIC_FAMILY_MULTIPLE
  ) {
    return divisor;
  }
  const octaveAlias = divisor === 1
    && supportedGridPartialCount(support, 2) >= MINIMUM_FAMILY_PARTIALS
    && support.octaveOffGridRatio <= MAXIMUM_RAISED_OCTAVE_OFF_GRID_RATIO;
  return octaveAlias ? 2 : 1;
}

function emptySupport(): HarmonicSupport {
  return {
    supportedIndices: [],
    greatestCommonDivisor: 0,
    nonDominantRatio: 0,
    octaveOffGridRatio: 0,
    primitiveOffGridRatio: 0,
    totalEnergy: 0,
  };
}

function harmonicSupport(
  samples: Float32Array,
  sampleRate: number,
  frequencyHz: number,
  currentEdgeSpanSamples: number,
  workspace: YinScratchWorkspace,
  rawFamilyMultiple = 1,
): HarmonicSupport {
  const partialCount = Math.min(
    MAXIMUM_HARMONIC_FAMILY_PARTIAL,
    Math.floor((sampleRate / 2 - Number.EPSILON) / frequencyHz),
  );
  if (partialCount < 1) return emptySupport();

  const magnitudes = workspace.harmonicScores(partialCount);
  const evidenceSamples = currentEdgeSpanSamples > 0
    ? Math.min(
      samples.length,
      Math.max(
        currentEdgeSpanSamples * 2,
        Math.ceil(2 * sampleRate / frequencyHz),
      ),
    )
    : samples.length;
  const evidenceStart = samples.length - evidenceSamples;
  let maximumMagnitude = 0;
  let dominantIndex = 0;
  for (let harmonic = 1; harmonic <= partialCount; harmonic += 1) {
    const magnitude = sinusoidalMagnitude(
      samples,
      sampleRate,
      frequencyHz * harmonic,
      workspace,
      evidenceStart,
      samples.length,
    );
    magnitudes[harmonic - 1] = magnitude;
    if (magnitude > maximumMagnitude) {
      maximumMagnitude = magnitude;
      dominantIndex = harmonic - 1;
    }
  }
  if (maximumMagnitude <= 1e-12) return emptySupport();

  const supportedIndices: number[] = [];
  let supportedDivisor = 0;
  let nonDominantEnergy = 0;
  let octaveOffGridEnergy = 0;
  let primitiveOffGridEnergy = 0;
  let totalEnergy = 0;
  for (let index = 0; index < partialCount; index += 1) {
    const magnitude = magnitudes[index]!;
    totalEnergy += magnitude * magnitude;
    if (index !== dominantIndex) nonDominantEnergy += magnitude * magnitude;
    if ((index + 1) % 2 !== 0) {
      octaveOffGridEnergy += magnitude * magnitude;
    }
    if ((index + 1) % rawFamilyMultiple !== 0) {
      primitiveOffGridEnergy += magnitude * magnitude;
    }
    if (magnitude < maximumMagnitude * HARMONIC_SUPPORT_RATIO) continue;
    const harmonic = index + 1;
    supportedIndices.push(harmonic);
    supportedDivisor = supportedDivisor === 0
      ? harmonic
      : greatestCommonDivisor(supportedDivisor, harmonic);
  }
  return {
    supportedIndices,
    greatestCommonDivisor: supportedDivisor,
    nonDominantRatio: Math.sqrt(nonDominantEnergy) / maximumMagnitude,
    octaveOffGridRatio: Math.sqrt(octaveOffGridEnergy) / maximumMagnitude,
    primitiveOffGridRatio: Math.sqrt(primitiveOffGridEnergy) / maximumMagnitude,
    totalEnergy,
  };
}

function localYinMinimum(
  yin: Float64Array,
  expectedTau: number,
  radius: number,
  minimumTau: number,
  maximumTau: number,
): number {
  const center = Math.round(expectedTau);
  const start = Math.max(minimumTau, center - radius);
  const end = Math.min(maximumTau, center + radius);
  let bestTau = start;
  for (let tau = start + 1; tau <= end; tau += 1) {
    if (yin[tau] < yin[bestTau]) bestTau = tau;
  }
  return bestTau;
}

export interface HarmonicFamilySelection {
  readonly selectedTau: number;
  readonly ambiguity: number;
}

/** Resolve YIN's first minimum against one bounded integer harmonic lattice. */
export function selectHarmonicFamily(
  samples: Float32Array,
  yin: Float64Array,
  rawTau: number,
  minimumTau: number,
  maximumTau: number,
  sampleRate: number,
  minimumFrequency: number,
  maximumFrequency: number,
  currentEdgeSpanSamples: number,
  workspace: YinScratchWorkspace,
): HarmonicFamilySelection {
  const rawSupport = harmonicSupport(
    samples,
    sampleRate,
    sampleRate / rawTau,
    currentEdgeSpanSamples,
    workspace,
  );
  const rawConfidence = Math.min(
    clampUnit(1 - yin[rawTau]),
    recentPeriodConfidence(samples, rawTau, currentEdgeSpanSamples),
  );
  let selectedTau = rawTau;
  let selectedFamilyEnergy = rawSupport.totalEnergy;
  const competitors: number[] = [rawConfidence];

  const raisedMultiple = raisedFamilyMultiple(rawSupport);
  if (
    raisedMultiple >= 2
    && raisedMultiple <= MAXIMUM_HARMONIC_FAMILY_MULTIPLE
  ) {
    const raisedTau = localYinMinimum(
      yin,
      rawTau / raisedMultiple,
      Math.max(2, raisedMultiple),
      minimumTau,
      maximumTau,
    );
    const raisedFrequency = sampleRate / raisedTau;
    const raisedYin = yin[raisedTau];
    const raisedConfidence = Math.min(
      clampUnit(1 - raisedYin),
      recentPeriodConfidence(samples, raisedTau, currentEdgeSpanSamples),
    );
    const maximumRaisedYin = raisedMultiple === 2
      ? yin[rawTau] + MAXIMUM_FAMILY_YIN_REGRESSION
      : Math.min(
        MAXIMUM_FAMILY_YIN_VALUE,
        yin[rawTau] + MAXIMUM_FAMILY_YIN_REGRESSION,
      );
    if (
      raisedFrequency >= minimumFrequency
      && raisedFrequency <= maximumFrequency
      // This branch removes a longer-period YIN alias already admitted by the
      // detector. Its comparison is relative: an absolute clean-signal gate
      // would preserve the wrong octave specifically as noise rises.
      && raisedYin <= maximumRaisedYin
      && raisedConfidence > 0
    ) {
      selectedTau = raisedTau;
      competitors.push(raisedConfidence);
    }
  }

  if (selectedTau === rawTau) {
    for (
      let multiple = 2;
      multiple <= MAXIMUM_HARMONIC_FAMILY_MULTIPLE;
      multiple += 1
    ) {
      const expectedTau = rawTau * multiple;
      if (
        expectedTau > maximumTau
        || sampleRate / expectedTau < minimumFrequency
      ) break;
      const candidateTau = localYinMinimum(
        yin,
        expectedTau,
        Math.max(2, multiple),
        minimumTau,
        maximumTau,
      );
      const candidateYin = yin[candidateTau];
      if (
        candidateYin > Math.min(
          MAXIMUM_FAMILY_YIN_VALUE,
          yin[rawTau] + MAXIMUM_FAMILY_YIN_REGRESSION,
        )
      ) continue;

      const support = harmonicSupport(
        samples,
        sampleRate,
        sampleRate / candidateTau,
        currentEdgeSpanSamples,
        workspace,
        multiple,
      );
      const primitiveFamily = support.supportedIndices.length >= MINIMUM_FAMILY_PARTIALS
        && support.supportedIndices[0] === 1
        && support.greatestCommonDivisor === 1
        && support.nonDominantRatio >= MINIMUM_NON_DOMINANT_RATIO
        // A proposed lower F0 must explain measured partial energy outside the
        // higher raw candidate's integer grid. One incidental broadband bin at
        // the proposed subharmonic is not enough to invent an octave below a
        // stable voice.
        && support.primitiveOffGridRatio >= MINIMUM_PRIMITIVE_OFF_GRID_RATIO;
      if (!primitiveFamily) continue;

      const candidateConfidence = Math.min(
        clampUnit(1 - candidateYin),
        recentPeriodConfidence(samples, candidateTau, currentEdgeSpanSamples),
      );
      competitors.push(candidateConfidence);
      // The longest repeating period is not necessarily a physical F0. Prefer
      // the primitive grid that materially explains more spectral energy.
      if (
        support.totalEnergy
          > selectedFamilyEnergy * MINIMUM_FAMILY_ENERGY_ADVANTAGE
      ) {
        selectedTau = candidateTau;
        selectedFamilyEnergy = support.totalEnergy;
      }
    }
  }

  if (selectedTau === rawTau || competitors.length < 2) {
    return { selectedTau, ambiguity: 0 };
  }
  const selectedConfidence = Math.min(
    clampUnit(1 - yin[selectedTau]),
    recentPeriodConfidence(samples, selectedTau, currentEdgeSpanSamples),
  );
  let runnerUpConfidence = 0;
  for (const confidence of competitors) {
    if (confidence === selectedConfidence) continue;
    runnerUpConfidence = Math.max(runnerUpConfidence, confidence);
  }
  const margin = Math.max(0, selectedConfidence - runnerUpConfidence);
  return {
    selectedTau,
    ambiguity: 1 - clampUnit(margin / UNAMBIGUOUS_FAMILY_MARGIN),
  };
}
