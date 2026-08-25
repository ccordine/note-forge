/**
 * Anti-aliased normalization of high-rate capture windows.
 *
 * Web Audio commonly exposes 88.2/96/176.4/192 kHz capture. Pitch analysis
 * does not need that bandwidth, but dropping samples without a real low-pass
 * filter folds ultrasonic/high-frequency energy into the vocal detector band.
 * This per-engine cascade halves the rate until it is at most 48 kHz. Every
 * stage uses the same steep linear-phase half-band FIR and private reusable
 * scratch, so steady capture allocates nothing.
 */

const MAXIMUM_ANALYSIS_SAMPLE_RATE = 48_000;
const HALF_BAND_TAP_COUNT = 129;
const HALF_BAND_CENTER = (HALF_BAND_TAP_COUNT - 1) / 2;
const KAISER_BETA = 16;
// A finite Float32 FIR leaves scale-invariant numerical residue even after
// >150 dB stop-band rejection. YIN is intentionally willing to analyze an
// arbitrarily quiet real input, so that residue must not become a new pitch.
// This relative (never absolute) floor is below Float32's useful mixed-signal
// precision while retaining a -126 dBFS vocal component under full-scale
// out-of-band interference.
const FLOAT32_ALIAS_RESIDUE_AMPLITUDE_RATIO = 1e-7;

interface HalfBandKernel {
  readonly taps: Int16Array;
  readonly weights: Float64Array;
}

function modifiedBesselZero(value: number): number {
  const quarterSquared = value * value / 4;
  let term = 1;
  let sum = 1;
  for (let order = 1; order <= 64; order += 1) {
    term *= quarterSquared / (order * order);
    sum += term;
    if (term <= sum * Number.EPSILON) break;
  }
  return sum;
}

function createHalfBandKernel(): HalfBandKernel {
  const denominator = modifiedBesselZero(KAISER_BETA);
  const taps: number[] = [];
  const unnormalized: number[] = [];
  let sum = 0;
  for (let tap = 0; tap < HALF_BAND_TAP_COUNT; tap += 1) {
    const offset = tap - HALF_BAND_CENTER;
    // sinc(offset / 2) is exactly zero at every non-center even offset.
    if (offset !== 0 && offset % 2 === 0) continue;
    const ideal = offset === 0
      ? 0.5
      : Math.sin(Math.PI * offset / 2) / (Math.PI * offset);
    const position = offset / HALF_BAND_CENTER;
    const window = modifiedBesselZero(
      KAISER_BETA * Math.sqrt(Math.max(0, 1 - position * position)),
    ) / denominator;
    const weight = ideal * window;
    taps.push(tap);
    unnormalized.push(weight);
    sum += weight;
  }
  const weights = Float64Array.from(unnormalized, (weight) => weight / sum);
  return Object.freeze({
    taps: Int16Array.from(taps),
    weights,
  });
}

const HALF_BAND_KERNEL = createHalfBandKernel();

function halveWithAntiAliasing(
  source: Float32Array,
  output: Float32Array,
  sourceWarmupSamples: number,
): number {
  const { taps, weights } = HALF_BAND_KERNEL;
  const outputWarmupSamples = Math.ceil(
    (sourceWarmupSamples + HALF_BAND_TAP_COUNT - 2) / 2,
  );
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    if (outputIndex < outputWarmupSamples) {
      output[outputIndex] = 0;
      continue;
    }
    // A causal odd-phase decimator includes the newest source sample at the
    // right edge. Initial samples without complete FIR history are explicitly
    // excluded above instead of inventing reflected/zero-pad edge content.
    const newestSourceIndex = outputIndex * 2 + 1;
    let sum = 0;
    for (let coefficient = 0; coefficient < weights.length; coefficient += 1) {
      const sourceIndex = newestSourceIndex - taps[coefficient]!;
      sum += source[sourceIndex]! * weights[coefficient]!;
    }
    output[outputIndex] = sum;
  }
  return outputWarmupSamples;
}

function sumOfSquares(samples: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    sum += sample * sample;
  }
  return sum;
}

export interface NormalizedAnalysisWindow {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

interface StageWorkspace {
  storage: Float32Array;
  view: Float32Array;
}

/** Per-NoteInputEngine scratch. Returned storage remains owned by this object. */
export class AnalysisWindowNormalizer {
  private readonly stages: StageWorkspace[] = [];
  private normalized: Readonly<NormalizedAnalysisWindow> | null = null;

  private stageOutput(stage: number, length: number): Float32Array {
    let workspace = this.stages[stage];
    if (workspace === undefined) {
      const storage = new Float32Array(length);
      workspace = { storage, view: storage };
      this.stages.push(workspace);
      return workspace.view;
    }
    if (workspace.storage.length < length) {
      workspace.storage = new Float32Array(length);
      workspace.view = workspace.storage;
    } else if (workspace.view.length !== length) {
      workspace.view = workspace.storage.subarray(0, length);
    }
    return workspace.view;
  }

  normalize(
    window: Readonly<NormalizedAnalysisWindow>,
  ): Readonly<NormalizedAnalysisWindow> {
    if (window.sampleRate <= MAXIMUM_ANALYSIS_SAMPLE_RATE) return window;

    const sourceEnergy = sumOfSquares(window.samples);
    let stageCount = 0;
    let analysisSampleRate = window.sampleRate;
    while (analysisSampleRate > MAXIMUM_ANALYSIS_SAMPLE_RATE) {
      analysisSampleRate /= 2;
      stageCount += 1;
    }

    let source = window.samples;
    let warmupSamples = 0;
    for (let stage = 0; stage < stageCount; stage += 1) {
      const outputLength = Math.floor(source.length / 2);
      const output = this.stageOutput(stage, outputLength);
      warmupSamples = halveWithAntiAliasing(source, output, warmupSamples);
      source = output;
    }

    const retainedEnergy = sumOfSquares(source);
    const minimumRetainedEnergy = sourceEnergy
      * FLOAT32_ALIAS_RESIDUE_AMPLITUDE_RATIO
      * FLOAT32_ALIAS_RESIDUE_AMPLITUDE_RATIO
      * source.length / window.samples.length;
    if (
      Number.isFinite(sourceEnergy)
      && Number.isFinite(retainedEnergy)
      && retainedEnergy <= minimumRetainedEnergy
    ) {
      source.fill(0);
    }

    if (
      this.normalized === null
      || this.normalized.samples !== source
      || !Object.is(this.normalized.sampleRate, analysisSampleRate)
    ) {
      this.normalized = Object.freeze({ samples: source, sampleRate: analysisSampleRate });
    }
    return this.normalized;
  }
}
