export interface Harmonic {
  /** Integer or fractional multiple of the instantaneous fundamental. */
  multiple: number;
  /** Amplitude relative to the fundamental. */
  amplitude: number;
  phaseRadians?: number;
}

export interface SyntheticSignalOptions {
  sampleRate: number;
  durationSeconds: number;
  frequencyHz: number;
  amplitude?: number;
  /** Fundamental weight before optional harmonics. Defaults to one. */
  fundamentalAmplitude?: number;
  phaseRadians?: number;
  harmonics?: readonly Harmonic[];
  amplitudeEnvelope?: (timeSeconds: number, progress: number) => number;
  frequencyAtTime?: (timeSeconds: number, progress: number) => number;
  /** Peak amplitude of deterministic white noise mixed after the tone. */
  noiseAmplitude?: number;
  noiseSeed?: number;
}

export function frequencyAtCents(frequencyHz: number, cents: number): number {
  return frequencyHz * 2 ** (cents / 1_200);
}

export function midiFrequency(midi: number, a4Frequency = 440): number {
  return a4Frequency * 2 ** ((midi - 69) / 12);
}

/** Tiny seeded generator so fixture noise is identical on every runtime. */
function createNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 0xffff_ffff) * 2 - 1;
  };
}

export function generateSyntheticSignal(
  options: SyntheticSignalOptions,
): Float32Array {
  const sampleCount = Math.max(
    0,
    Math.floor(options.sampleRate * options.durationSeconds),
  );
  const result = new Float32Array(sampleCount);
  const amplitude = options.amplitude ?? 0.5;
  const phaseOffset = options.phaseRadians ?? 0;
  const harmonics = options.harmonics ?? [];
  const noiseAmplitude = options.noiseAmplitude ?? 0;
  const noise = createNoise(options.noiseSeed ?? 0x4e_46_47_45);
  let phase = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const timeSeconds = index / options.sampleRate;
    const progress = sampleCount <= 1 ? 0 : index / (sampleCount - 1);
    const instantaneousFrequency =
      options.frequencyAtTime?.(timeSeconds, progress) ?? options.frequencyHz;
    const envelope = options.amplitudeEnvelope?.(timeSeconds, progress) ?? 1;

    let periodic = (options.fundamentalAmplitude ?? 1) *
      Math.sin(phase + phaseOffset);
    for (const harmonic of harmonics) {
      periodic += harmonic.amplitude *
        Math.sin(
          harmonic.multiple * phase +
            (harmonic.phaseRadians ?? phaseOffset),
        );
    }

    result[index] = amplitude * envelope * periodic + noiseAmplitude * noise();
    phase += (2 * Math.PI * instantaneousFrequency) / options.sampleRate;
  }

  return result;
}

export function linearFadeEnvelope(
  startGain: number,
  endGain: number,
): (_timeSeconds: number, progress: number) => number {
  return (_timeSeconds, progress) =>
    startGain + (endGain - startGain) * progress;
}

export function centsError(actualHz: number, expectedHz: number): number {
  return 1_200 * Math.log2(actualHz / expectedHz);
}
