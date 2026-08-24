import {
  midiToFrequency,
  normalizePitchClass,
  splitMidiPitch,
  type SplitMidiPitch,
} from './pitch';

export type AccidentalPreference = 'sharp' | 'flat';
export type NoteLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface MidiToNoteOptions {
  accidentalPreference?: AccidentalPreference;
  /** Include a signed cents suffix for fractional MIDI values. Defaults to true. */
  includeCents?: boolean;
  centsPrecision?: number;
}

export interface ParsedNote {
  source: string;
  letter: NoteLetter;
  /** Unicode-normalized accidental spelling, such as "♯" or "♭♭". */
  accidental: string;
  accidentalOffset: number;
  pitchClass: number;
  octave: number | null;
  /** Continuous MIDI coordinate, or null when no octave was supplied. */
  midi: number | null;
  centsOffset: number;
  /** Canonicalized spelling that preserves the user's enharmonic choice. */
  name: string;
}

export interface MidiPitchDescription extends SplitMidiPitch {
  name: string;
  pitchClassName: string;
  frequencyHz: number;
}

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

export const NOTE_LETTERS = Object.freeze(['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const);

const NATURAL_PITCH_CLASS: Record<NoteLetter, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const NOTE_PATTERN = /^\s*([A-Ga-g])\s*((?:[#♯b♭x]|𝄪|𝄫){0,2})\s*(-?\d+)?(?:\s*([+-])\s*(\d+(?:\.\d+)?)\s*(?:c|¢|cents?))?\s*$/i;

function requireInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
}

function accidentalOffset(accidental: string): number {
  let offset = 0;
  for (const symbol of accidental) {
    if (symbol === '#' || symbol === '♯') {
      offset += 1;
    } else if (symbol === 'b' || symbol === '♭') {
      offset -= 1;
    } else if (symbol.toLowerCase() === 'x' || symbol === '𝄪') {
      offset += 2;
    } else if (symbol === '𝄫') {
      offset -= 2;
    }
  }
  return offset;
}

function normalizeAccidental(accidental: string): string {
  return accidental
    .replaceAll('#', '♯')
    .replaceAll('b', '♭')
    .replaceAll(/x/gi, '𝄪');
}

/** Return a display name for an integer pitch class. */
export function noteName(
  pitchClass: number,
  accidentalPreference: AccidentalPreference = 'sharp',
): string {
  if (!Number.isFinite(pitchClass)) {
    throw new RangeError('pitchClass must be a finite number');
  }
  requireInteger(pitchClass, 'pitchClass');
  const normalized = normalizePitchClass(pitchClass);
  return accidentalPreference === 'flat' ? FLAT_NAMES[normalized] : SHARP_NAMES[normalized];
}

/**
 * Spell a pitch class using a required note letter. This is useful when scale
 * and chord construction must retain diatonic spelling (for example E♯ in C♯ major).
 */
export function spellPitchClass(pitchClass: number, letter: NoteLetter): string {
  if (!Number.isSafeInteger(pitchClass)) {
    throw new RangeError('pitchClass must be a safe integer');
  }
  let offset = normalizePitchClass(pitchClass - NATURAL_PITCH_CLASS[letter]);
  if (offset > 6) offset -= 12;
  const accidental = offset === 0
    ? ''
    : offset === 1
      ? '♯'
      : offset === 2
        ? '𝄪'
        : offset === -1
          ? '♭'
          : offset === -2
            ? '𝄫'
            : offset > 0
              ? '♯'.repeat(offset)
              : '♭'.repeat(-offset);
  return `${letter}${accidental}`;
}

/** Move through note letters, independently of chromatic pitch. */
export function transposeNoteLetter(letter: NoteLetter, diatonicSteps: number): NoteLetter {
  if (!Number.isSafeInteger(diatonicSteps)) {
    throw new RangeError('diatonicSteps must be a safe integer');
  }
  const start = NOTE_LETTERS.indexOf(letter);
  const index = ((start + diatonicSteps) % NOTE_LETTERS.length + NOTE_LETTERS.length) % NOTE_LETTERS.length;
  return NOTE_LETTERS[index];
}

/** Parse note spellings such as C#4, D♭3, Fx5, B♭, or A4 -12.5c. */
export function parseNote(source: string): ParsedNote {
  if (typeof source !== 'string') {
    throw new TypeError('source must be a string');
  }
  const match = NOTE_PATTERN.exec(source);
  if (!match) {
    throw new SyntaxError(`Invalid note: "${source}"`);
  }

  const letter = match[1].toUpperCase() as NoteLetter;
  const rawAccidental = match[2] ?? '';
  const offset = accidentalOffset(rawAccidental);
  const octave = match[3] === undefined ? null : Number.parseInt(match[3], 10);
  const centsMagnitude = match[5] === undefined ? 0 : Number.parseFloat(match[5]);
  if (octave !== null && !Number.isSafeInteger(octave)) {
    throw new RangeError('Note octave must be a safe integer');
  }
  if (!Number.isFinite(centsMagnitude)) {
    throw new RangeError('Note cents offset must be finite');
  }
  const centsOffset = match[4] === '-' ? -centsMagnitude : centsMagnitude;
  const natural = NATURAL_PITCH_CLASS[letter];
  const chromaticIndex = natural + offset;
  const pitchClass = normalizePitchClass(chromaticIndex);
  const midi = octave === null
    ? null
    : (octave + 1) * 12 + chromaticIndex + centsOffset / 100;
  if (midi !== null && !Number.isFinite(midi)) {
    throw new RangeError('Parsed MIDI coordinate must be finite');
  }
  if (midi !== null) splitMidiPitch(midi);
  const accidental = normalizeAccidental(rawAccidental);

  return {
    source,
    letter,
    accidental,
    accidentalOffset: offset,
    pitchClass,
    octave,
    midi,
    centsOffset,
    name: `${letter}${accidental}${octave ?? ''}`,
  };
}

/** Resolve a pitch-class number or note spelling (with or without octave). */
export function resolvePitchClass(value: number | string): number {
  if (typeof value === 'number') {
    requireInteger(value, 'pitchClass');
    return normalizePitchClass(value);
  }
  return parseNote(value).pitchClass;
}

/** Convert a note with an explicit octave to a continuous MIDI coordinate. */
export function noteToMidi(note: string): number {
  const parsed = parseNote(note);
  if (parsed.midi === null) {
    throw new SyntaxError(`Note "${note}" must include an octave`);
  }
  return parsed.midi;
}

function formatCents(cents: number, precision: number): string {
  const rounded = Number(cents.toFixed(precision));
  if (rounded === 0) {
    return '';
  }
  return ` ${rounded > 0 ? '+' : ''}${rounded}¢`;
}

/**
 * Name a continuous MIDI coordinate. Fractional values retain their displacement
 * as a cents suffix unless includeCents is explicitly disabled.
 */
export function midiToNote(midiFloat: number, options: MidiToNoteOptions = {}): string {
  const {
    accidentalPreference = 'sharp',
    includeCents = true,
    centsPrecision = 1,
  } = options;
  if (!Number.isInteger(centsPrecision) || centsPrecision < 0 || centsPrecision > 6) {
    throw new RangeError('centsPrecision must be an integer from 0 through 6');
  }

  const split = splitMidiPitch(midiFloat);
  const baseName = `${noteName(split.pitchClass, accidentalPreference)}${split.octave}`;
  return includeCents ? baseName + formatCents(split.centsFromNearest, centsPrecision) : baseName;
}

/** Full named representation of a continuous MIDI coordinate. */
export function describeMidiPitch(
  midiFloat: number,
  accidentalPreference: AccidentalPreference = 'sharp',
): MidiPitchDescription {
  const split = splitMidiPitch(midiFloat);
  return {
    ...split,
    name: midiToNote(midiFloat, { accidentalPreference }),
    pitchClassName: noteName(split.pitchClass, accidentalPreference),
    frequencyHz: midiToFrequency(midiFloat),
  };
}
