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

function requireFiniteResult(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} is outside the finite numeric range`);
  }
  return value;
}

function requirePositiveResult(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} is outside the finite positive numeric range`);
  }
  return value;
}

/** Normalize an integer or fractional pitch class into [0, 12). */
export function normalizePitchClass(pitchClass: number): number {
  requireFinite(pitchClass, 'pitchClass');
  if (Math.abs(pitchClass) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('pitchClass is outside the safely representable coordinate range');
  }
  return ((pitchClass % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
}

/** Convert hertz to a continuous MIDI coordinate without snapping to a note. */
export function frequencyToMidi(
  frequencyHz: number,
  referenceFrequencyHz = DEFAULT_REFERENCE_FREQUENCY_HZ,
): number {
  requirePositive(frequencyHz, 'frequencyHz');
  requirePositive(referenceFrequencyHz, 'referenceFrequencyHz');
  return requireFiniteResult(
    A4_MIDI + SEMITONES_PER_OCTAVE *
      (Math.log2(frequencyHz) - Math.log2(referenceFrequencyHz)),
    'MIDI result',
  );
}

/** Convert an integer or fractional MIDI coordinate to hertz. */
export function midiToFrequency(
  midi: number,
  referenceFrequencyHz = DEFAULT_REFERENCE_FREQUENCY_HZ,
): number {
  requireFinite(midi, 'midi');
  requirePositive(referenceFrequencyHz, 'referenceFrequencyHz');
  return requirePositiveResult(
    referenceFrequencyHz * 2 ** ((midi - A4_MIDI) / SEMITONES_PER_OCTAVE),
    'Frequency result',
  );
}

/** Signed cents from one frequency to another. Positive values move upward. */
export function centsBetweenFrequencies(fromHz: number, toHz: number): number {
  requirePositive(fromHz, 'fromHz');
  requirePositive(toHz, 'toHz');
  return requireFiniteResult(
    CENTS_PER_OCTAVE * (Math.log2(toHz) - Math.log2(fromHz)),
    'Cents result',
  );
}

/** Signed cents between two continuous MIDI coordinates. */
export function centsBetweenMidi(fromMidi: number, toMidi: number): number {
  requireFinite(fromMidi, 'fromMidi');
  requireFinite(toMidi, 'toMidi');
  return requireFiniteResult((toMidi - fromMidi) * CENTS_PER_SEMITONE, 'Cents result');
}

/** Transpose a frequency by a continuous number of cents. */
export function transposeFrequency(frequencyHz: number, cents: number): number {
  requirePositive(frequencyHz, 'frequencyHz');
  requireFinite(cents, 'cents');
  return requirePositiveResult(
    frequencyHz * 2 ** (cents / CENTS_PER_OCTAVE),
    'Transposed frequency',
  );
}

/** Transpose a MIDI coordinate by a continuous number of cents. */
export function transposeMidi(midi: number, cents: number): number {
  requireFinite(midi, 'midi');
  requireFinite(cents, 'cents');
  return requireFiniteResult(midi + cents / CENTS_PER_SEMITONE, 'Transposed MIDI');
}

/**
 * Split a continuous MIDI coordinate into its closest note and residual cents.
 * The raw midiFloat is retained so callers never have to reconstruct it.
 */
export function splitMidiPitch(midiFloat: number): SplitMidiPitch {
  requireFinite(midiFloat, 'midiFloat');

  // Splitting the integer and fractional parts avoids overflowing the safe
  // integer boundary through `midiFloat + 0.5`. Ties still resolve upward, so
  // negative half steps are symmetric and the cents range stays half-open.
  const lowerMidi = Math.floor(midiFloat);
  const roundedMidi = midiFloat - lowerMidi < 0.5 ? lowerMidi : lowerMidi + 1;
  if (!Number.isSafeInteger(roundedMidi)) {
    throw new RangeError('nearest MIDI is outside the safe-integer range');
  }
  const nearestMidi = Object.is(roundedMidi, -0) ? 0 : roundedMidi;
  const centsFromNearest = (midiFloat - nearestMidi) * CENTS_PER_SEMITONE;

  return {
    midiFloat,
    nearestMidi,
    centsFromNearest: Object.is(centsFromNearest, -0) ? 0 : centsFromNearest,
    pitchClass: normalizePitchClass(nearestMidi),
    octave: Math.floor(nearestMidi / SEMITONES_PER_OCTAVE) - 1,
  };
}
