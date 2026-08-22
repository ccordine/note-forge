/** Equal-tempered pitch math. All MIDI values may be fractional. */

export const A4_MIDI = 69;
export const DEFAULT_REFERENCE_FREQUENCY_HZ = 440;
export const SEMITONES_PER_OCTAVE = 12;
export const CENTS_PER_SEMITONE = 100;
export const CENTS_PER_OCTAVE = SEMITONES_PER_OCTAVE * CENTS_PER_SEMITONE;

export interface SplitMidiPitch {
  /** The original, continuous MIDI coordinate. */
  midiFloat: number;
  /** The closest equal-tempered MIDI note. */
  nearestMidi: number;
  /** Signed displacement from nearestMidi, conventionally in [-50, 50). */
  centsFromNearest: number;
  pitchClass: number;
  octave: number;
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }
}

/** Normalize an integer or fractional pitch class into [0, 12). */
export function normalizePitchClass(pitchClass: number): number {
  requireFinite(pitchClass, 'pitchClass');
  return ((pitchClass % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
}

/** Convert hertz to a continuous MIDI coordinate without snapping to a note. */
export function frequencyToMidi(
  frequencyHz: number,
  referenceFrequencyHz = DEFAULT_REFERENCE_FREQUENCY_HZ,
): number {
  requirePositive(frequencyHz, 'frequencyHz');
  requirePositive(referenceFrequencyHz, 'referenceFrequencyHz');
  return A4_MIDI + SEMITONES_PER_OCTAVE * Math.log2(frequencyHz / referenceFrequencyHz);
}

/** Convert an integer or fractional MIDI coordinate to hertz. */
export function midiToFrequency(
  midi: number,
  referenceFrequencyHz = DEFAULT_REFERENCE_FREQUENCY_HZ,
): number {
  requireFinite(midi, 'midi');
  requirePositive(referenceFrequencyHz, 'referenceFrequencyHz');
  return referenceFrequencyHz * 2 ** ((midi - A4_MIDI) / SEMITONES_PER_OCTAVE);
}

/** Signed cents from one frequency to another. Positive values move upward. */
export function centsBetweenFrequencies(fromHz: number, toHz: number): number {
  requirePositive(fromHz, 'fromHz');
  requirePositive(toHz, 'toHz');
  return CENTS_PER_OCTAVE * Math.log2(toHz / fromHz);
}

/** Signed cents between two continuous MIDI coordinates. */
export function centsBetweenMidi(fromMidi: number, toMidi: number): number {
  requireFinite(fromMidi, 'fromMidi');
  requireFinite(toMidi, 'toMidi');
  return (toMidi - fromMidi) * CENTS_PER_SEMITONE;
}

/** Transpose a frequency by a continuous number of cents. */
export function transposeFrequency(frequencyHz: number, cents: number): number {
  requirePositive(frequencyHz, 'frequencyHz');
  requireFinite(cents, 'cents');
  return frequencyHz * 2 ** (cents / CENTS_PER_OCTAVE);
}

/** Transpose a MIDI coordinate by a continuous number of cents. */
export function transposeMidi(midi: number, cents: number): number {
  requireFinite(midi, 'midi');
  requireFinite(cents, 'cents');
  return midi + cents / CENTS_PER_SEMITONE;
}

/**
 * Split a continuous MIDI coordinate into its closest note and residual cents.
 * The raw midiFloat is retained so callers never have to reconstruct it.
 */
export function splitMidiPitch(midiFloat: number): SplitMidiPitch {
  requireFinite(midiFloat, 'midiFloat');

  // floor(x + .5), rather than Math.round(x), makes negative half steps
  // symmetric and keeps the cents range half-open at the upper edge.
  const nearestMidi = Math.floor(midiFloat + 0.5);
  const centsFromNearest = (midiFloat - nearestMidi) * CENTS_PER_SEMITONE;

  return {
    midiFloat,
    nearestMidi,
    centsFromNearest: Object.is(centsFromNearest, -0) ? 0 : centsFromNearest,
    pitchClass: normalizePitchClass(nearestMidi),
    octave: Math.floor(nearestMidi / SEMITONES_PER_OCTAVE) - 1,
  };
}
