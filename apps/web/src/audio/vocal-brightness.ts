import type { YinPitchFrame } from "@noteforge/pitch-engine";

/**
 * Per-window spectral-shape evidence derived from the same PCM as pitch.
 *
 * `brightness` is an energy-weighted log-harmonic centroid. Zero places all
 * measured harmonic energy at the fundamental; one places it at the highest
 * measured partial. Harmonic number, rather than raw Hz, is the coordinate so
 * transposing an otherwise identical harmonic envelope does not itself become
 * a brightness gesture.
 */
export interface VocalBrightnessTelemetry {
  readonly brightness: number | null;
  readonly brightnessConfidence: number;
}

const MAXIMUM_HARMONIC = 16;
const MINIMUM_HARMONICS = 4;
const NYQUIST_MARGIN = 0.9;
const EMPTY_BRIGHTNESS = Object.freeze({
  brightness: null,
  brightnessConfidence: 0,
}) satisfies Readonly<VocalBrightnessTelemetry>;

let cachedHannWindow = new Float64Array(0);

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function hannWindow(length: number): Float64Array {
  if (cachedHannWindow.length === length) return cachedHannWindow;
  const window = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
  }
  cachedHannWindow = window;
  return window;
}

/** Hann-windowed magnitude at one exact harmonic frequency. */
function sinusoidalMagnitude(
  samples: Float32Array,
  sampleRate: number,
  frequencyHz: number,
  window: Float64Array,
): number {
  let real = 0;
  let imaginary = 0;
  let weightSum = 0;
  const angularStep = 2 * Math.PI * frequencyHz / sampleRate;
  const oscillatorCosine = Math.cos(angularStep);
  const oscillatorSine = Math.sin(angularStep);
  let phaseCosine = 1;
  let phaseSine = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const weight = window[index]!;
    const weighted = samples[index]! * weight;
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
 * Derive one amplitude-independent brightness coordinate from voiced evidence.
 *
 * Confidence describes how much of the window energy is explained by the
 * measured harmonic family, combined with pitch confidence and available
 * spectral coverage. It deliberately falls for noisy/aperiodic evidence; RMS
 * never acts as an admission threshold.
 */
export function deriveVocalBrightness(
  samples: Float32Array,
  sampleRate: number,
  pitch: Readonly<Pick<YinPitchFrame, "voiced" | "frequencyHz" | "confidence" | "rms">>,
): Readonly<VocalBrightnessTelemetry> {
  const frequencyHz = pitch.frequencyHz;
  if (
    !pitch.voiced
    || frequencyHz === null
    || !Number.isFinite(frequencyHz)
    || frequencyHz <= 0
    || !Number.isFinite(sampleRate)
    || sampleRate <= 0
    || samples.length < 8
    || !Number.isFinite(pitch.rms)
    || pitch.rms <= 0
    || !Number.isFinite(pitch.confidence)
  ) {
    return EMPTY_BRIGHTNESS;
  }

  const maximumRepresentableFrequency = sampleRate * 0.5 * NYQUIST_MARGIN;
  const harmonicCount = Math.min(
    MAXIMUM_HARMONIC,
    Math.floor(maximumRepresentableFrequency / frequencyHz),
  );
  if (harmonicCount < MINIMUM_HARMONICS) return EMPTY_BRIGHTNESS;

  const window = hannWindow(samples.length);
  const coordinateScale = Math.log2(MAXIMUM_HARMONIC);
  let harmonicEnergy = 0;
  let weightedHarmonicEnergy = 0;
  for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
    const magnitude = sinusoidalMagnitude(
      samples,
      sampleRate,
      frequencyHz * harmonic,
      window,
    );
    const energy = magnitude * magnitude;
    harmonicEnergy += energy;
    weightedHarmonicEnergy += energy * Math.log2(harmonic) / coordinateScale;
  }

  const windowEnergy = 2 * pitch.rms * pitch.rms;
  if (
    !Number.isFinite(harmonicEnergy)
    || harmonicEnergy <= windowEnergy * 1e-12
    || !Number.isFinite(weightedHarmonicEnergy)
  ) {
    return EMPTY_BRIGHTNESS;
  }

  const harmonicCoherence = clampUnit(harmonicEnergy / windowEnergy);
  const spectralCoverage = harmonicCount / MAXIMUM_HARMONIC;
  return Object.freeze({
    brightness: clampUnit(weightedHarmonicEnergy / harmonicEnergy),
    brightnessConfidence: clampUnit(pitch.confidence)
      * Math.sqrt(harmonicCoherence * spectralCoverage),
  });
}

